import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

// /review through the real extension with a scripted fake UI: only a live, literal-true
// confirm records a decision; verified needs a reference; state is re-checked after the
// confirm; headless writes nothing; round 3 warns.
console.log("Running test_review_command...");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-command-"));
const repo = path.join(root, "repo");
await fs.mkdir(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
await fs.writeFile(path.join(repo, "src.ts"), "one\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
await fs.writeFile(path.join(repo, "src.ts"), "one\ntwo\nthree\n");
git("add", "-A");
git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "task");
const taskCommit = git("rev-parse", "HEAD");

const stubs = path.join(root, "stubs");
await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
const agentDir = path.join(root, "agent");

const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import workflowModesExtension, { composeWorkflowPrompt, flushReviewCapture } from "./index.ts";
import { appendReviewEvent } from "./review-store.ts";
import { foldFindings } from "./review-state.ts";
const TASK = ${JSON.stringify(taskCommit)};
const AGENT = ${JSON.stringify(agentDir)};
const branch = [];
const listeners = new Map();
const events = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); } };
const handlers = new Map();
const commands = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); }, registerTool() {}, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const notes = [];
const dialogs = [];
let selectAnswer;
let confirmAnswer;
let onConfirm;
const ui = {
	setStatus() {},
	notify(message, level) { notes.push({ message, level }); },
	async select(title, options) { dialogs.push({ kind: "select", title, options }); return typeof selectAnswer === "function" ? selectAnswer(options) : selectAnswer; },
	async confirm(title, body) { dialogs.push({ kind: "confirm", title, body }); if (onConfirm) await onConfirm(); if (confirmAnswer instanceof Error) throw confirmAnswer; return confirmAnswer; },
};
const interactive = { cwd: ${JSON.stringify(repo)}, hasUI: true, sessionManager: { getBranch: () => branch, getSessionId: () => "session-r" }, ui };
const headless = { ...interactive, hasUI: false };
const review = (args, ctx = interactive) => commands.get("review").handler(args, ctx);
const request = (name, payload) => new Promise((resolve) => { events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); }); events.emit(name, payload); });
let n = 0;
const id = () => "req-" + (++n);
const log = () => { try { return readFileSync(AGENT + "/plans/session-r/reviews.jsonl", "utf8").trim().split("\\n").map((line) => JSON.parse(line)); } catch { return []; } };
const decisions = () => log().filter((event) => ["finding_approved", "finding_rejected", "task_approved"].includes(event.ev));
const status = (findingId) => foldFindings(log()).get(findingId);
const lastNote = () => notes.at(-1)?.message ?? "";

(async () => {
	assert.ok(composeWorkflowPrompt("plan", false).includes("**Findings:** F1, F3"), "Plan prompt tells rework tasks to cite findings");
	await handlers.get("session_start")({}, interactive);
	await request("workflow-modes:save-plan", { requestId: id(), planId: "plan-a", plan: "# A\\n\\n## Section 4 — Tasks\\n- [ ] Alpha\\n- [ ] Beta\\n" });
	const alpha = await request("workflow-modes:tick-plan-task", { requestId: id(), title: "Alpha", commit: TASK, by: "claude:builder" });
	const beta = await request("workflow-modes:tick-plan-task", { requestId: id(), title: "Beta", commit: TASK, by: "claude:builder" });
	await flushReviewCapture();
	const tasks = await request("workflow-modes:get-plan-tasks", { requestId: id() });
	const alphaId = tasks.tasks.find((task) => task.title === "Alpha").id;
	const betaId = tasks.tasks.find((task) => task.title === "Beta").id;
	const base = { planId: "plan-a", taskId: alphaId, commit: TASK, severity: "medium" };
	const submit = (findings) => request("workflow-modes:review-submit", { requestId: id(), findings, reviewer: "cursor:rev" });
	assert.deepEqual((await submit([
		{ ...base, text: "with ref \\u202e reversed", file: "src.ts", line: 2, evidenceRefs: [alpha.bundle.id + "#hunks/0"] },
		{ ...base, text: "no refs" },
		{ ...base, text: "will change during confirm" },
		{ ...base, text: "to reject" },
		{ ...base, text: "round three" },
	])).ids, ["F1", "F2", "F3", "F4", "F5"]);
	assert.deepEqual((await submit([{ ...base, taskId: betaId, text: "beta finding" }])).ids, ["F6"]);

	// Headless: never records, explains instead.
	for (const args of ["approve F1", "reject F1", "approve-task " + betaId]) {
		await review(args, headless);
		assert.match(lastNote(), /requires interactive Pi; nothing was recorded/);
	}
	assert.equal(dialogs.length, 0);
	assert.equal(decisions().length, 0);

	// Decline, non-true answers, and dialog errors record nothing.
	selectAnswer = "Approve as verified";
	for (const answer of [false, "yes", 1, undefined, new Error("dialog closed")]) {
		confirmAnswer = answer;
		await review("approve F1");
		assert.equal(decisions().length, 0, "confirm answer " + String(answer) + " must not approve");
		assert.match(lastNote(), /F1 was not approved/, "a declined or failed dialog reports a clean refusal");
	}

	// Verified needs a reference: F2 has none, so only suspected is offered.
	selectAnswer = (options) => options.at(-1);
	confirmAnswer = true;
	await review("approve F2");
	assert.deepEqual(dialogs.filter((dialog) => dialog.kind === "select").at(-1).options, ["Approve as suspected"]);
	assert.match(dialogs.at(-1).body, /Approve as verified is unavailable/);
	assert.deepEqual([status("F2").status, status("F2").classification], ["approved", "suspected"]);

	// F1: verified with a checking reference; the dialog shows sanitized text, refs, and the hunk excerpt.
	selectAnswer = "Approve as verified";
	await review("approve f1");
	const f1Dialog = dialogs.at(-1);
	assert.equal(f1Dialog.title, "Approve F1 as verified?");
	assert.ok(f1Dialog.body.includes("\\\\u202E") && !f1Dialog.body.includes("\\u202e"), "bidi control is escaped");
	assert.ok(f1Dialog.body.includes(alpha.bundle.id + "#hunks/0") && f1Dialog.body.includes("+two"), "references and hunk excerpt shown");
	assert.deepEqual([status("F1").status, status("F1").classification], ["approved", "verified"]);
	assert.equal(decisions().at(-1).by, "human");

	// A verifiable finding approved as suspected stays suspected.
	assert.deepEqual((await submit([{ ...base, text: "verifiable but suspected", evidenceRefs: [alpha.bundle.id + "#hunks/0"] }])).ids, ["F7"]);
	selectAnswer = "Approve as suspected";
	await review("approve F7");
	assert.deepEqual(dialogs.filter((dialog) => dialog.kind === "select").at(-1).options, ["Approve as verified", "Approve as suspected"]);
	assert.equal(decisions().at(-1).classification, "suspected");
	assert.equal(status("F7").classification, "suspected");

	// Re-check after confirm: a change during the dialog means nothing is recorded.
	selectAnswer = "Approve as suspected";
	onConfirm = () => appendReviewEvent(AGENT, "session-r", { ev: "finding_rejected", id: "F3", by: "other" });
	await review("approve F3");
	onConfirm = undefined;
	assert.match(lastNote(), /changed while you were confirming/);
	assert.equal(status("F3").status, "rejected");
	assert.equal(decisions().filter((event) => event.ev === "finding_approved" && event.id === "F3").length, 0, "no approval is recorded after the re-check fails");

	// Reject; deciding a non-open finding is refused.
	await review("reject F4");
	assert.equal(status("F4").status, "rejected");
	await review("reject F4");
	assert.match(lastNote(), /is rejected; only open findings/);

	// Round warning from the third rework round, naming earlier rework plans.
	await request("workflow-modes:save-plan", { requestId: id(), planId: "plan-b", plan: "# B\\n\\n## Section 4 — Tasks\\n- [ ] Fix F1\\n  - **Findings:** F1\\n" });
	await request("workflow-modes:save-plan", { requestId: id(), planId: "plan-c", plan: "# C\\n\\n## Section 4 — Tasks\\n- [ ] Fix F2\\n  - **Findings:** F2\\n" });
	await review("approve F5");
	assert.match(dialogs.at(-1).body, /! Rework round 3 for .*earlier rework plans: plan-b, plan-c/);

	// approve-task: refused with unsettled findings; approved once settled; then a no-op.
	await review("approve-task " + alphaId);
	assert.match(lastNote(), /still has unsettled findings: F1 \\(approved\\)/);
	await review("approve-task " + betaId);
	assert.match(lastNote(), /F6 \\(open\\)/);
	selectAnswer = undefined;
	await review("reject F6");
	confirmAnswer = false;
	await review("approve-task " + betaId);
	assert.equal(decisions().filter((event) => event.ev === "task_approved").length, 0, "declined task approval records nothing");
	confirmAnswer = true;
	await review("approve-task plan-a/" + betaId);
	assert.deepEqual(decisions().filter((event) => event.ev === "task_approved").map((event) => [event.planId, event.taskId, event.by]), [["plan-a", betaId, "human"]]);
	await review("approve-task " + betaId);
	assert.match(lastNote(), /already approved/);
	await review("approve-task task-nope");
	assert.match(lastNote(), /No ticked task/);

	// List works headless and writes nothing.
	const before = log().length;
	await review("", headless);
	assert.match(lastNote(), /Unresolved findings:[\\s\\S]*F1 \\[medium\\] approved\\/verified/);
	assert.equal(log().length, before);
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

console.log("test_review_command passed");
