#!/usr/bin/env node
/* Session namespace / sticky pairing tests. Zero Pi imports. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const client = require("./pi-bridge-mcp.js");

const HARNESS = { harness: "claude", id: "claude-session-1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

function presence(piSessionId, peers = [], heartbeatAt = new Date().toISOString()) {
	return {
		schemaVersion: 2,
		piSessionId,
		name: `name-${piSessionId}`,
		mode: "plan",
		pid: process.pid,
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		heartbeatAt,
		peers,
	};
}

function setupProject() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-sessions-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	return cwd;
}

function addSession(cwd, id, peers = [], heartbeatAt) {
	const paths = client.bridgePaths(cwd, id);
	for (const dir of [path.join(cwd, ".pi", "memory", "bridge"), paths.sessions, paths.namespace, paths.requests, paths.responses, paths.processed]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	}
	writeJson(paths.presence, presence(id, peers, heartbeatAt || new Date().toISOString()));
	return paths;
}

function startResponder(cwd) {
	const requests = [];
	const timer = setInterval(() => {
		for (const session of client.liveSessions(cwd)) {
			let names;
			try { names = fs.readdirSync(session.paths.requests); } catch { continue; }
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const file = path.join(session.paths.requests, name);
				let request;
				try { request = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
				requests.push({ piSessionId: session.id, request, mode: fs.statSync(file).mode & 0o777 });
				const current = JSON.parse(fs.readFileSync(session.paths.presence, "utf8"));
				if (request.type === "pair" || request.type === "unpair") {
					const currentPeers = current.peers.filter((peer) => peer.harness !== request.peer.harness || peer.id !== request.peer.id);
					if (request.type === "pair") currentPeers.push({ ...request.peer, pendingCount: 0 });
					current.peers = currentPeers;
					current.heartbeatAt = new Date().toISOString();
					writeJson(session.paths.presence, current);
				}
				writeJson(path.join(session.paths.responses, `${request.id}.json`), {
					id: request.id,
					ok: true,
					result: { piSessionId: session.id, type: request.type },
				});
				try { fs.unlinkSync(file); } catch {}
			}
		}
	}, 10);
	timer.unref();
	return { requests, stop: () => clearInterval(timer) };
}

function startMailboxResponder(cwd, initialMessages = [], failedAcks = 0) {
	const requests = [];
	let messages = initialMessages.map((message) => structuredClone(message));
	let remainingAckFailures = failedAcks;
	const timer = setInterval(() => {
		for (const session of client.liveSessions(cwd)) {
			let names;
			try { names = fs.readdirSync(session.paths.requests); } catch { continue; }
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const file = path.join(session.paths.requests, name);
				let request;
				try { request = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
				requests.push({ piSessionId: session.id, request, mode: fs.statSync(file).mode & 0o777 });
				let response;
				if (request.type === "send_message") {
					response = { id: request.id, ok: true, result: { requestId: request.id, messageId: request.id } };
				} else if (request.type === "read_messages") {
					response = { id: request.id, ok: true, result: { requestId: request.id, messages: messages.map((message) => structuredClone(message)) } };
				} else if (request.type === "ack_messages" && remainingAckFailures > 0) {
					remainingAckFailures--;
					response = { id: request.id, ok: false, error: { code: "ack_failed", message: "simulated ack failure" } };
				} else if (request.type === "ack_messages") {
					const ids = new Set(request.payload.ids);
					const before = messages.length;
					messages = messages.filter((message) => !ids.has(message.id));
					response = { id: request.id, ok: true, result: { requestId: request.id, acknowledged: before - messages.length } };
				} else {
					response = { id: request.id, ok: true, result: { piSessionId: session.id, type: request.type } };
				}
				writeJson(path.join(session.paths.responses, `${request.id}.json`), response);
				try { fs.unlinkSync(file); } catch {}
			}
		}
	}, 10);
	timer.unref();
	return { requests, stop: () => clearInterval(timer) };
}

async function waitFor(fn, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await sleep(10);
	}
	throw new Error("Timed out waiting for fake responder.");
}

async function test(name, fn, responderFactory = startResponder) {
	const cwd = setupProject();
	let responder;
	try {
		responder = responderFactory(cwd);
		await fn(cwd, responder);
		console.log(`PASS ${name}`);
	} finally {
		responder?.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

async function main() {
	const toolNames = client.tools.map((tool) => tool.name);
	assert.ok(toolNames.includes("list_sessions") && toolNames.includes("pair_session"), "session tools missing from MCP tool list");
	const resolved = client.resolveHarnessIdentity({ sessionId: "primary-id", claudeSessionId: "legacy-id" }, { CLAUDE_CODE_SESSION_ID: "env-id" });
	assert.deepEqual(resolved, { harness: "claude", id: "primary-id" });
	assert.throws(() => client.resolveHarnessIdentity({ sessionId: "valid-id", harness: "unknown" }, {}), /Harness kind is invalid/);
	assert.deepEqual(client.resolveHarnessIdentity({ claudeSessionId: "legacy-id" }, { CLAUDE_CODE_SESSION_ID: "env-id" }), { harness: "claude", id: "legacy-id" });
	assert.deepEqual(client.resolveHarnessIdentity({}, { CLAUDE_CODE_SESSION_ID: "env-id" }), { harness: "claude", id: "env-id" });
	assert.equal(client.resolveHarnessIdentity({}, {}), null);

	await test("session listing filters stale presence", async (cwd) => {
		addSession(cwd, "pi-live", [{ ...HARNESS, pendingCount: 2, inboundPendingCount: 1 }]);
		addSession(cwd, "pi-stale", [], new Date(Date.now() - 6_000).toISOString());
		addSession(cwd, "pi-invalid-peer", [{ harness: "unknown", id: "foreign" }]);
		addSession(cwd, "pi-too-many-peers", Array.from({ length: 11 }, (_, index) => ({ harness: "claude", id: `peer-${index}`, pendingCount: 0 })));
		const sessions = client.listSessions(cwd);
		assert.deepEqual(sessions.map((session) => session.id), ["pi-live"]);
		assert.equal(sessions[0].shortId, "pi-live");
		assert.equal(sessions[0].age, "1m");
		assert.equal(sessions[0].peers[0].pendingCount, 2);
		assert.equal(sessions[0].peers[0].inboundPendingCount, 1);
	});

	await test("single live session auto-pairs then routes request", async (cwd, responder) => {
		const paths = addSession(cwd, "pi-only");
		const result = await client.bridgeRequest("recall", { query: "auto" }, { cwd, identity: HARNESS });
		assert.equal(result.piSessionId, "pi-only");
		assert.equal(result.result.type, "recall");
		assert.deepEqual(JSON.parse(fs.readFileSync(paths.presence, "utf8")).peers.map(({ harness, id }) => ({ harness, id })), [HARNESS]);
		assert.deepEqual(responder.requests.map(({ request }) => request.type), ["pair", "recall"]);
		assert.ok(responder.requests.every(({ request, mode }) => request.peer.harness === HARNESS.harness && request.peer.id === HARNESS.id && mode === 0o600));
		for (const dir of [paths.namespace, paths.requests, paths.responses, paths.processed]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	});

	await test("symlinked memory path is rejected without writing outside namespace", async (cwd) => {
		const outside = path.join(cwd, "outside-memory");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(cwd, ".pi", "memory"), "dir");
		assert.deepEqual(client.listSessions(cwd), []);
		await assert.rejects(client.bridgeRequest("recall", {}, { cwd, identity: HARNESS }), (error) => error.message === client.BRIDGE_DOWN_MESSAGE);
		assert.deepEqual(fs.readdirSync(outside), []);
	});

	await test("legacy root mailbox is ignored and bridge-down text stays exact", async (cwd) => {
		const legacyRequests = path.join(cwd, ".pi", "memory", "bridge", "requests");
		fs.mkdirSync(legacyRequests, { recursive: true });
		await assert.rejects(client.bridgeRequest("recall", {}, { cwd, identity: HARNESS }), (error) => error.message === client.BRIDGE_DOWN_MESSAGE);
		assert.deepEqual(fs.readdirSync(legacyRequests), []);
	});

	await test("ambiguous sessions fail with choices and pair_session instruction", async (cwd, responder) => {
		addSession(cwd, "pi-one");
		addSession(cwd, "pi-two");
		const isAmbiguous = (error) => error.message.includes("pair_session") && error.message.includes("pi-one") && error.message.includes("pi-two") && error.message.includes("age");
		await assert.rejects(client.bridgeRequest("recall", {}, { cwd, identity: HARNESS }), isAmbiguous);
		await assert.rejects(client.bridgeRequest("recall", {}, { cwd, identity: null }), isAmbiguous);
		assert.equal(responder.requests.length, 0, "ambiguous route must not write request to any namespace");
	});

	await test("stale prior pairing re-resolves against current live sessions", async (cwd, responder) => {
		const stale = addSession(cwd, "pi-old", [{ ...HARNESS, pendingCount: 0 }], new Date(Date.now() - 6_000).toISOString());
		addSession(cwd, "pi-current");
		const result = await client.bridgeRequest("save_plan", { planText: "x" }, { cwd, identity: HARNESS });
		assert.equal(result.piSessionId, "pi-current");
		assert.ok(responder.requests.every(({ piSessionId }) => piSessionId === "pi-current"));
		assert.equal(fs.readdirSync(stale.requests).filter((name) => name.endsWith(".json")).length, 0);
	});

	await test("sticky pair routes exactly one namespace", async (cwd, responder) => {
		addSession(cwd, "pi-unpaired");
		addSession(cwd, "pi-paired", [{ ...HARNESS, pendingCount: 0 }]);
		const result = await client.bridgeRequest("capture", { notes: [] }, { cwd, identity: HARNESS });
		assert.equal(result.piSessionId, "pi-paired");
		assert.deepEqual(responder.requests.map(({ piSessionId, request }) => ({ piSessionId, type: request.type })), [{ piSessionId: "pi-paired", type: "capture" }]);
	});

	await test("pair_session moves sticky pair through bridge request files", async (cwd, responder) => {
		const previous = addSession(cwd, "pi-previous", [{ ...HARNESS, pendingCount: 0 }]);
		const target = addSession(cwd, "pi-target");
		const result = await client.pairSession("pi-target", { cwd, identity: HARNESS });
		assert.equal(result.piSessionId, "pi-target");
		assert.deepEqual(JSON.parse(fs.readFileSync(previous.presence, "utf8")).peers, []);
		assert.equal(JSON.parse(fs.readFileSync(target.presence, "utf8")).peers[0].id, HARNESS.id);
		assert.deepEqual(responder.requests.map(({ piSessionId, request }) => `${piSessionId}:${request.type}`), ["pi-previous:unpair", "pi-target:pair"]);
	});

	await test("message tools require harness identity", async (cwd) => {
		addSession(cwd, "pi-only");
		const previous = process.env.CLAUDE_CODE_SESSION_ID;
		delete process.env.CLAUDE_CODE_SESSION_ID;
		try {
			await assert.rejects(client.callTool("send_message", { text: "hello", cwd }), /Harness session id unavailable/);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
			else process.env.CLAUDE_CODE_SESSION_ID = previous;
		}
	});

	await test("paired send/read/ack use bridge requests", async (cwd, responder) => {
		addSession(cwd, "pi-mailbox", [{ ...HARNESS, pendingCount: 0 }]);
		const message = {
			id: "pi-message-1",
			from: { kind: "pi", id: "pi-mailbox" },
			to: { kind: HARNESS.harness, id: HARNESS.id },
			text: "untrusted advisory",
			sentAt: "2025-01-02T03:04:05.000Z",
		};
		const toolNames = client.tools.map((tool) => tool.name);
		assert.ok(toolNames.includes("send_message") && toolNames.includes("read_messages"), "message tools missing from MCP tool list");
		const sent = await client.callTool("send_message", { text: "from harness", sessionId: HARNESS.id, cwd });
		assert.equal(sent.structuredContent.result.messageId, sent.structuredContent.requestId);
		const read = await client.callTool("read_messages", { sessionId: HARNESS.id, cwd });
		assert.deepEqual(read.structuredContent.messages, [message]);
		assert.equal(read.structuredContent.acknowledged, 1);
		assert.deepEqual(responder.requests.map(({ request }) => request.type), ["send_message", "read_messages", "ack_messages"]);
		assert.deepEqual(responder.requests.map(({ request }) => request.peer), [HARNESS, HARNESS, HARNESS]);
		assert.deepEqual(responder.requests[0].request.payload, { text: "from harness" });
		assert.deepEqual(responder.requests[2].request.payload.ids, [message.id]);
	}, (cwd) => startMailboxResponder(cwd, [{
		id: "pi-message-1",
		from: { kind: "pi", id: "pi-mailbox" },
		to: { kind: HARNESS.harness, id: HARNESS.id },
		text: "untrusted advisory",
		sentAt: "2025-01-02T03:04:05.000Z",
	}]));

	await test("failed acknowledgement warns and redelivers same ids", async (cwd, responder) => {
		addSession(cwd, "pi-mailbox", [{ ...HARNESS, pendingCount: 0 }]);
		const first = await client.callTool("read_messages", { sessionId: HARNESS.id, cwd });
		const firstResult = first.structuredContent;
		assert.match(firstResult.warning, /Acknowledgement failed/);
		assert.equal(firstResult.messages.length, 1);
		const second = await client.callTool("read_messages", { sessionId: HARNESS.id, cwd });
		assert.deepEqual(second.structuredContent.messages, firstResult.messages, "unacked messages must redeliver unchanged");
		assert.equal(second.structuredContent.acknowledged, 1);
		const third = await client.callTool("read_messages", { sessionId: HARNESS.id, cwd });
		assert.deepEqual(third.structuredContent.messages, []);
		assert.deepEqual(responder.requests.map(({ request }) => request.type), ["read_messages", "ack_messages", "read_messages", "ack_messages", "read_messages"]);
	}, (cwd) => startMailboxResponder(cwd, [{
		id: "pi-redeliver-1",
		from: { kind: "pi", id: "pi-mailbox" },
		to: { kind: HARNESS.harness, id: HARNESS.id },
		text: "stable body",
		sentAt: "2025-01-02T03:04:05.000Z",
	}], 1));

	console.log("bridge session tests passed");
}

main().catch((error) => {
	console.error(error.stack || error.message || String(error));
	process.exit(1);
});
