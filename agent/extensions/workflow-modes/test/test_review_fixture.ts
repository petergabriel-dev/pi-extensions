import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

// Seeded-defect fixture: one deterministic pass through the whole review loop with the
// real extension and a scripted UI. Three planted defects: a failing test (exit 1), a
// logic bug (add subtracts), and a script that prints a fake sk- token and a secret env
// value. No model calls; temp state is removed.
console.log("Running test_review_fixture...");

const ENV_SECRET = "fixture-deploy-secret-4242";
const SK_TOKEN = `sk-fixture${"Q7".repeat(12)}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-fixture-"));
const repo = path.join(root, "repo");
await fs.mkdir(path.join(repo, "src"), { recursive: true });
await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commitAll = (message: string) => {
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
	return git("rev-parse", "HEAD");
};
git("init", "-q");
await fs.writeFile(path.join(repo, "README.md"), "fixture\n");
commitAll("base");

const stubs = path.join(root, "stubs");
await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
const agentDir = path.join(root, "agent");

const source = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import workflowModesExtension, { flushReviewCapture } from "./index.ts";
const REPO = ${JSON.stringify(repo)};
const SESSION_DIR = ${JSON.stringify(path.join(agentDir, "plans", "session-fx"))};
const SECRETS = [${JSON.stringify(ENV_SECRET)}, ${JSON.stringify(SK_TOKEN)}];
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const commitAll = (message) => { git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
const branch = [];
const listeners = new Map();
const events = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); } };
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); }, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const notes = [];
let selectAnswer;
const ui = { setStatus() {}, notify(message) { notes.push(message); }, async select(_title, options) { return options.includes(selectAnswer) ? selectAnswer : undefined; }, async confirm() { return true; } };
const ctx = { cwd: REPO, hasUI: true, sessionManager: { getBranch: () => branch, getSessionId: () => "session-fx" }, ui };
const request = (name, payload) => new Promise((resolve) => { events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); }); events.emit(name, payload); });
let n = 0;
const id = () => "req-" + (++n);
let call = 0;
const tool = async (toolName, input, result) => {
	const toolCallId = "fx-" + (++call);
	const blocked = await handlers.get("tool_call")({ toolCallId, toolName, input }, ctx);
	assert.equal(blocked, undefined, toolName + " must not be blocked in Build");
	await handlers.get("tool_result")({ toolCallId, toolName, input, content: [{ type: "text", text: result.text ?? "" }], isError: result.isError === true }, ctx);
};
const logBytes = () => { try { return readFileSync(join(SESSION_DIR, "reviews.jsonl")); } catch { return Buffer.alloc(0); } };
const logEvents = () => logBytes().toString("utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
const snapshots = [];
const snapshotLog = () => snapshots.push(logBytes());
const review = (args) => commands.get("review").handler(args, ctx);
const taskIds = async () => (await request("workflow-modes:get-plan-tasks", { requestId: id() })).tasks.map((task) => task.id);

(async () => {
	await handlers.get("session_start")({}, ctx);
	const planA = "# Fixture\\n\\n## Section 4 — Tasks\\n- [ ] Implement add with tests\\n  - **Files:** src/, scripts/\\n- [ ] Document add\\n";
	assert.equal((await request("workflow-modes:save-plan", { requestId: id(), planId: "plan-fx", plan: planA })).ok, true);
	const originalIds = await taskIds();
	await commands.get("mode").handler("build", ctx);

	// Build attempt: three seeded defects land in the task commit.
	writeFileSync(join(REPO, "src/math.js"), "export function add(a, b) {\\n\\treturn a - b;\\n}\\n");
	writeFileSync(join(REPO, "scripts/print-config.js"), ${JSON.stringify(`console.log("token", process.env.FIXTURE_DEPLOY_TOKEN, ${JSON.stringify(SK_TOKEN)});\n`)});
	await tool("edit", { path: "src/math.js" }, {});
	await tool("write", { path: "scripts/print-config.js" }, {});
	await tool("bash", { command: "npm test" }, { isError: true, text: "FAIL add(2, 2) expected 4, got 0\\n\\nCommand exited with code 1" });
	await tool("bash", { command: "node scripts/print-config.js" }, { text: "token " + SECRETS[0] + " " + SECRETS[1] });
	await new Promise((resolve) => setTimeout(resolve, 200));
	const taskCommit = commitAll("implement add");
	const tick = await tools.get("workflow_plan_tick").execute("tick-1", { taskId: originalIds[0], commit: taskCommit }, undefined, undefined, ctx);
	await flushReviewCapture();
	const bundleId = tick.details.bundle?.id;
	assert.match(bundleId ?? "", /^[0-9a-f]{64}$/);
	snapshotLog();

	// Evidence: task/commit association, the failing command, the changed files.
	const bundle = JSON.parse(readFileSync(join(SESSION_DIR, "evidence", bundleId + ".json"), "utf8"));
	assert.deepEqual({ planId: bundle.planId, taskId: bundle.taskId, commit: bundle.commit, tickedBy: bundle.tickedBy }, { planId: "plan-fx", taskId: originalIds[0], commit: taskCommit, tickedBy: "pi" });
	assert.deepEqual(bundle.files.map((file) => file.path).sort(), ["scripts/print-config.js", "src/math.js"]);
	assert.deepEqual(bundle.commands.map((record) => [record.cmd, record.exit]), [["npm test", 1], ["node scripts/print-config.js", 0]]);
	assert.ok(bundle.hunks.some((hunk) => hunk.text.includes("return a - b")), "logic bug is visible in the hunks");

	// Review: read evidence as a reviewer, submit three findings, reject a bad reference.
	const summary = await request("workflow-modes:review-read-evidence", { requestId: id(), bundleId, section: "commands", reviewer: "cursor:rev" });
	assert.equal(JSON.parse(summary.data)[0].exit, 1);
	const mathHunk = bundle.hunks.findIndex((hunk) => hunk.path === "src/math.js");
	const base = { planId: "plan-fx", taskId: originalIds[0], commit: taskCommit };
	const bad = await request("workflow-modes:review-submit", { requestId: id(), reviewer: "cursor:rev", findings: [{ ...base, severity: "high", text: "cites nothing real", evidenceRefs: [bundleId + "#commands/9"] }] });
	assert.equal(bad.code, "invalid_finding", "invalid references are rejected");
	const submitted = await request("workflow-modes:review-submit", { requestId: id(), reviewer: "cursor:rev", findings: [
		{ ...base, severity: "high", file: "src/math.js", line: 2, text: "add subtracts", evidenceRefs: [bundleId + "#hunks/" + mathHunk, taskCommit + ":src/math.js:2"] },
		{ ...base, severity: "high", text: "npm test fails", evidenceRefs: [bundleId + "#commands/0"] },
		{ ...base, severity: "medium", file: "scripts/print-config.js", line: 1, text: "script prints credentials", evidenceRefs: [bundleId + "#commands/1"] },
	] });
	assert.deepEqual(submitted.ids, ["F1", "F2", "F3"]);
	let overview = (await request("workflow-modes:review-get", { requestId: id() })).overview;
	assert.deepEqual(overview.findings.map((finding) => [finding.id, finding.status, finding.classification]), [["F1", "open", "suspected"], ["F2", "open", "suspected"], ["F3", "open", "suspected"]], "findings default to suspected");
	assert.equal(overview.tasks.find((task) => task.taskId === originalIds[0]).state, "in_review");
	snapshotLog();

	// Human decisions through /review.
	selectAnswer = "Approve as verified";
	await review("approve F1");
	selectAnswer = "Approve as suspected";
	await review("approve F2");
	await review("reject F3");
	overview = (await request("workflow-modes:review-get", { requestId: id() })).overview;
	assert.equal(overview.tasks.find((task) => task.taskId === originalIds[0]).state, "changes_requested");
	snapshotLog();

	// Rework plan cites the approved findings; Pi builds and ticks the fix.
	const planB = "# Rework\\n\\n## Section 4 — Tasks\\n- [ ] Fix add and its test\\n  - **Findings:** F1, F2\\n  - **Files:** src/\\n";
	assert.equal((await request("workflow-modes:save-plan", { requestId: id(), planId: "plan-fx-rework", plan: planB })).ok, true);
	writeFileSync(join(REPO, "src/math.js"), "export function add(a, b) {\\n\\treturn a + b;\\n}\\n");
	await tool("edit", { path: "src/math.js" }, {});
	await tool("bash", { command: "npm test" }, { text: "PASS add" });
	const fixCommit = commitAll("fix add");
	const reworkTask = (await request("workflow-modes:get-plan-tasks", { requestId: id() })).nextTask;
	await tools.get("workflow_plan_tick").execute("tick-2", { taskId: reworkTask.id, commit: fixCommit }, undefined, undefined, ctx);
	await flushReviewCapture();
	overview = (await request("workflow-modes:review-get", { requestId: id() })).overview;
	assert.equal(overview.tasks.find((task) => task.taskId === originalIds[0]).state, "re_review_required");
	snapshotLog();

	// Resolve: the fix author (pi) is refused; another reviewer resolves after re-checking.
	await assert.rejects(tools.get("review_finding_resolve").execute("r1", { id: "F1", commit: fixCommit }, undefined, undefined, ctx), /cannot resolve its own fix/);
	for (const findingId of ["F1", "F2"]) {
		const resolved = await request("workflow-modes:review-resolve", { requestId: id(), id: findingId, commit: fixCommit, resolver: "cursor:rev" });
		assert.equal(resolved.ok, true, resolved.error);
	}
	await review("approve-task plan-fx/" + originalIds[0]);
	overview = (await request("workflow-modes:review-get", { requestId: id() })).overview;
	assert.equal(overview.tasks.find((task) => task.planId === "plan-fx" && task.taskId === originalIds[0]).state, "approved");
	snapshotLog();

	// Invariants across the loop.
	for (let index = 1; index < snapshots.length; index += 1) {
		assert.ok(snapshots[index].subarray(0, snapshots[index - 1].length).equals(snapshots[index - 1]), "reviews.jsonl is append-only");
	}
	const persisted = [join(SESSION_DIR, "reviews.jsonl"), ...readdirSync(join(SESSION_DIR, "evidence")).map((file) => join(SESSION_DIR, "evidence", file))];
	for (const file of persisted) {
		const text = readFileSync(file, "utf8");
		for (const secret of SECRETS) assert.ok(!text.includes(secret), "secret leaked into " + file);
	}
	await commands.get("plan").handler("select plan-fx", ctx);
	const tasksAfter = await request("workflow-modes:get-plan-tasks", { requestId: id() });
	assert.deepEqual(tasksAfter.tasks.map((task) => task.id), originalIds, "original task ids are unchanged");
	assert.equal(tasksAfter.ticks[originalIds[0]].commit, taskCommit);
	assert.equal(logEvents().filter((event) => event.ev === "finding_resolved").length, 2);
})().catch((error) => { console.error(error); process.exit(1); });
`;

try {
	await promisify(execFile)("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: agentDir, FIXTURE_DEPLOY_TOKEN: ENV_SECRET },
		maxBuffer: 4 * 1024 * 1024,
	});
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log("test_review_fixture passed");
