import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Bridge save-plan dedupe: an identical re-send (new request id after outcome_unknown)
// returns the active plan and writes nothing; Pi-native saves keep their behavior.
const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "bridge-save-plan-"));
const stubs = join(root, "stubs");
await mkdir(join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await mkdir(join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await mkdir(join(stubs, "typebox"), { recursive: true });
await writeFile(join(stubs, "typebox/index.js"), "exports.Type = {};\n");
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import assert from "node:assert/strict";
import workflowModesExtension, { PLAN_ENTRY, setSavedWorkflowPlan } from "./index.ts";

const appended = [];
const branch = [];
const listeners = new Map();
const events = {
	on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
	emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); },
};
const handlers = new Map();
const pi = {
	events,
	on(name, handler) { handlers.set(name, handler); },
	registerCommand() {},
	registerTool() {},
	appendEntry(type, data) {
		appended.push({ type, data });
		if (type === PLAN_ENTRY) branch.push({ type: "custom", customType: type, data });
	},
	sendUserMessage() {},
	sendMessage() {},
};
workflowModesExtension(pi);
const context = { sessionManager: { getBranch: () => branch, getSessionId: () => "session-test" }, ui: { setStatus() {}, notify() {} } };

(async () => {
await handlers.get("session_start")?.({}, context);

const request = (name, payload) => new Promise((resolve) => {
	events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); });
	events.emit(name, payload);
});
// The bridge always sends planId: the caller's, or the request id as fallback.
const save = (requestId, plan, planId = requestId) => request("workflow-modes:save-plan", { requestId, planId, plan });

const text = "# Plan\\n\\n## Section 4 — Tasks\\n- [ ] Seed task\\n";
const first = await save("req-1", text);
assert.equal(first.ok, true);
assert.equal(first.planId, "req-1");
assert.notEqual(first.idempotent, true);

const ticked = await request("workflow-modes:tick-plan-task", { requestId: "tick-1", title: "Seed task", by: "claude:test-peer" });
assert.equal(ticked.ok, true);
const writes = appended.length;

// Re-send after outcome_unknown: new request id, same text -> same plan, no writes, tick kept.
const again = await save("req-2", text);
assert.deepEqual(
	{ ok: again.ok, planId: again.planId, idempotent: again.idempotent, taskCount: again.taskCount, path: again.path },
	{ ok: true, planId: "req-1", idempotent: true, taskCount: 1, path: first.path },
);
assert.equal(appended.length, writes, "identical re-save must write nothing");
const tasks = await request("workflow-modes:get-plan-tasks", { requestId: "tasks-1" });
assert.equal(tasks.planId, "req-1");
assert.deepEqual(tasks.progress, { done: 1, total: 1 });

// Different text -> a new plan.
const changedText = text + "- [ ] Another task\\n";
const changed = await save("req-3", changedText);
assert.equal(changed.planId, "req-3");
assert.notEqual(changed.idempotent, true);

// An explicit, different planId asks for a fresh copy even with identical text.
const copy = await save("req-4", changedText, "fresh-copy");
assert.equal(copy.planId, "fresh-copy");
assert.notEqual(copy.idempotent, true);
// Re-sending that same explicit planId is deduplicated.
const copyAgain = await save("req-5", changedText, "fresh-copy");
assert.equal(copyAgain.planId, "fresh-copy");
assert.equal(copyAgain.idempotent, true);

// Pi-native saves are unchanged: identical text still creates a new plan.
const before = appended.length;
const native = await setSavedWorkflowPlan(pi, context, changedText);
assert.notEqual(native.planId, "fresh-copy");
assert.equal(appended.length, before + 2);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
`;

try {
	await execFileAsync("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: join(root, "agent") },
	});
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("bridge save-plan dedupe assertions passed");
