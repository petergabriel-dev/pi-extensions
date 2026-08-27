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
	SubagentIpcFrameDecoder,
	SubagentIpcServer,
	type SubagentIpcRequest,
} from "../ipc.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ipc-"));
const socketPath = resolveSubagentSocketPath("session-test", tempDir);
const logs: string[] = [];
const requests: SubagentIpcRequest[] = [];
let disconnectedOwner: string | undefined;
let resolveDisconnect: (() => void) | undefined;
const disconnected = new Promise<void>((resolve) => { resolveDisconnect = resolve; });

const server = new SubagentIpcServer({
	socketPath,
	token: "token-for-test",
	logger: (event) => logs.push(event),
	onRequest: (request, connection) => {
		requests.push(request);
		if (request.type === "result" && (request.payload as { probe?: string })?.probe === "correlation") {
			connection.respond(request, { ignored: true }, { requestId: "wrong-request-id" });
			connection.respond(request, { ignored: true }, { owner: "wrong-owner" });
			return { matched: true };
		}
		return request.payload;
	},
	onDisconnect: (owner) => {
		if (owner === "child-test") {
			disconnectedOwner = owner;
			resolveDisconnect?.();
		}
	},
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
	const frame = {
		kind: "request" as const,
		token: "token",
		requestId: "request-1",
		owner: "child-test",
		type: "result" as const,
		payload: { text: "split safely" },
	};
	const encoded = encodeSubagentIpcFrame(frame);
	const decoder = new SubagentIpcFrameDecoder();
	assert.deepEqual(decoder.push(encoded.subarray(0, 2)), []);
	assert.deepEqual(decoder.push(encoded.subarray(2, 7)), []);
	assert.deepEqual(decoder.push(encoded.subarray(7)), [frame]);
	assert.ok(encoded.byteLength <= IPC_MAX_FRAME_BYTES + 4);
	assert.deepEqual(parseSubagentIpcFrame(frame), frame);
	assert.equal(parseSubagentIpcFrame({ ...frame, token: "" }), undefined);

	await server.listen();
	assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
	assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

	const client = await SubagentIpcClient.connect({
		socketPath,
		token: server.token,
		owner: "child-test",
		logger: (event) => logs.push(event),
	});
	for (const type of ["ownership", "browser", "message", "question", "result", "spawn"] as const) {
		const payload = { type };
		assert.deepEqual(await client.request(type, payload), payload);
	}

	const unauthenticated = net.createConnection(socketPath);
	unauthenticated.on("error", () => undefined);
	await once(unauthenticated, "connect");
	unauthenticated.write(encodeSubagentIpcFrame({ ...frame, token: "wrong-token", owner: "attacker" }));
	await delay(25);
	assert.equal(requests.some((request) => request.owner === "attacker"), false);
	assert.ok(logs.includes("unauthenticated_frame_dropped"));
	unauthenticated.destroy();

	assert.deepEqual(await client.request("result", { probe: "correlation" }), { matched: true });
	assert.ok(logs.filter((event) => event === "correlation_mismatch").length >= 2);

	await client.close();
	await Promise.race([
		disconnected,
		delay(500).then(() => { throw new Error("Timed out waiting for IPC disconnect reap."); }),
	]);
	assert.equal(disconnectedOwner, "child-test");

	await server.close();
	assert.equal(fs.existsSync(socketPath), false);
	console.log("subagent IPC tests passed");
} finally {
	await server.close().catch(() => undefined);
	fs.rmSync(tempDir, { recursive: true, force: true });
}
