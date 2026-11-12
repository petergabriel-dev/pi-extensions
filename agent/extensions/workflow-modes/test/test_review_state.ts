import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { openAttempt } from "../review-capture.js";
import { buildEvidenceBundle, writeEvidenceBundle } from "../review-bundle.js";
import type { ReviewEvent } from "../review-store.js";
import {
	citedBundleIds,
	deriveTaskReviewState,
	foldFindings,
	MAX_FINDING_REFS,
	MAX_FINDING_TEXT,
	validateFindingInput,
	validateFindingReferences,
	type ReviewStateInput,
} from "../review-state.js";

console.log("Running test_review_state...");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-state-"));
const agentDir = path.join(root, "agent");
const repo = path.join(root, "repo");
await fs.mkdir(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
await fs.writeFile(path.join(repo, "src.ts"), "line one\nline two\nline three\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
const base = git("rev-parse", "HEAD");
await fs.writeFile(path.join(repo, "src.ts"), "line one\nline two changed\nline three\nline four\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "task");
const head = git("rev-parse", "HEAD");

const valid = { planId: "plan-1", taskId: "task-1", commit: head.slice(0, 10), file: "src.ts", line: 2, severity: "high", text: "off by one", evidenceRefs: [] as string[] };

try {
	// Schema and caps.
	assert.deepEqual(validateFindingInput(valid), { ...valid, commit: head.slice(0, 10) });
	for (const [label, change, message] of [
		["extra field", { classification: "verified" }, /unsupported field/],
		["text cap", { text: "x".repeat(MAX_FINDING_TEXT + 1) }, /exceeds/],
		["fix cap", { fix: "x".repeat(MAX_FINDING_TEXT + 1) }, /fix exceeds/],
		["repro cap", { repro: "x".repeat(MAX_FINDING_TEXT + 1) }, /repro exceeds/],
		["empty text", { text: "  " }, /text must be/],
		["ref cap", { evidenceRefs: Array.from({ length: MAX_FINDING_REFS + 1 }, (_, index) => `r${index}`) }, /evidenceRefs/],
		["severity", { severity: "critical" }, /severity/],
		["plan id", { planId: "../p" }, /planId/],
		["task id", { taskId: "" }, /taskId/],
		["commit", { commit: "zzz" }, /hexadecimal/],
		["absolute file", { file: "/etc/passwd" }, /relative/],
		["dotdot file", { file: "a/../../b" }, /relative/],
		["line zero", { line: 0 }, /positive integer/],
		["line without file", { file: undefined }, /requires file/],
	] as const) {
		assert.throws(() => validateFindingInput({ ...valid, ...change }), message, label);
	}

	// References against git and stored bundles.
	const attempt = openAttempt({ attemptId: "a1", sessionId: "s1", planId: "plan-1", taskId: "task-1", startedAt: 0 });
	attempt.baseline = base;
	attempt.commands.push({ cmd: "npm test", exit: 1, ms: 1, tail: "fail" });
	const bundle = await buildEvidenceBundle({ cwd: repo, planId: "plan-1", taskId: "task-1", by: "pi", commit: head, attempt, env: {} });
	const { bundleId } = await writeEvidenceBundle(agentDir, "s1", bundle);
	const otherTask = await writeEvidenceBundle(agentDir, "s1", { ...bundle, taskId: "task-2" });
	const context = { cwd: repo, agentDir, sessionId: "s1" };
	const ok = await validateFindingReferences(validateFindingInput({ ...valid, evidenceRefs: [`${bundleId}#commands/0`, `${bundleId}#hunks/0`, `${head.slice(0, 8)}:src.ts:4`] }), context);
	assert.equal(ok.commit, head, "commit resolves to the full SHA");
	for (const [label, change, message] of [
		["unknown commit", { commit: "deadbeefdeadbeef" }, /not a commit/],
		["missing file", { file: "nope.ts" }, /does not exist/],
		["line past end", { line: 5 }, /beyond the end/],
		["line valid only at head", { commit: base, line: 4 }, /beyond the end/],
		["missing bundle", { evidenceRefs: [`${"0".repeat(64)}#commands/0`] }, /does not exist/],
		["missing record", { evidenceRefs: [`${bundleId}#commands/3`] }, /record commands\/3 does not exist/],
		["other task bundle", { evidenceRefs: [`${otherTask.bundleId}#commands/0`] }, /different task/],
		["code ref bad line", { evidenceRefs: [`${head}:src.ts:99`] }, /beyond the end/],
		["code ref traversal", { evidenceRefs: [`${head}:../x:1`] }, /must be/],
		["malformed ref", { evidenceRefs: ["see the logs"] }, /must be/],
	] as const) {
		await assert.rejects(() => validateFindingReferences(validateFindingInput({ ...valid, ...change }), context), message, label);
	}

	// Fold: Pi-controlled classification and valid transitions only.
	const finding = (id: string, extra: Record<string, unknown> = {}): ReviewEvent => ({ ev: "finding_submitted", at: 1, id, ...valid, commit: head, by: "cursor:c1", ...extra });
	const events: ReviewEvent[] = [
		finding("F1", { evidenceRefs: [`${bundleId}#commands/0`] }),
		finding("F2"),
		finding("F3"),
		finding("F4"),
		finding("F5", { classification: "verified" }),
		finding("F1", { text: "duplicate id ignored" }),
		{ ev: "finding_approved", at: 2, id: "F1", classification: "verified" },
		{ ev: "finding_approved", at: 2, id: "F2", classification: "verified" },
		{ ev: "finding_rejected", at: 2, id: "F3" },
		{ ev: "finding_resolved", at: 3, id: "F4", by: "codex:x" },
		{ ev: "finding_resolved", at: 3, id: "F1", by: "codex:x", commit: head },
		{ ev: "finding_approved", at: 4, id: "F3" },
	];
	const folded = foldFindings(events);
	assert.deepEqual([...folded.values()].map((item) => [item.id, item.status, item.classification]), [
		["F1", "resolved", "verified"],
		["F2", "approved", "suspected"],
		["F3", "rejected", "suspected"],
		["F4", "open", "suspected"],
	], "verified needs a ref; resolve needs approval; rejected stays rejected; malformed stored findings are dropped");
	assert.equal(folded.get("F1")?.text, "off by one");
	assert.deepEqual([...citedBundleIds(folded.values())], [], "resolved findings release their bundles");
	assert.deepEqual([...citedBundleIds(foldFindings(events.slice(0, 7)).values())], [bundleId], "approved findings keep cited bundles");

	// Derived review state table.
	const ev = (event: Partial<ReviewEvent> & { ev: ReviewEvent["ev"] }): ReviewEvent => ({ at: 1, planId: "plan-1", taskId: "task-1", ...event } as ReviewEvent);
	const submitted = (id: string) => ev({ ev: "finding_submitted", id, ...valid, commit: head });
	const state = (partial: Partial<ReviewStateInput>) => deriveTaskReviewState({ planId: "plan-1", taskId: "task-1", ticked: true, events: [], plans: [], ...partial });
	const bundled = ev({ ev: "bundle_created", bundleId });
	const rework = (planId: string, ticked: boolean, findings: string[]) => ({ planId, tasks: [{ id: `${planId}-t`, ticked, findings }] });
	assert.equal(state({ ticked: false, events: [bundled] }).state, "not_ready");
	assert.deepEqual(state({ events: [bundled] }), { state: "ready", rounds: 0, reworkPlans: [], findings: [], bundleId });
	assert.equal(state({ events: [bundled, ev({ ev: "review_started" })] }).state, "in_review");
	assert.equal(state({ events: [bundled, submitted("F1")] }).state, "in_review");
	const approvedF1 = [bundled, submitted("F1"), ev({ ev: "finding_approved", id: "F1" })];
	assert.equal(state({ events: approvedF1 }).state, "changes_requested");
	assert.deepEqual(state({ events: approvedF1, plans: [rework("plan-2", false, ["F1"])] }), { state: "rework_in_progress", rounds: 1, reworkPlans: ["plan-2"], findings: ["F1"], bundleId });
	assert.equal(state({ events: approvedF1, plans: [rework("plan-2", true, ["F1"])] }).state, "re_review_required");
	const resolved = [...approvedF1, ev({ ev: "finding_resolved", id: "F1" })];
	assert.equal(state({ events: resolved, plans: [rework("plan-2", true, ["F1"])] }).state, "in_review", "resolved but not yet human-approved");
	const approvedTask = [...resolved, ev({ ev: "task_approved" })];
	assert.equal(state({ events: approvedTask }).state, "approved");
	assert.equal(state({ events: [...approvedTask, submitted("F2")] }).state, "in_review", "a finding after approval reopens review");
	assert.equal(state({ events: [...approvedTask, submitted("F2"), ev({ ev: "finding_approved", id: "F2" }), ev({ ev: "finding_resolved", id: "F2" })] }).state, "in_review", "settling a later finding still needs a new task approval");
	assert.equal(state({ events: approvedF1, plans: [{ planId: "plan-2", tasks: [{ id: "a", ticked: true, findings: ["F1"] }, { id: "b", ticked: false, findings: ["F1"] }] }] }).state, "rework_in_progress", "re-review waits for every rework task");
	assert.equal(state({ events: approvedF1, plans: [{ planId: "plan-2", tasks: [{ id: "a", ticked: false, findings: ["F1"] }, { id: "b", ticked: false, findings: ["F1"] }] }] }).rounds, 1, "two tasks in one rework plan are one round");
	assert.equal(state({ events: [bundled, submitted("F1"), ev({ ev: "task_approved" })] }).state, "in_review", "approval needs every finding settled");
	assert.equal(state({ events: approvedF1, plans: [rework("plan-2", true, ["F1"]), rework("plan-3", false, ["F1"]), rework("plan-4", false, ["F9"])] }).rounds, 2, "rounds count distinct rework plans citing this task's findings");
	assert.equal(state({ events: [ev({ ev: "finding_submitted", id: "F1", ...valid, taskId: "task-9", commit: head }), ev({ ev: "finding_approved", id: "F1" })] }).state, "ready", "other tasks' findings do not count");

	// Session GC through the real extension: an old uncited bundle is kept while the
	// review log has a damaged line, and deleted once the log reads cleanly.
	const gcAgentDir = path.join(root, "gc-agent");
	const evidence = path.join(gcAgentDir, "plans", "session-gc", "evidence");
	await fs.mkdir(evidence, { recursive: true });
	const stale = path.join(evidence, `${"a".repeat(64)}.json`);
	await fs.writeFile(stale, "{}");
	const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	await fs.utimes(stale, old, old);
	const logPath = path.join(gcAgentDir, "plans", "session-gc", "reviews.jsonl");
	await fs.writeFile(logPath, '{"ev":"finding_submitted","pla\n', { mode: 0o600 });
	const stubs = path.join(root, "stubs");
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
	const source = `
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import workflowModesExtension from "./index.ts";
const handlers = new Map();
const pi = { events: { on() {}, emit() {} }, on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, registerTool() {}, appendEntry() {}, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const ctx = { cwd: process.cwd(), hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => "session-gc" }, ui: { setStatus() {}, notify() {} } };
(async () => {
	await handlers.get("session_start")({}, ctx);
	assert.equal(existsSync(${JSON.stringify(stale)}), true, "damaged review log keeps every bundle");
	writeFileSync(${JSON.stringify(logPath)}, "");
	await handlers.get("session_start")({}, ctx);
	assert.equal(existsSync(${JSON.stringify(stale)}), false, "old uncited bundle is collected");
	assert.equal(existsSync(${JSON.stringify(logPath)}), true, "reviews.jsonl is never deleted");
})().catch((error) => { console.error(error); process.exit(1); });
`;
	await promisify(execFile)("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: gcAgentDir },
	});
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log("test_review_state passed");
