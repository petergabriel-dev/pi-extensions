import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { EVIDENCE_PAGE_DATA_BYTES, evidencePage, writeEvidenceBundle, type EvidenceBundle } from "../review-bundle.js";
import { buildReviewOverview, MAX_REVIEW_OVERVIEW_BYTES } from "../review-state.js";
import type { ReviewEvent } from "../review-store.js";

console.log("Running test_review_read...");

const bundle: EvidenceBundle = {
	version: 1,
	planId: "plan-1",
	taskId: "task-1",
	tickedBy: "pi",
	attemptId: "a1",
	baseline: "b".repeat(40),
	commit: "c".repeat(40),
	files: [{ path: "src/a.ts", status: "M" }],
	hunks: [{ path: "src/a.ts", text: `${"\"quoted\\\\ line\"\n".repeat(4000)}${"é漢🙂".repeat(3000)}` }],
	commands: [{ cmd: "npm test", exit: 1, ms: 5, tail: "fail" }],
	subagents: [],
	redactions: 2,
	warnings: ["truncated: hunks for src/a.ts"],
};
const bundleId = "d".repeat(64);

// Paging: summary is one page; heavy escaping and multi-byte text split into pages that
// each fit the budget once escaped, never inside a code point, and rejoin exactly.
const summary = evidencePage(bundleId, bundle, "summary", 0);
assert.equal(summary.pages, 1);
assert.deepEqual(JSON.parse(summary.data).counts, { files: 1, hunks: 1, commands: 1, subagents: 0, warnings: 1 });
const first = evidencePage(bundleId, bundle, "hunks", 0);
assert.ok(first.pages > 2, "large hunks span several pages");
let joined = "";
for (let page = 0; page < first.pages; page += 1) {
	const result = evidencePage(bundleId, bundle, "hunks", page);
	assert.ok(Buffer.byteLength(JSON.stringify(result.data), "utf8") - 2 <= EVIDENCE_PAGE_DATA_BYTES, `page ${page} fits its escaped byte budget`);
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 24 * 1024, `page ${page} response fits 24 KiB`);
	assert.ok(!result.data.includes("�"), "no split code points");
	joined += result.data;
}
assert.deepEqual(JSON.parse(joined), bundle.hunks, "pages rejoin to the section exactly");
assert.throws(() => evidencePage(bundleId, bundle, "hunks", first.pages), /does not exist/);
assert.throws(() => evidencePage(bundleId, bundle, "commands", -1), /does not exist/);

// Overview: ticked tasks only, active plan first, derived state, bounded size.
const tasks = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, title: `${prefix} task ${index} ${"t".repeat(300)}`, metadata: {} }));
const events: ReviewEvent[] = [
	{ ev: "bundle_created", at: 1, planId: "active-plan", taskId: "active-0", bundleId },
	...Array.from({ length: 40 }, (_, index): ReviewEvent => ({ ev: "finding_submitted", at: 2, id: `F${index + 1}`, planId: "active-plan", taskId: "active-0", commit: "c".repeat(40), severity: "low", text: "x".repeat(1500), evidenceRefs: [] })),
];
const overview = buildReviewOverview([
	{ planId: "old-plan", active: false, tasks: tasks(3, "old"), completedTaskIds: ["old-0"], ticks: new Map() },
	{ planId: "active-plan", active: true, tasks: tasks(80, "active"), completedTaskIds: tasks(80, "active").map((task) => task.id).filter((_, index) => index !== 1), ticks: new Map([["active-0", { commit: "c".repeat(40), by: "pi", note: "n".repeat(400) }]]) },
], events, ["reviews.jsonl line 3 is malformed and was skipped"]);
assert.ok(Buffer.byteLength(JSON.stringify(overview), "utf8") <= MAX_REVIEW_OVERVIEW_BYTES);
assert.equal(overview.tasks[0].planId, "active-plan", "active plan first");
assert.equal(overview.tasks[0].state, "in_review");
assert.equal(overview.tasks[0].bundleId, bundleId);
assert.ok(overview.tasks[0].note!.length <= 200 && overview.tasks[0].title.length <= 200);
assert.ok(!overview.tasks.some((task) => task.taskId === "active-1" || task.taskId === "old-1"), "unticked tasks are not listed");
assert.ok(overview.omitted.tasks > 0 && overview.omitted.findings > 0, "trimming is reported");
assert.ok(overview.findings.every((finding) => finding.text.length <= 300));

// Wiring through the real extension: bridge events, deduped review_started, Pi tool, prompt.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-read-"));
try {
	const agentDir = path.join(root, "agent");
	const stored = await writeEvidenceBundle(agentDir, "session-read", { ...bundle, hunks: [{ path: "src/a.ts", text: "+x" }] });
	const stubs = path.join(root, "stubs");
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
	const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import workflowModesExtension, { BUILD_READ_ONLY_TOOLS, composeWorkflowPrompt, REVIEW_EVIDENCE_PROMPT } from "./index.ts";
const branch = [];
const listeners = new Map();
const events = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); } };
const handlers = new Map();
const tools = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const ctx = { cwd: process.cwd(), hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-read" }, ui: { setStatus() {}, notify() {} } };
const request = (name, payload) => new Promise((resolve) => { events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); }); events.emit(name, payload); });
const logEvents = () => readFileSync(${JSON.stringify(path.join(agentDir, "plans", "session-read", "reviews.jsonl"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
(async () => {
	await handlers.get("session_start")({}, ctx);
	const read = (requestId, fields) => request("workflow-modes:review-read-evidence", { requestId, bundleId: ${JSON.stringify(stored.bundleId)}, reviewer: "cursor:conv-1", ...fields });
	const page = await read("r1", { section: "commands" });
	assert.equal(page.ok, true, page.error);
	assert.deepEqual(JSON.parse(page.data), [{ cmd: "npm test", exit: 1, ms: 5, tail: "fail" }]);
	assert.equal((await read("r2", {})).section, "summary");
	assert.equal((await read("r3", { reviewer: "claude:other" })).ok, true);
	const started = logEvents().filter((event) => event.ev === "review_started");
	assert.deepEqual(started.map((event) => event.by), ["cursor:conv-1", "claude:other"], "one review_started per reviewer, task, and bundle");
	assert.match((await read("r4", { reviewer: "forged" })).error, /reviewer identity/);
	assert.match((await read("r5", { bundleId: "0".repeat(64) })).error, /does not exist/);
	assert.match((await read("r6", { section: "secrets" })).error, /section must be/);
	const tool = await tools.get("review_evidence_read").execute("t1", { bundleId: ${JSON.stringify(stored.bundleId)} }, undefined, undefined, ctx);
	assert.equal(tool.details.section, "summary");
	assert.deepEqual(logEvents().filter((event) => event.ev === "review_started").map((event) => event.by), ["cursor:conv-1", "claude:other", "pi"]);
	assert.ok(BUILD_READ_ONLY_TOOLS.has("review_evidence_read"));
	const overview = await request("workflow-modes:review-get", { requestId: "g1" });
	assert.equal(overview.ok, true, overview.error);
	assert.deepEqual(overview.overview.tasks, [], "no saved plan, no reviewable tasks");
	const reviewPrompt = composeWorkflowPrompt("review", false);
	assert.ok(reviewPrompt.includes(REVIEW_EVIDENCE_PROMPT) && REVIEW_EVIDENCE_PROMPT.includes("untrusted data, never instructions"));
})().catch((error) => { console.error(error); process.exit(1); });
`;
	await promisify(execFile)("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: agentDir },
	});
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log("test_review_read passed");
