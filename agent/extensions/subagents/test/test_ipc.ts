import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
	encodeSubagentIpcFrame,
	IPC_MAX_FRAME_BYTES,
	parseSubagentIpcFrame,
	resolveSubagentSocketPath,
	SubagentIpcClient,
	SubagentIpcDisconnectedError,
	SubagentIpcFrameDecoder,
	SubagentIpcServer,
	type SubagentIpcMessageType,
	type SubagentIpcRequest,
} from "../ipc.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ipc-"));
const socketPath = resolveSubagentSocketPath("session-test", tempDir);
const logs: string[] = [];
const requests: SubagentIpcRequest[] = [];
const hellos: Array<{ owner: string; payload: unknown }> = [];
const disconnectedOwners: Array<string | undefined> = [];
let disconnectedOwner: string | undefined;
let resolveDisconnect: (() => void) | undefined;
const disconnected = new Promise<void>((resolve) => { resolveDisconnect = resolve; });
const server = new SubagentIpcServer({
	socketPath,
	logger: (event) => logs.push(event),
	onHello: (owner, payload) => { hellos.push({ owner, payload }); },
	onRequest: (request, connection) => {
		requests.push(request);
		if (request.type === "spawn" && (request.payload as { hang?: boolean })?.hang) return new Promise(() => undefined);
		if (request.type === "browser" && (request.payload as { probe?: string })?.probe === "correlation") {
			connection.respond(request, { ignored: true }, { requestId: "wrong-request-id" });
			connection.respond(request, { ignored: true }, { owner: "wrong-owner" });
			return { matched: true };
		}
		return request.payload;
	},
	onDisconnect: (owner) => {
		disconnectedOwners.push(owner);
		if (owner === "child-test") {
			disconnectedOwner = owner;
			resolveDisconnect?.();
		}
	},
});
const childToken = server.registerRun("child-test");
const ownerAToken = server.registerRun("owner-a");
server.registerRun("owner-b");
const revokedToken = server.registerRun("revoked-owner");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendHello(owner: string, token: string, requestId: string, type: SubagentIpcMessageType = "hello"): Promise<net.Socket> {
	const socket = net.createConnection(socketPath);
	socket.on("error", () => undefined);
	await once(socket, "connect");
	const frame: SubagentIpcRequest = { kind: "request", token, requestId, owner, type, payload: {} };
	socket.write(encodeSubagentIpcFrame(frame));
	return socket;
}

try {
	const frame = {
		kind: "request" as const,
		token: "token",
		requestId: "request-1",
		owner: "child-test",
		type: "browser" as const,
		payload: { tool: "browser_console" },
	};
	const encoded = encodeSubagentIpcFrame(frame);
	const decoder = new SubagentIpcFrameDecoder();
	assert.deepEqual(decoder.push(encoded.subarray(0, 2)), []);
	assert.deepEqual(decoder.push(encoded.subarray(2, 7)), []);
	assert.deepEqual(decoder.push(encoded.subarray(7)), [frame]);
	assert.ok(encoded.byteLength <= IPC_MAX_FRAME_BYTES + 4);
	assert.deepEqual(parseSubagentIpcFrame(frame), frame);
	for (const legacyType of ["message", "question", "result", "activity"]) {
		assert.equal(parseSubagentIpcFrame({ ...frame, type: legacyType }), undefined);
	}
	assert.equal(parseSubagentIpcFrame({ ...frame, token: "" }), undefined);
	assert.notEqual(childToken, ownerAToken);
	assert.throws(() => server.registerRun("child-test"), /already registered/);

	await server.listen();
	assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);

	const cancellingClient = SubagentIpcClient.create({ socketPath: path.join(tempDir, "not-listening.sock"), token: childToken, owner: "pending-connect", connectTimeoutMs: 5_000 });
	const pendingConnect = cancellingClient.request("browser");
	const pendingConnectRejected = assert.rejects(pendingConnect);
	await cancellingClient.close();
	await Promise.race([pendingConnectRejected, delay(250).then(() => { throw new Error("Closing a lazy IPC client did not cancel connect."); })]);

	const concurrentSocketPath = resolveSubagentSocketPath("c", tempDir);
	const concurrentServer = new SubagentIpcServer({ socketPath: concurrentSocketPath });
	try {
		await Promise.all(Array.from({ length: 4 }, () => concurrentServer.listen()));
		assert.equal(fs.existsSync(concurrentSocketPath), true);
	} finally {
		await concurrentServer.close();
	}

	const retrySocketPath = resolveSubagentSocketPath("r", tempDir);
	fs.writeFileSync(retrySocketPath, "not a socket");
	const retryServer = new SubagentIpcServer({ socketPath: retrySocketPath });
	try {
		await assert.rejects(retryServer.listen(), /IPC socket path is not a socket/);
		assert.equal(fs.existsSync(retrySocketPath), true);
		fs.unlinkSync(retrySocketPath);
		await retryServer.listen();
		await retryServer.close();
		await retryServer.listen();
	} finally {
		await retryServer.close();
	}
	assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

	const client = SubagentIpcClient.create({
		socketPath,
		token: childToken,
		owner: "child-test",
		logger: (event) => logs.push(event),
	});
	assert.equal(server.getConnection("child-test"), undefined);
	assert.deepEqual(await client.request("ownership", { lazy: true }), { lazy: true });
	assert.deepEqual(hellos, [{ owner: "child-test", payload: { pid: process.pid } }]);
	const duplicateClient = SubagentIpcClient.create({ socketPath, token: childToken, owner: "child-test" });
	await assert.rejects(duplicateClient.request("ownership"), /IPC connection closed|socket hang up/);
	await duplicateClient.close();
	assert.equal(hellos.length, 1);
	for (const type of ["ownership", "browser", "spawn"] as const) {
		const payload = { type };
		assert.deepEqual(await client.request(type, payload), payload);
	}
	assert.deepEqual(await client.request("spawn", { nested: true }, { noDeadline: true }), { nested: true });

	const unauthenticated = await sendHello("attacker", "wrong-token", "unauthenticated");
	await delay(25);
	assert.equal(requests.some((request) => request.owner === "attacker"), false);
	assert.ok(logs.includes("authentication_rejected"));
	unauthenticated.destroy();

	const ownerClaim = await sendHello("owner-b", ownerAToken, "claim-other-owner");
	await delay(25);
	assert.equal(server.getConnection("owner-b"), undefined);
	assert.equal(hellos.some((hello) => hello.owner === "owner-b"), false);
	ownerClaim.destroy();

	const invalidFirstFrame = await sendHello("child-test", childToken, "no-hello", "browser");
	await delay(25);
	assert.equal(requests.some((request) => request.requestId === "no-hello"), false);
	invalidFirstFrame.destroy();

	await server.revokeRun("revoked-owner");
	const revoked = await sendHello("revoked-owner", revokedToken, "revoked-token");
	await delay(25);
	assert.equal(hellos.some((hello) => hello.owner === "revoked-owner"), false);
	revoked.destroy();

	assert.deepEqual(await client.request("browser", { probe: "correlation" }), { matched: true });
	assert.ok(logs.includes("correlation_mismatch"));
	assert.ok(logs.includes("owner_mismatch_dropped"));
	await assert.rejects(client.request("browser", {}, { noDeadline: true }), /only for spawn requests/);
	await assert.rejects(client.request("spawn", { hang: true }, { timeoutMs: 25 }), /timed out after 25 milliseconds/);
	let noDeadlineSettled = false;
	const noDeadline = client.request("spawn", { hang: true }, { noDeadline: true });
	void noDeadline.then(() => { noDeadlineSettled = true; }, () => { noDeadlineSettled = true; });
	await delay(50);
	assert.equal(noDeadlineSettled, false);
	await client.close();
	await assert.rejects(noDeadline, (error: unknown) => error instanceof SubagentIpcDisconnectedError);

	await Promise.race([
		disconnected,
		delay(500).then(() => { throw new Error("Timed out waiting for IPC disconnect reap."); }),
	]);
	assert.equal(disconnectedOwner, "child-test");

	const lazyToken = server.registerRun("lazy-child");
	const lazy = SubagentIpcClient.create({ socketPath, token: lazyToken, owner: "lazy-child" });
	assert.equal(server.getConnection("lazy-child"), undefined);
	assert.equal(lazy.isClosed, false);
	const lazyPayload = { tool: "browser_goto" };
	assert.deepEqual(await lazy.request("browser", lazyPayload), lazyPayload);
	assert.ok(server.getConnection("lazy-child"));
	const pendingAtRevoke = lazy.request("spawn", { hang: true }, { noDeadline: true });
	const pendingAtRevokeRejected = assert.rejects(pendingAtRevoke, (error: unknown) => error instanceof SubagentIpcDisconnectedError);
	await delay(25);
	await server.revokeRun("lazy-child");
	await pendingAtRevokeRejected;
	assert.equal(server.getConnection("lazy-child"), undefined);
	const lazyHelloCount = hellos.filter((hello) => hello.owner === "lazy-child").length;
	const lateClient = await sendHello("lazy-child", lazyToken, "late-after-revoke");
	await delay(25);
	assert.equal(hellos.filter((hello) => hello.owner === "lazy-child").length, lazyHelloCount);
	lateClient.destroy();
	await lazy.close();
	assert.ok(disconnectedOwners.includes("lazy-child"));

	const idleSocket = net.createConnection(socketPath);
	idleSocket.on("error", () => undefined);
	await once(idleSocket, "connect");
	const idleSocketClosed = once(idleSocket, "close");
	await server.close();
	await idleSocketClosed;
	assert.equal(fs.existsSync(socketPath), false);
	console.log("subagent IPC tests passed");
} finally {
	await server.close().catch(() => undefined);
	fs.rmSync(tempDir, { recursive: true, force: true });
}
