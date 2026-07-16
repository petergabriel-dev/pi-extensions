#!/usr/bin/env node
/* Burst stress test for Pi ↔ Claude Code bridge.
 * Sends N concurrent requests and verifies all complete within a deadline.
 * Tests: no response drops, stable latency, no fsync storms on Pi side.
 */

const fs = require("node:fs");
const os = require("os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const TIMEOUT_MS = 2_000;
const POLL_MS = 50;
const BURST_COUNT = 10; // number of concurrent requests

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function bridgeRoot(projectRoot) { return path.join(projectRoot, ".pi", "memory", "bridge"); }
function paths(projectRoot) {
	const root = bridgeRoot(projectRoot);
	return { root, requests: path.join(root, "requests"), responses: path.join(root, "responses"), processed: path.join(root, "processed"), policy: path.join(root, "policy.json"), session: path.join(root, "session.json") };
}
async function waitFor(file, timeoutMs = TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exists(file)) return true;
		await sleep(POLL_MS);
	}
	return false;
}
async function sendRequest(projectRoot, type, payload, id = crypto.randomUUID()) {
	const p = paths(projectRoot);
	const res = path.join(p.responses, `${id}.json`);
	const req = path.join(p.requests, `${id}.json`);
	fs.writeFileSync(req, JSON.stringify({ id, type, payload, ts: Date.now() }, null, 2));
	const start = Date.now();
	if (!(await waitFor(res))) throw new Error(`No response for ${type} within ${TIMEOUT_MS}ms (${Date.now() - start}ms elapsed)`);
	return { id, response: readJson(res), latencyMs: Date.now() - start };
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function freshTarget(projectRoot) {
	const p = paths(projectRoot);
	assert(exists(p.session), `Missing bridge session: ${p.session}`);
	const session = readJson(p.session);
	const heartbeat = Date.parse(session.heartbeatAt || "");
	assert(session.status === "active" && Number.isFinite(heartbeat) && Date.now() - heartbeat <= 5_000, "Bridge session stale/not active");
	return { p, session };
}

test("5 concurrent recall requests all complete", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const ids = [];
	const promises = [];
	for (let i = 0; i < 5; i++) {
		const id = crypto.randomUUID();
		ids.push(id);
		promises.push(sendRequest(projectRoot, "recall", { query: `burst-${i}`, mode: "plan" }, id));
	}
	const results = await Promise.all(promises);
	// All must succeed.
	for (const r of results) {
		assert(r.response.ok === true, `Request ${r.id} failed: ${JSON.stringify(r.response)}`);
		assert(r.latencyMs < TIMEOUT_MS, `Request ${r.id} timed out at ${r.latencyMs}ms`);
	}
	// Our own request files must have been cleaned up (not left behind).
	// Historical files from before the fix may still exist — that's expected.
	const p = paths(projectRoot);
	const remaining = new Set(fs.readdirSync(p.requests).filter(f => f.endsWith(".json")));
	for (const id of ids) {
		assert(!remaining.has(`${id}.json`), `Our request file not cleaned up: ${id}.json`);
	}
});

test("10 concurrent mixed-type requests all complete", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const id = crypto.randomUUID();
	const notes = [{ type: "implementation", text: `Burst stress test note ${id}` }];
	const promises = [
		sendRequest(projectRoot, "recall", { query: "burst", mode: "plan" }),
		sendRequest(projectRoot, "recall", { query: "stress", mode: "build" }),
		sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS:architecture]" }),
		sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS:dev-workflow]" }),
		sendRequest(projectRoot, "capture", { claudeSessionId: `burst-${id}`, notes }, crypto.randomUUID()),
		sendRequest(projectRoot, "recall", { query: "test", mode: "discuss" }),
		sendRequest(projectRoot, "recall", { query: "ping", mode: "plan" }),
		sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS:conventions]" }),
		sendRequest(projectRoot, "recall", { query: "load", mode: "plan" }),
		sendRequest(projectRoot, "capture", { claudeSessionId: `burst2-${id}`, notes: [{ type: "lesson", text: `Load test ${id}` }] }, crypto.randomUUID()),
	];
	const results = await Promise.all(promises);
	for (const r of results) {
		assert(r.response.ok === true, `Request ${r.id} failed: ${JSON.stringify(r.response)}`);
		assert(r.latencyMs < TIMEOUT_MS, `Request ${r.id} latency ${r.latencyMs}ms exceeds timeout`);
	}
});

test("burst latency p50 < 500ms on local bridge", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const promises = [];
	const N = 8;
	for (let i = 0; i < N; i++) {
		promises.push(sendRequest(projectRoot, "recall", { query: `latency-${i}`, mode: "plan" }));
	}
	const results = await Promise.all(promises);
	const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
	const p50 = latencies[Math.floor(N / 2)];
	const p95 = latencies[Math.floor(N * 0.95)];
	assert(p50 < 500, `p50 latency ${p50}ms >= 500ms — bridge is lagging`);
	assert(p95 < TIMEOUT_MS, `p95 latency ${p95}ms exceeds ${TIMEOUT_MS}ms`);
});

test("duplicate burst IDs are stable (idempotency under load)", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const id = crypto.randomUUID();
	const notes = [{ type: "implementation", text: `Duplicate stress ${id}` }];
	// Send same request twice with same ID concurrently.
	const p1 = sendRequest(projectRoot, "capture", { claudeSessionId: `dup-${id}`, notes }, id);
	const p2 = sendRequest(projectRoot, "capture", { claudeSessionId: `dup-${id}`, notes }, id);
	const [r1, r2] = await Promise.all([p1, p2]);
	// Both must succeed and responses must be identical.
	assert(r1.response.ok === true && r2.response.ok === true, "Duplicate burst failed");
	assert(JSON.stringify(r1.response) === JSON.stringify(r2.response), "Duplicate responses differ");
});

async function main() {
	const projectRoot = path.resolve(process.argv[2] || process.cwd());
	const context = { projectRoot };
	let passed = 0;
	const failures = [];
	for (const t of tests) {
		try {
			await t.fn(context);
			passed++;
			console.log(`PASS ${t.name}`);
		} catch (error) {
			failures.push({ name: t.name, error: error.message });
			console.log(`FAIL ${t.name}: ${error.message}`);
		}
	}
	console.log(`\n${passed}/${tests.length} passed`);
	if (failures.length) {
		console.log(JSON.stringify({ failures }, null, 2));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error.stack || error.message || String(error));
	process.exit(1);
});