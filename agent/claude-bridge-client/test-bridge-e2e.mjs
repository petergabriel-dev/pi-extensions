#!/usr/bin/env node
/*
 * Cross-process bridge e2e: a real headless Pi (`--mode rpc`, bundled CLI from
 * `npm run bootstrap`) driven through the real MCP client over the file IPC.
 * Lease approval goes through Pi's own UI path (the RPC confirm dialog), never a bypass.
 * No model is called; a loopback endpoint fails the test if one is.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const client = require("./pi-bridge-mcp.js");
const cli = path.join(repo, "agent/extensions/subagents/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const TEST_TIMEOUT_MS = 90_000;
const IDENTITY = { harness: "claude", id: "e2e-claude-1" };
const OTHER = { harness: "claude", id: "e2e-claude-other" };
const PI_SESSION_ID = randomUUID();
const PLAN = "# Plan\n\n## Section 4 — Tasks\n\n- [ ] First task\n  - **Given** a **When** b **Then** c\n- [ ] Second task\n  - **Given** a **When** b **Then** c\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let step = "setup";

if (!existsSync(cli)) {
	console.error(`Bundled Pi CLI missing at ${cli}; run npm run bootstrap first.`);
	process.exit(1);
}
// The client in this process reads PI_BRIDGE_* timeouts from env; keep them at defaults.
for (const key of Object.keys(process.env)) if (key.startsWith("PI_BRIDGE_")) delete process.env[key];

const root = mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "pi-bridge-e2e-"));
chmodSync(root, 0o700);
const project = path.join(root, "project");
const agentDir = path.join(root, "agent");
mkdirSync(path.join(project, ".pi"), { recursive: true });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });

let modelCalls = 0;
const modelServer = createServer((_request, response) => {
	modelCalls += 1;
	response.writeHead(500).end("the bridge e2e must not call a model");
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: {
		"e2e-fake": {
			name: "Bridge e2e fake",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
			apiKey: "e2e-key",
			models: [{ id: "fake", name: "fake", input: ["text"], reasoning: false, contextWindow: 32_768, maxTokens: 1_024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
	},
}), { mode: 0o600 });

const env = { ...process.env };
for (const key of Object.keys(env)) {
	if (key.startsWith("PI_") || key === "CLAUDE_CODE_SESSION_ID" || /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN)$/i.test(key)) delete env[key];
}
env.PI_CODING_AGENT_DIR = agentDir;

// Minimal RPC driver: JSONL out, commands in, and Pi's own approval dialogs answered yes.
function startPi() {
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "-e", repo, "--session-dir", path.join(root, "sessions"), "--session-id", PI_SESSION_ID, "--model", "e2e-fake/fake"], {
		cwd: project,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pi = { child, stderr: "", dialogs: [], notices: [] };
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let record;
			try { record = JSON.parse(line); } catch { continue; }
			if (record?.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string") pi.notices.push(record.message);
			if (record?.type !== "extension_ui_request" || (record.method !== "confirm" && record.method !== "select")) continue;
			pi.dialogs.push({ method: record.method, title: record.title });
			const reply = record.method === "confirm" ? { confirmed: true } : { value: record.options?.[0] };
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, ...reply })}\n`);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { pi.stderr = (pi.stderr + chunk).slice(-8_000); });
	pi.prompt = (message) => child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message })}\n`);
	return pi;
}

async function stopPi(pi, signal = "SIGTERM") {
	if (!pi || pi.child.exitCode !== null || pi.child.signalCode !== null) return;
	const closed = new Promise((resolve) => pi.child.once("close", resolve));
	if (signal === "SIGTERM") pi.child.stdin.end();
	pi.child.kill(signal);
	await Promise.race([closed, sleep(5_000)]);
	if (pi.child.exitCode === null && pi.child.signalCode === null) pi.child.kill("SIGKILL");
}

async function waitFor(check, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const namespace = path.join(project, ".pi/memory/bridge/sessions", PI_SESSION_ID);
const dir = (name) => path.join(namespace, name);
const call = async (name, args = {}, identity = IDENTITY) => {
	const result = await client.callTool(name, { ...args, cwd: project, sessionId: identity.id, harness: identity.harness });
	return result.structuredContent ?? JSON.parse(result.content[0].text);
};
const callError = async (name, args = {}, identity = IDENTITY) => {
	try { await call(name, args, identity); } catch (error) { return error; }
	throw new Error(`${name} unexpectedly succeeded`);
};
function runHook(input) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(here, "pi-readonly-hook.js")], { cwd: project, env: { ...env, PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.on("error", reject);
		child.on("close", () => resolve(stdout.trim() ? JSON.parse(stdout) : {}));
		child.stdin.end(JSON.stringify(input));
	});
}
// A request written straight into requests/ (atomically), as a harness client would.
function writeRawRequest(body) {
	const id = randomUUID();
	const staging = path.join(root, `${id}.json`);
	writeFileSync(staging, body(id), { mode: 0o600 });
	chmodSync(staging, 0o600);
	renameSync(staging, path.join(dir("requests"), `${id}.json`));
	return id;
}
const readAnswer = (id) => {
	try { return JSON.parse(readFileSync(path.join(dir("responses"), `${id}.json`), "utf8")); } catch { return null; }
};

let pi;
const timeout = setTimeout(() => {
	console.error(`bridge e2e timed out during: ${step}`);
	process.exit(1);
}, TEST_TIMEOUT_MS);
timeout.unref();

try {
	step = "start headless Pi";
	pi = startPi();
	await waitFor(() => existsSync(path.join(namespace, "presence.json")) && existsSync(dir("inflight")), "bridge presence");

	step = "1 init: pair through the first request";
	const sessions = await call("list_sessions");
	assert.deepEqual(sessions.sessions.map((session) => session.id), [PI_SESSION_ID]);

	step = "2 save_plan";
	const saved = await call("save_plan", { planText: PLAN, confirmed: true, planId: "e2e-plan" });
	assert.equal(saved.result.planId, "e2e-plan");
	assert.equal(saved.result.taskCount, 2);
	assert.ok(client.findPairedLiveSessions(project, IDENTITY).length === 1, "first request must auto-pair");

	step = "3 read_plan_tasks";
	const tasks = await call("read_plan_tasks");
	assert.deepEqual(tasks.result.tasks.map((task) => task.title), ["First task", "Second task"]);
	assert.deepEqual(tasks.result.progress, { done: 0, total: 2 });

	step = "4 lease: pending, approved through Pi's confirm dialog, then held";
	const pending = await callError("recall_memory", { mode: "build", query: "bridge" });
	assert.equal(pending.code, "build_lease_pending", pending.message);
	assert.equal(client.holdsBuildLease(project, IDENTITY), false);
	pi.prompt("/build-lease approve");
	await waitFor(() => client.holdsBuildLease(project, IDENTITY), "lease approval");
	assert.deepEqual(pi.dialogs.map((dialog) => dialog.method), ["confirm"]);
	const recall = await call("recall_memory", { mode: "build", query: "bridge request lease" });
	assert.equal(recall.result.buildLease.id, IDENTITY.id);
	assert.equal(recall.result.savedPlan.planId, "e2e-plan");
	assert.deepEqual(Object.keys(recall.result.prompts), ["mode", "cavemanEnabled", "buildPrompt"]);
	assert.ok(recall.result.meta.bytes > 0 && typeof recall.result.meta.budgetExceeded === "boolean");

	step = "5 tick_plan_task, then the same task again";
	const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	writeFileSync(path.join(project, "task.txt"), "task one\n");
	git("add", "task.txt");
	git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "task one");
	const head = git("rev-parse", "HEAD");
	const [tickSession] = client.liveSessions(project);
	// The author is host-stamped: a payload `by` is rejected and nothing is recorded.
	const forged = await client.sendRequestToSession(project, tickSession, "tick_plan_task", { taskId: tasks.result.tasks[0].id, by: "codex:forged" }, IDENTITY).catch((error) => error);
	assert.ok(forged instanceof Error && /only taskId, title, planId, note, and commit/.test(forged.message), "payload by must be rejected");
	assert.deepEqual((await call("read_plan_tasks")).result.progress, { done: 0, total: 2 });
	const ticked = await call("tick_plan_task", { taskId: tasks.result.tasks[0].id, commit: head.slice(0, 8) });
	assert.deepEqual(ticked.result.progress, { done: 1, total: 2 });
	assert.equal(ticked.result.idempotent, false);
	assert.equal(ticked.result.commit, head, "short SHA resolves to the full commit");
	assert.equal(ticked.result.by, `${IDENTITY.harness}:${IDENTITY.id}`, "author comes from the host-stamped peer");
	const again = await call("tick_plan_task", { taskId: tasks.result.tasks[0].id });
	assert.equal(again.result.idempotent, true);
	assert.equal(again.result.commit, head, "re-tick keeps the first commit");

	step = "5b review: another identity reads review state and one evidence page";
	const bundleId = ticked.result.bundle?.id;
	assert.match(bundleId ?? "", /^[0-9a-f]{64}$/, "a bridge tick builds an evidence bundle");
	const reviewRecall = await call("recall_memory", { mode: "review", query: "review evidence" }, OTHER);
	assert.deepEqual(Object.keys(reviewRecall.result.prompts), ["mode", "cavemanEnabled", "reviewPrompt"]);
	assert.ok(reviewRecall.result.prompts.reviewPrompt.includes("untrusted data"), "review prompt marks evidence as data");
	const reviewedTask = reviewRecall.result.review.tasks.find((task) => task.taskId === tasks.result.tasks[0].id);
	assert.deepEqual({ state: reviewedTask.state, bundleId: reviewedTask.bundleId, commit: reviewedTask.commit, by: reviewedTask.by }, { state: "ready", bundleId, commit: head, by: `${IDENTITY.harness}:${IDENTITY.id}` });
	const evidencePage = await call("read_task_evidence", { bundleId }, OTHER);
	assert.deepEqual({ section: evidencePage.result.section, page: evidencePage.result.page }, { section: "summary", page: 0 });
	assert.equal(JSON.parse(evidencePage.result.data).commit, head);
	assert.ok(Buffer.byteLength(JSON.stringify(evidencePage.result), "utf8") <= 24 * 1024, "evidence pages stay within 24 KiB");
	const afterRead = await call("recall_memory", { mode: "review", query: "review evidence" }, OTHER);
	assert.equal(afterRead.result.review.tasks.find((task) => task.taskId === tasks.result.tasks[0].id).state, "in_review", "reading evidence records review_started");
	assert.equal(client.holdsBuildLease(project, IDENTITY), true, "another identity's review recall keeps the holder's lease");
	assert.deepEqual(again.result.progress, { done: 1, total: 2 });

	step = "6 hook decision: lease holder may write, another session may not";
	const target = path.join(project, "e2e-note.txt");
	const allowed = await runHook({ cwd: project, session_id: IDENTITY.id, tool_name: "Write", tool_input: { file_path: target } });
	assert.deepEqual(allowed, {});
	const denied = await runHook({ cwd: project, session_id: OTHER.id, tool_name: "Write", tool_input: { file_path: target } });
	assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");

	step = "7 duplicates: same request id replays; identical save_plan is idempotent";
	const [session] = client.liveSessions(project);
	const requestId = randomUUID();
	const first = await client.sendRequestToSession(project, session, "read_plan_tasks", {}, IDENTITY, { requestId });
	const replay = await client.sendRequestToSession(project, session, "read_plan_tasks", {}, IDENTITY, { requestId });
	assert.deepEqual(replay.result, first.result);
	const resaved = await call("save_plan", { planText: PLAN, confirmed: true });
	assert.equal(resaved.result.planId, "e2e-plan");
	assert.equal(resaved.result.idempotent, true);
	assert.deepEqual((await call("read_plan_tasks")).result.progress, { done: 1, total: 2 });

	step = "/bridge-health reports recorded requests without ids";
	pi.prompt("/bridge-health");
	const report = await waitFor(() => pi.notices.find((message) => message.startsWith("Bridge health:")), "bridge health report");
	assert.match(report, /save_plan\s+n=\d+\s+p50 \d+ms\s+p95 \d+ms/);
	assert.match(report, /tick_plan_task\s+n=\d+/);
	assert.ok(!report.includes(IDENTITY.id) && !report.includes(PI_SESSION_ID), "health report must not name sessions");
	const ring = readFileSync(path.join(namespace, "health.jsonl"), "utf8");
	assert.ok(ring.trim().split("\n").length >= 8 && !ring.includes(IDENTITY.id) && !ring.includes("First task"), "health ring holds no ids or payload text");

	step = "fault: Pi paused -> not delivered, and the withdrawn request never runs";
	pi.child.kill("SIGSTOP");
	let paused;
	try {
		paused = await client.sendRequestToSession(project, session, "tick_plan_task", { taskId: tasks.result.tasks[1].id }, IDENTITY, { pickupTimeoutMs: 400 }).catch((error) => error);
	} finally {
		pi.child.kill("SIGCONT");
	}
	assert.equal(paused.code, "not_delivered");
	assert.equal(paused.message, client.BRIDGE_DOWN_MESSAGE);
	await sleep(1_500);
	assert.deepEqual(readdirSync(dir("withdrawn")), [], "poll must clear withdrawn requests");
	assert.deepEqual((await call("read_plan_tasks")).result.progress, { done: 1, total: 2 }, "withdrawn tick must never run");

	step = "fault: oversized request -> payload_too_large";
	const big = writeRawRequest((id) => JSON.stringify({ id, type: "read_plan_tasks", payload: { pad: "x".repeat(1024 * 1024) }, ts: Date.now(), peer: IDENTITY }));
	const tooLarge = await waitFor(() => readAnswer(big), "payload_too_large answer");
	assert.equal(tooLarge.error?.code, "payload_too_large");

	step = "fault: crash with a claimed request -> outcome_unknown after restart";
	pi.child.kill("SIGSTOP");
	const lost = randomUUID();
	writeFileSync(path.join(dir("inflight"), `${lost}.json`), JSON.stringify({ id: lost, type: "tick_plan_task", payload: { taskId: tasks.result.tasks[1].id }, ts: Date.now(), peer: IDENTITY }), { mode: 0o600 });
	await stopPi(pi, "SIGKILL");
	// A fresh presence from the killed pid would make the restart passive; wait out the 5 s TTL.
	await sleep(5_500);
	pi = startPi();
	const recovered = await waitFor(() => readAnswer(lost), "restart recovery answer", 20_000);
	assert.equal(recovered.error?.code, "outcome_unknown");
	assert.deepEqual(readdirSync(dir("inflight")), []);
	// The in-memory Build lease does not survive the restart.
	assert.equal(client.holdsBuildLease(project, IDENTITY), false, "a restart must release the Build lease");
	// ponytail: plan/progress survival is not asserted. Pi writes no session file until the
	// first assistant message and this e2e makes no model calls, so the restart starts a new
	// session with no saved plan (traps.md, Pi ↔ harness bridge). Assert it once bridge
	// plan state is durable without an assistant message.

	step = "no model calls";
	assert.equal(modelCalls, 0);
	console.log("bridge e2e passed");
} catch (error) {
	console.error(`bridge e2e failed during: ${step}`);
	console.error(error instanceof Error ? error.stack : String(error));
	if (pi?.stderr) console.error(`--- Pi stderr (tail) ---\n${pi.stderr}`);
	process.exitCode = 1;
} finally {
	await stopPi(pi);
	await new Promise((resolve) => modelServer.close(resolve));
	rmSync(root, { recursive: true, force: true });
	clearTimeout(timeout);
}
