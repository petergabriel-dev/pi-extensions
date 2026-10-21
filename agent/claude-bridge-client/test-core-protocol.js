#!/usr/bin/env node
/* Core protocol tests for Pi ↔ Claude Code bridge. Zero Pi imports. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const TIMEOUT_MS = 2_000;
const POLL_MS = 50;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.chmodSync(p, 0o600); }
function bridgeRoot(projectRoot) { return path.join(projectRoot, ".pi", "memory", "bridge"); }
function latestSessionId(projectRoot) {
	const sessions = path.join(bridgeRoot(projectRoot), "sessions");
	try {
		return fs.readdirSync(sessions).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
			.map((id) => ({ id, presence: readJson(path.join(sessions, id, "presence.json")) }))
			.filter(({ presence }) => presence?.schemaVersion === 2 && Date.now() - Date.parse(presence.heartbeatAt) <= 5_000)
			.sort((a, b) => Date.parse(b.presence.heartbeatAt) - Date.parse(a.presence.heartbeatAt))[0]?.id || null;
	} catch { return null; }
}
function paths(projectRoot, piSessionId = latestSessionId(projectRoot)) {
	const root = bridgeRoot(projectRoot);
	const sessions = path.join(root, "sessions");
	const namespace = piSessionId ? path.join(sessions, piSessionId) : path.join(sessions, "missing-session");
	return { root, sessions, namespace, requests: path.join(namespace, "requests"), responses: path.join(namespace, "responses"), processed: path.join(namespace, "processed"), presence: path.join(namespace, "presence.json") };
}
async function waitFor(file, timeoutMs = TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exists(file)) return true;
		await sleep(POLL_MS);
	}
	return false;
}
const APPROVAL_TIMEOUT_MS = 120_000;
async function waitForLease(projectRoot, peer, timeoutMs = APPROVAL_TIMEOUT_MS) {
	const shortId = `${peer.harness}:${peer.id.slice(0, 8)}`;
	console.log(`ACTION REQUIRED: in interactive Pi run /build-lease approve for ${shortId} (waiting up to ${timeoutMs / 1000}s).`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const lease = readJson(paths(projectRoot).presence).buildLease;
			if (lease
				&& lease.harness === peer.harness
				&& lease.id === peer.id
				&& Number.isFinite(lease.expiresAt)
				&& lease.expiresAt > lease.grantedAt) return lease;
		} catch { /* presence may be mid-write */ }
		await sleep(500);
	}
	throw new Error(`Timed out waiting for Build lease approval for ${shortId}; interactive Pi and /build-lease approve are required.`);
}
async function sendRequest(projectRoot, type, payload, id = crypto.randomUUID(), peer) {
	const p = paths(projectRoot);
	const res = path.join(p.responses, `${id}.json`);
	writeJson(path.join(p.requests, `${id}.json`), { id, type, payload, ts: Date.now(), ...(peer ? { peer } : {}) });
	if (!(await waitFor(res))) throw new Error(`No response for ${type} within ${TIMEOUT_MS}ms`);
	return { id, response: readJson(res), responsePath: res };
}
function runHook(input, cwd, env = {}) {
	const hook = path.resolve(__dirname, "pi-readonly-hook.js");
	const out = cp.spawnSync("node", [hook], { input: JSON.stringify(input), cwd, encoding: "utf8", env: { ...process.env, ...env } });
	if (out.status !== 0) throw new Error(out.stderr || `hook exit ${out.status}`);
	return JSON.parse(out.stdout || "{}");
}
function runMcp(messages, cwd) {
	const mcp = path.resolve(__dirname, "pi-bridge-mcp.js");
	const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
	const out = cp.spawnSync("node", [mcp], { input, cwd, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "core-protocol-mcp" } });
	if (out.status !== 0) throw new Error(out.stderr || `mcp exit ${out.status}`);
	return out.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function denied(result) { return result.hookSpecificOutput?.permissionDecision === "deny"; }
function updatedInput(result) { return result.hookSpecificOutput?.updatedInput; }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function freshTarget(projectRoot) {
	const p = paths(projectRoot);
	assert(exists(p.presence), `Missing bridge presence: ${p.presence}`);
	const session = readJson(p.presence);
	const heartbeat = Date.parse(session.heartbeatAt || "");
	assert(session.schemaVersion === 2 && session.piSessionId && Number.isFinite(heartbeat) && Date.now() - heartbeat <= 5_000, "Bridge session stale/not active");
	return { p, session };
}

function makeTempPiProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hook-test-"));
	fs.mkdirSync(path.join(root, ".pi", "memory", "bridge"), { recursive: true });
	return root;
}

test("bridge active namespace dirs and v2 presence", async ({ projectRoot }) => {
	const { p, session } = freshTarget(projectRoot);
	for (const key of ["requests", "responses", "processed"]) assert(exists(p[key]), `Missing ${key}`);
	assert(session.piSessionId, "presence missing piSessionId");
	assert(Array.isArray(session.peers), "presence missing peers");
});

test("malformed/invalid request returns error", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const p = paths(projectRoot);
	writeJson(path.join(p.requests, `${id}.json`), { id, type: "bad_type", payload: {}, ts: Date.now() });
	const res = path.join(p.responses, `${id}.json`);
	assert(await waitFor(res), "No invalid request response");
	const response = readJson(res);
	assert(response.ok === false, "Invalid request should fail");
	assert(response.error?.code === "invalid_request", `Unexpected error code ${response.error?.code}`);
});

test("recall returns memory/prompts shape", async ({ projectRoot }) => {
	const { response } = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "plan" });
	assert(response.ok === true, `recall failed: ${JSON.stringify(response)}`);
	assert(response.result?.memory, "recall missing memory");
	assert(response.result?.buildLease === null, "recall without lease must return buildLease:null");
	assert(response.result?.prompts?.cavemanEnabled === true, "recall must default Caveman ON");
	for (const field of ["discussPrompt", "planPrompt", "buildPrompt"]) {
		assert(response.result?.prompts?.[field]?.includes("CAVEMAN MODE ACTIVE."), `${field} missing Caveman prompt`);
	}
});

test("build recall requires a paired peer and active plan", async ({ projectRoot }) => {
	const peer = { harness: "claude", id: `build-lease-${crypto.randomUUID()}` };
	const unpaired = await sendRequest(projectRoot, "recall", { mode: "build" }, crypto.randomUUID(), peer);
	assert(unpaired.response.error?.code === "build_lease_peer_kind", `Unpaired peer unexpectedly passed lease check: ${JSON.stringify(unpaired.response)}`);
	await sendRequest(projectRoot, "pair", {}, crypto.randomUUID(), peer);
	const attempt = await sendRequest(projectRoot, "recall", { mode: "build" }, crypto.randomUUID(), peer);
	assert(attempt.response.ok === false, "build recall without active plan unexpectedly succeeded");
	assert(attempt.response.error?.code === "build_lease_no_plan", `Unexpected build lease error: ${JSON.stringify(attempt.response.error)}`);
	await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), peer);
});

test("validate_tags valid and invalid", async ({ projectRoot }) => {
	const good = await sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS:architecture] ok\n- [ ] [DOCS:decisions][ADR:new] adr" });
	assert(good.response.ok && good.response.result.valid === true, "valid tags not valid");
	const bad = await sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS] bad\n- [ ] [DOCS:decisions] missing" });
	assert(bad.response.ok && bad.response.result.valid === false, "invalid tags not invalid");
	assert(bad.response.result.invalid.length >= 2, "invalid tag details missing");
});

test("capture writes note/widget and duplicate id is stable", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const text = `Core protocol capture ${id}`;
	const first = await sendRequest(projectRoot, "capture", { claudeSessionId: `core-${id}`, context: "core protocol", notes: [{ type: "implementation", text }] }, id);
	assert(first.response.ok, `capture failed: ${JSON.stringify(first.response)}`);
	assert(first.response.result.widgetUpdated === true, "capture did not report widget update");
	assert(first.response.result.sessionId === `core-${id}`, "legacy claudeSessionId did not populate sessionId");
	assert(first.response.result.claudeSessionId === `core-${id}`, "legacy claudeSessionId alias missing");
	assert(first.response.result.stagingFile === undefined, "capture should not write staging");
	fs.unlinkSync(first.responsePath);
	const second = await sendRequest(projectRoot, "capture", { claudeSessionId: `core-${id}`, notes: [{ type: "implementation", text: "DUPLICATE SHOULD NOT APPLY" }] }, id);
	assert(JSON.stringify(second.response) === JSON.stringify(first.response), "duplicate capture response changed");
});

test("capture accepts sessionId primary and lets it win over legacy alias", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const first = await sendRequest(projectRoot, "capture", {
		sessionId: `session-${id}`,
		claudeSessionId: `legacy-${id}`,
		notes: [{ type: "implementation", text: `Core protocol sessionId capture ${id}` }],
	});
	assert(first.response.ok, `sessionId capture failed: ${JSON.stringify(first.response)}`);
	assert(first.response.result.sessionId === `session-${id}`, "sessionId did not win over claudeSessionId");
	assert(first.response.result.claudeSessionId === `session-${id}`, "claudeSessionId alias did not mirror sessionId");
});

test("paired send_message queues inbound message for before_agent_start", async ({ projectRoot }) => {
	const { p } = freshTarget(projectRoot);
	const peer = { harness: "claude", id: `core-${crypto.randomUUID()}` };
	const pair = await sendRequest(projectRoot, "pair", {}, crypto.randomUUID(), peer);
	assert(pair.response.ok, `pair failed: ${JSON.stringify(pair.response)}`);
	try {
		const id = crypto.randomUUID();
		const sent = await sendRequest(projectRoot, "send_message", { text: "Untrusted core-protocol advisory" }, id, peer);
		assert(sent.response.ok, `send_message failed: ${JSON.stringify(sent.response)}`);
		assert(sent.response.result.messageId === id, "inbound message id must preserve bridge request id");
		const presence = readJson(p.presence);
		const paired = presence.peers.find((candidate) => candidate.harness === peer.harness && candidate.id === peer.id);
		assert(paired?.pendingCount === 0 && paired?.inboundPendingCount === 1, "directional pending counts not reflected in presence");
	} finally {
		await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), peer);
	}
});

test("paired read_messages and ack_messages are non-destructive and UUID-idempotent", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const peer = { harness: "claude", id: `core-${crypto.randomUUID()}` };
	const pair = await sendRequest(projectRoot, "pair", {}, crypto.randomUUID(), peer);
	assert(pair.response.ok, `pair failed: ${JSON.stringify(pair.response)}`);
	try {
		const readId = crypto.randomUUID();
		const firstRead = await sendRequest(projectRoot, "read_messages", {}, readId, peer);
		assert(firstRead.response.ok && firstRead.response.result.messages.length === 0, "empty paired read failed");
		const repeatedRead = await sendRequest(projectRoot, "read_messages", {}, readId, peer);
		assert(JSON.stringify(repeatedRead.response) === JSON.stringify(firstRead.response), "read_messages request replay changed response");
		const ackId = crypto.randomUUID();
		const firstAck = await sendRequest(projectRoot, "ack_messages", { ids: [] }, ackId, peer);
		assert(firstAck.response.ok && firstAck.response.result.acknowledged === 0, "empty ack failed");
		const repeatedAck = await sendRequest(projectRoot, "ack_messages", { ids: ["different-id"] }, ackId, peer);
		assert(JSON.stringify(repeatedAck.response) === JSON.stringify(firstAck.response), "ack_messages request replay changed response");
	} finally {
		await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), peer);
	}
});

test("save_plan is visible through recall duplicate response stable", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const planText = `# Core Protocol Saved Plan ${id}\n\n## Section 4 — Tasks\n- [ ] Core protocol save visible\n- [ ] Core protocol second task`;
	const first = await sendRequest(projectRoot, "save_plan", { planText, planId: `core-${id}`, confirmed: true }, id);
	assert(first.response.ok, `save_plan failed: ${JSON.stringify(first.response)}`);
	assert(first.response.result.planId === `core-${id}`, "planId mismatch");
	assert(typeof first.response.result.path === "string" && first.response.result.path.endsWith(`${first.response.result.planId}.md`), "save_plan missing plan path");
	assert(first.response.result.taskCount === 2, "save_plan missing task count");

	const leasePeer = { harness: "claude", id: "core-protocol-mcp" };
	await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), leasePeer);
	await sendRequest(projectRoot, "pair", {}, crypto.randomUUID(), leasePeer);

	// Recall must see the saved plan after a successful save.
	const recall = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "plan" });
	assert(recall.response.ok, "recall after save_plan failed");
	const sp = recall.response.result.savedPlan;
	assert(sp && typeof sp === "object", "recall missing savedPlan after save_plan");
	assert(sp.planId === `core-${id}`, `recall savedPlan.planId mismatch: got ${sp.planId}`);
	assert(sp.planText === planText, `recall savedPlan.planText mismatch`);
	assert(sp.path === first.response.result.path, "recall savedPlan path mismatch");
	assert(sp.progress?.done === 0 && sp.progress?.total === 2, "recall savedPlan progress mismatch before tick");
	assert(typeof sp.savedAt === "string" && sp.savedAt.length > 0, "recall savedPlan missing savedAt");

	const tasks = await sendRequest(projectRoot, "read_plan_tasks", { planId: `core-${id}` });
	assert(tasks.response.ok, `read_plan_tasks failed: ${JSON.stringify(tasks.response)}`);
	assert(tasks.response.result.planId === `core-${id}` && tasks.response.result.tasks?.length === 2, "read_plan_tasks result missing seeded tasks");

	const pendingRecall = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "build" }, crypto.randomUUID(), leasePeer);
	assert(pendingRecall.response.ok === false && pendingRecall.response.error?.code === "build_lease_pending", `build recall did not stay pending: ${JSON.stringify(pendingRecall.response)}`);
	assert(readJson(paths(projectRoot).presence).buildLease == null, "pending build recall wrote a lease into presence");

	const otherPeer = { harness: "cursor", id: `build-nonholder-${id}` };
	await sendRequest(projectRoot, "pair", {}, crypto.randomUUID(), otherPeer);
	const blockedTick = await sendRequest(projectRoot, "tick_plan_task", { planId: `core-${id}`, title: tasks.response.result.tasks[0].title }, crypto.randomUUID(), otherPeer);
	assert(blockedTick.response.error?.code === "build_lease_required", `non-holder tick unexpectedly passed: ${JSON.stringify(blockedTick.response)}`);

	const approvedLease = await waitForLease(projectRoot, leasePeer);
	assert(approvedLease.expiresAt === approvedLease.grantedAt + 4 * 60 * 60 * 1000, "approved lease expiry is not four hours");

	const buildRecall = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "build" }, crypto.randomUUID(), leasePeer);
	assert(buildRecall.response.ok === true, `build recall after approval failed: ${JSON.stringify(buildRecall.response)}`);
	assert(buildRecall.response.result.buildLease?.harness === leasePeer.harness && buildRecall.response.result.buildLease?.id === leasePeer.id, "build recall did not return approved lease");
	assert(Number.isFinite(buildRecall.response.result.buildLease?.expiresAt), "build recall lease missing expiresAt");
	const presenceWithLease = readJson(paths(projectRoot).presence);
	assert(presenceWithLease.buildLease?.harness === leasePeer.harness && presenceWithLease.buildLease?.id === leasePeer.id, "presence did not include build lease");
	assert(presenceWithLease.buildLease?.expiresAt === approvedLease.expiresAt, "presence lease expiry mismatch");

	const stillBlocked = await sendRequest(projectRoot, "tick_plan_task", { planId: `core-${id}`, title: tasks.response.result.tasks[0].title }, crypto.randomUUID(), otherPeer);
	assert(stillBlocked.response.error?.code === "build_lease_required", `non-holder tick passed while another peer held the lease: ${JSON.stringify(stillBlocked.response)}`);

	const titleTickId = crypto.randomUUID();
	const titleTick = await sendRequest(projectRoot, "tick_plan_task", { planId: `core-${id}`, title: tasks.response.result.tasks[0].title }, titleTickId, leasePeer);
	assert(titleTick.response.ok && titleTick.response.result.progress?.done === 1, `title tick_plan_task failed: ${JSON.stringify(titleTick.response)}`);
	assert(titleTick.response.result.taskId === tasks.response.result.tasks[0].id, "title tick resolved wrong task");
	await sleep(POLL_MS * 2);
	const taskId = tasks.response.result.tasks[0].id;
	const tickId = crypto.randomUUID();
	const tick = await sendRequest(projectRoot, "tick_plan_task", { planId: `core-${id}`, taskId }, tickId, leasePeer);
	assert(tick.response.ok && tick.response.result.progress?.done === 1 && tick.response.result.idempotent === true, `holder idempotent tick failed: ${JSON.stringify(tick.response)}`);
	fs.unlinkSync(tick.responsePath);
	const tickReplay = await sendRequest(projectRoot, "tick_plan_task", { planId: `core-${id}`, taskId: "different" }, tickId, leasePeer);
	assert(JSON.stringify(tickReplay.response) === JSON.stringify(tick.response), "duplicate tick response changed");
	const recalledAfterTick = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "plan" });
	assert(recalledAfterTick.response.result.savedPlan?.progress?.done === 1, "recall did not return live tick progress");
	await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), otherPeer);

	// Duplicate save_plan response must remain stable.
	fs.unlinkSync(first.responsePath);
	const second = await sendRequest(projectRoot, "save_plan", { planText: "DIFFERENT", confirmed: true }, id);
	assert(JSON.stringify(second.response) === JSON.stringify(first.response), "duplicate save response changed");
});

test("MCP exposes and dispatches memory entry tools", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const id = crypto.randomUUID();
	const name = `Core MCP memory ${id}`;
	const responses = runMcp([
		{ jsonrpc: "2.0", id: 1, method: "tools/list" },
		{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "save_memory", arguments: { name, description: "Saved through MCP", type: "reference", body: `MCP body ${id}`, cwd: projectRoot } } },
		{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall_memory_entry", arguments: { slug: `core-mcp-memory-${id}`, cwd: projectRoot } } },
	], projectRoot);
	const listed = responses.find((response) => response.id === 1)?.result?.tools?.map((tool) => tool.name) || [];
	assert(listed.includes("recall_memory_entry"), "recall_memory_entry missing from tools/list");
	assert(listed.includes("save_memory"), "save_memory missing from tools/list");
	assert(listed.includes("read_plan_tasks"), "read_plan_tasks missing from tools/list");
	assert(listed.includes("tick_plan_task"), "tick_plan_task missing from tools/list");
	const saved = responses.find((response) => response.id === 2);
	assert(!saved.error, `save_memory MCP error: ${JSON.stringify(saved)}`);
	assert(saved.result.structuredContent.result.slug === `core-mcp-memory-${id}`, "save_memory slug mismatch");
	const recalled = responses.find((response) => response.id === 3);
	assert(!recalled.error, `recall_memory_entry MCP error: ${JSON.stringify(recalled)}`);
	assert(recalled.result.structuredContent.result.entry.includes(`MCP body ${id}`), "recall_memory_entry body missing");

	const taskRead = runMcp([
		{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_plan_tasks", arguments: { cwd: projectRoot } } },
	], projectRoot).find((response) => response.id === 4);
	assert(!taskRead.error, `read_plan_tasks MCP error: ${JSON.stringify(taskRead)}`);
	const taskResult = taskRead.result.structuredContent.result;
	assert(taskResult.tasks?.length === 2 && taskResult.progress?.done === 1, "read_plan_tasks MCP result missing live task state");
	const taskTick = runMcp([
		{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tick_plan_task", arguments: { taskId: taskResult.tasks[0].id, cwd: projectRoot } } },
	], projectRoot).find((response) => response.id === 5);
	assert(!taskTick.error, `tick_plan_task MCP error: ${JSON.stringify(taskTick)}`);
	assert(taskTick.result.structuredContent.result.idempotent === true, "tick_plan_task MCP did not use live idempotency");
	assert(taskTick.result.structuredContent.result.progress?.done === 1, "tick_plan_task MCP changed completed progress");

	// The approved holder from the saved-plan test still holds the lease; Discuss recall releases it.
	const leasePeer = { harness: "claude", id: "core-protocol-mcp" };
	const discussRecall = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "discuss" }, crypto.randomUUID(), leasePeer);
	assert(discussRecall.response.ok === true && discussRecall.response.result.buildLease === null, "holder discuss recall did not release lease");
	assert(readJson(paths(projectRoot).presence).buildLease == null, "presence retained lease after holder discuss recall");
	await sendRequest(projectRoot, "unpair", {}, crypto.randomUUID(), leasePeer);
});

test("MCP client fails loudly when bridge down", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-down-"));
	fs.mkdirSync(path.join(tmp, ".pi", "memory", "bridge", "requests"), { recursive: true });
	fs.mkdirSync(path.join(tmp, ".pi", "memory", "bridge", "responses"), { recursive: true });
	const mcp = path.resolve(__dirname, "pi-bridge-mcp.js");
	const out = cp.spawnSync("node", [mcp, "request", "recall", JSON.stringify({ query: "x" }), tmp], { encoding: "utf8" });
	assert(out.status !== 0, "bridge-down request should fail");
	assert((out.stderr + out.stdout).includes("Pi bridge not responding; start/focus Pi in this project."), "missing loud bridge-down message");
});

test("read-only hook allows non-Pi and enforces Pi policy", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const nonPi = fs.mkdtempSync(path.join(os.tmpdir(), "nonpi-"));
	assert(!denied(runHook({ tool_name: "Edit", tool_input: {} }, nonPi)), "non-Pi Edit denied");
	assert(denied(runHook({ tool_name: "Edit", tool_input: {} }, projectRoot)), "Pi Edit not denied");
	const isSandboxed = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

	const rg = runHook({ tool_name: "Bash", tool_input: { command: "rg bridge" } }, projectRoot);
	if (isSandboxed) {
		assert(!denied(rg), "Pi rg denied");
		assert(updatedInput(rg)?.command?.includes("/usr/bin/sandbox-exec"), "Pi rg was not sandbox-wrapped");
	} else {
		assert(denied(rg), "Pi rg not denied when sandbox unavailable");
	}

	const pytest = runHook({ tool_name: "Bash", tool_input: { command: "pytest" } }, projectRoot);
	if (isSandboxed) {
		assert(!denied(pytest), "Pi pytest denied");
	} else {
		assert(denied(pytest), "Pi pytest not denied when sandbox unavailable");
	}

	if (isSandboxed) {
		assert(!denied(runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, projectRoot)), "Pi git commit denied under sandbox");
	} else {
		assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, projectRoot)), "Pi git commit not denied");
	}
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "rg bridge", dangerouslyDisableSandbox: true } }, projectRoot)), "Pi sandbox-disable flag not denied");
	// Stale/missing policy must NOT block sandboxed Bash (decoupled from policy freshness).
	const stale = makeTempPiProject();
	const staleResult = runHook({ tool_name: "Bash", tool_input: { command: "rg x" } }, stale);
	if (isSandboxed) {
		assert(!denied(staleResult), "missing/stale policy denied sandboxed Bash (policy should be decoupled)");
		assert(updatedInput(staleResult)?.command?.includes("/usr/bin/sandbox-exec"), "stale-project Bash was not sandbox-wrapped");
	} else {
		assert(denied(staleResult), "missing policy did not deny Bash when sandbox unavailable");
	}

	// Expired policy must NOT block sandboxed Bash either.
	const expired = makeTempPiProject();
	const expiredPolicyPath = path.join(bridgeRoot(expired), "policy.json");
	writeJson(expiredPolicyPath, { writtenAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString(), policy: { mutationTools: [] } });
	const expiredResult = runHook({ tool_name: "Bash", tool_input: { command: "echo stale" } }, expired);
	if (isSandboxed) {
		assert(!denied(expiredResult), "expired policy denied sandboxed Bash (policy should be decoupled)");
	} else {
		assert(denied(expiredResult), "expired policy did not deny Bash when sandbox unavailable");
	}

	// Stale (old writtenAt) policy must NOT block sandboxed Bash.
	const stalePolicy = makeTempPiProject();
	const stalePolicyPath = path.join(bridgeRoot(stalePolicy), "policy.json");
	writeJson(stalePolicyPath, { writtenAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), policy: { mutationTools: [] } });
	const stalePolicyResult = runHook({ tool_name: "Bash", tool_input: { command: "echo stale" } }, stalePolicy);
	if (isSandboxed) {
		assert(!denied(stalePolicyResult), "stale-writtenAt policy denied sandboxed Bash (policy should be decoupled)");
	} else {
		assert(denied(stalePolicyResult), "stale-writtenAt policy did not deny Bash when sandbox unavailable");
	}

	// Mutation tools must still be blocked regardless of policy state.
	assert(denied(runHook({ tool_name: "Edit", tool_input: {} }, stale)), "Edit not denied in stale Pi project");
	assert(denied(runHook({ tool_name: "Write", tool_input: {} }, expired)), "Write not denied in expired Pi project");
});

// Deterministic fail-closed coverage via PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC=1.
// Ensures the deny path is exercised even on macOS hosts where sandbox-exec exists.
test("read-only hook fail-closed path deterministically via env override", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const env = { PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC: "1" };

	// 1) Bash denied when sandbox is unavailable.
	const bashResult = runHook({ tool_name: "Bash", tool_input: { command: "echo hello" } }, projectRoot, env);
	assert(denied(bashResult), "Bash not denied when sandbox disabled via env");
	assert(bashResult.systemMessage?.includes("sandbox-exec"), "Deny message missing sandbox-exec mention");

	// 2) Read commands also denied (no sandbox → no Bash at all).
	const readResult = runHook({ tool_name: "Bash", tool_input: { command: "rg bridge" } }, projectRoot, env);
	assert(denied(readResult), "Read Bash not denied when sandbox disabled");

	// 3) Mutation tools remain denied regardless of sandbox status.
	assert(denied(runHook({ tool_name: "Edit", tool_input: {} }, projectRoot, env)), "Edit not denied");
	assert(denied(runHook({ tool_name: "Write", tool_input: {} }, projectRoot, env)), "Write not denied");
	assert(denied(runHook({ tool_name: "MultiEdit", tool_input: {} }, projectRoot, env)), "MultiEdit not denied");
	assert(denied(runHook({ tool_name: "NotebookEdit", tool_input: {} }, projectRoot, env)), "NotebookEdit not denied");

	// 4) dangerouslyDisableSandbox flag denied.
	const disableResult = runHook({ tool_name: "Bash", tool_input: { command: "echo", dangerouslyDisableSandbox: true } }, projectRoot, env);
	assert(denied(disableResult), "dangerouslyDisableSandbox not denied");

	// 5) No policy freshness dependency: stale/missing/expired policy does not change deny.
	const stale = makeTempPiProject();
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "echo" } }, stale, env)), "stale-project Bash not denied");

	const expired = makeTempPiProject();
	writeJson(path.join(bridgeRoot(expired), "policy.json"), { writtenAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString(), policy: { mutationTools: [] } });
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "echo" } }, expired, env)), "expired-policy Bash not denied");

	// 6) Non-Pi directory: Bash allowed even with env override (no .pi ancestor).
	const nonPi = fs.mkdtempSync(path.join(os.tmpdir(), "nonpi-failclosed-"));
	assert(!denied(runHook({ tool_name: "Bash", tool_input: { command: "echo ok" } }, nonPi, env)), "non-Pi Bash denied under env override");
	assert(!denied(runHook({ tool_name: "Edit", tool_input: {} }, nonPi, env)), "non-Pi Edit denied under env override");
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
