import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

// Finding submit and resolve through the real extension: all-or-nothing validation,
// host-derived identity, and the resolve authority rules.
console.log("Running test_review_write...");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-write-"));
const repo = path.join(root, "repo");
await fs.mkdir(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commitAll = (message: string) => {
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message);
	return git("rev-parse", "HEAD");
};
git("init", "-q");
await fs.writeFile(path.join(repo, "src.ts"), "one\n");
commitAll("base");
await fs.writeFile(path.join(repo, "src.ts"), "one\ntwo\n");
const taskCommit = commitAll("task");
await fs.writeFile(path.join(repo, "src.ts"), "one\ntwo fixed\n");
const fixCommit = commitAll("fix F1");
await fs.writeFile(path.join(repo, "src.ts"), "one\ntwo fixed\nthree\n");
const piFixCommit = commitAll("fix F2 by pi");
const unticked = commitAll("unticked");

const stubs = path.join(root, "stubs");
await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
const agentDir = path.join(root, "agent");

const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import workflowModesExtension, { flushReviewCapture } from "./index.ts";
import { appendReviewEvent } from "./review-store.ts";
const TASK = ${JSON.stringify(taskCommit)};
const FIX = ${JSON.stringify(fixCommit)};
const PI_FIX = ${JSON.stringify(piFixCommit)};
const UNTICKED = ${JSON.stringify(unticked)};
const AGENT = ${JSON.stringify(agentDir)};
const branch = [];
const listeners = new Map();
const events = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); } };
const handlers = new Map();
const tools = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const ctx = { cwd: ${JSON.stringify(repo)}, hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-w" }, ui: { setStatus() {}, notify() {} } };
const request = (name, payload) => new Promise((resolve) => { events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); }); events.emit(name, payload); });
let n = 0;
const id = () => "req-" + (++n);
const save = (planId, plan) => request("workflow-modes:save-plan", { requestId: id(), planId, plan });
const tick = (title, commit, by) => request("workflow-modes:tick-plan-task", { requestId: id(), title, commit, by });
const submit = (findings, reviewer = "cursor:rev") => request("workflow-modes:review-submit", { requestId: id(), findings, reviewer });
const resolve = (findingId, commit, resolver, leaseHolder) => request("workflow-modes:review-resolve", { requestId: id(), id: findingId, commit, resolver, ...(leaseHolder ? { leaseHolder } : {}) });
const log = () => readFileSync(AGENT + "/plans/session-w/reviews.jsonl", "utf8").trim().split("\\n").map((line) => JSON.parse(line));
const submittedCount = () => log().filter((event) => event.ev === "finding_submitted").length;
const approve = (findingId) => appendReviewEvent(AGENT, "session-w", { ev: "finding_approved", id: findingId, classification: "suspected" });

(async () => {
	await handlers.get("session_start")({}, ctx);
	assert.equal((await save("plan-a", "# A\\n\\n## Section 4 — Tasks\\n- [ ] Alpha\\n- [ ] Beta\\n")).ok, true);
	const alphaTick = await tick("Alpha", TASK, "claude:builder");
	assert.equal(alphaTick.ok, true, alphaTick.error);
	await flushReviewCapture();
	const bundleId = alphaTick.bundle.id;
	assert.match(bundleId, /^[0-9a-f]{64}$/);
	const tasks = await request("workflow-modes:get-plan-tasks", { requestId: id() });
	const alphaId = tasks.tasks.find((task) => task.title === "Alpha").id;
	const valid = { planId: "plan-a", taskId: alphaId, commit: TASK.slice(0, 9), file: "src.ts", line: 2, severity: "high", text: "line two is wrong", evidenceRefs: [bundleId + "#files/0", TASK + ":src.ts:2"] };

	// Submit: suspected, host-derived reviewer, store-assigned id.
	const first = await submit([valid]);
	assert.deepEqual({ ok: first.ok, ids: first.ids }, { ok: true, ids: ["F1"] }, first.error);
	const stored = log().find((event) => event.ev === "finding_submitted");
	assert.deepEqual({ by: stored.by, commit: stored.commit, classification: stored.classification }, { by: "cursor:rev", commit: TASK, classification: undefined });

	// All-or-nothing validation; nothing is written on any failure.
	for (const [label, findings, code, message, reviewer] of [
		["bad ref in batch", [valid, { ...valid, evidenceRefs: ["0".repeat(64) + "#files/0"] }], "invalid_finding", /finding 2: evidence bundle/],
		["too many", Array.from({ length: 21 }, () => valid), "invalid_findings", /1-20/],
		["empty", [], "invalid_findings", /1-20/],
		["unknown task", [{ ...valid, taskId: "task-nope" }], "invalid_finding", /not in saved plan/],
		["unknown plan", [{ ...valid, planId: "plan-zz" }], "invalid_finding", /not in saved plan/],
		["payload author", [{ ...valid, by: "codex:forged" }], "invalid_finding", /unsupported field/],
		["payload classification", [{ ...valid, classification: "verified" }], "invalid_finding", /unsupported field/],
		["line past end", [{ ...valid, line: 9 }], "invalid_finding", /beyond the end/],
		["bad reviewer", [valid], "invalid_reviewer", /reviewer identity/, "forged"],
	]) {
		const result = await submit(findings, reviewer);
		assert.equal(result.ok, false, label);
		assert.equal(result.code, code, label);
		assert.match(result.error, message, label);
		assert.equal(submittedCount(), 1, label + " writes nothing");
	}

	// Pi tool submits as "pi"; a payload author is rejected by the tool schema path too.
	const piSubmit = await tools.get("review_findings_submit").execute("t1", { findings: [{ ...valid, text: "pi finding" }] }, undefined, undefined, ctx);
	assert.deepEqual(piSubmit.details.ids, ["F2"]);
	assert.equal(log().filter((event) => event.ev === "finding_submitted").at(-1).by, "pi");
	assert.deepEqual((await submit([{ ...valid, text: "left open" }])).ids, ["F3"]);
	await approve("F1");
	await approve("F2");

	// Rework plans cite findings; the bridge rework tick is by the builder, Pi's by "pi".
	assert.equal((await save("plan-b", "# B\\n\\n## Section 4 — Tasks\\n- [ ] Fix F1\\n  - **Findings:** F1\\n")).ok, true);
	assert.equal((await tick("Fix F1", FIX, "claude:builder")).ok, true);
	assert.equal((await save("plan-c", "# C\\n\\n## Section 4 — Tasks\\n- [ ] Fix F2\\n  - **Findings:** F2\\n")).ok, true);
	await tools.get("workflow_plan_tick").execute("t2", { title: "Fix F2", commit: PI_FIX }, undefined, undefined, ctx);

	for (const [label, args, code] of [
		["fix author after lease release", ["F1", FIX, "claude:builder"], "resolve_by_fix_author"],
		["active lease holder", ["F1", FIX, "cursor:rev", "cursor:rev"], "resolve_by_lease_holder"],
		["commit not ticked", ["F1", UNTICKED, "codex:checker"], "fix_commit_not_ticked"],
		["original task commit is not a fix", ["F1", TASK, "codex:checker"], "fix_commit_not_rework"],
		["fix cites another finding", ["F2", FIX, "codex:checker"], "fix_commit_not_rework"],
		["not approved", ["F3", FIX, "codex:checker"], "finding_not_approved"],
		["unknown finding", ["F99", FIX, "codex:checker"], "unknown_finding"],
		["bad commit", ["F1", "zzz", "codex:checker"], "invalid_commit"],
		["bad resolver", ["F1", FIX, "codex:"], "invalid_reviewer"],
	]) {
		const result = await resolve(...args);
		assert.equal(result.ok, false, label);
		assert.equal(result.code, code, label + ": " + result.error);
	}
	await assert.rejects(tools.get("review_finding_resolve").execute("t3", { id: "F2", commit: PI_FIX }, undefined, undefined, ctx), /cannot resolve its own fix/, "a Pi-built fix cannot be resolved by pi");
	assert.equal(log().filter((event) => event.ev === "finding_resolved").length, 0, "refusals write nothing");

	// Another reviewer resolves; a resolved finding cannot be resolved again.
	const resolved = await resolve("F1", FIX.slice(0, 10), "codex:checker", "claude:builder");
	assert.deepEqual({ ok: resolved.ok, id: resolved.id, commit: resolved.commit }, { ok: true, id: "F1", commit: FIX }, resolved.error);
	assert.equal((await resolve("F2", PI_FIX, "cursor:rev")).ok, true, "an external reviewer may resolve a Pi-built fix");
	assert.equal((await resolve("F1", FIX, "codex:checker")).code, "finding_not_approved");
	assert.deepEqual(log().filter((event) => event.ev === "finding_resolved").map((event) => [event.id, event.by]), [["F1", "codex:checker"], ["F2", "cursor:rev"]]);
})().catch((error) => { console.error(error); process.exit(1); });
`;

try {
	await promisify(execFile)("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: agentDir },
	});
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log("test_review_write passed");
