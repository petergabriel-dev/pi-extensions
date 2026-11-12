import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Tick commit + author: commit is verified against the project repo and stored as a
// full SHA; the author is host-derived; the first tick wins; bad input appends nothing.
console.log("Running test_tick_commit...");
const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "tick-commit-"));
const repo = join(root, "repo");
const notRepo = join(root, "not-repo");
await mkdir(repo, { recursive: true });
await mkdir(notRepo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
const commitFile = async (name: string) => {
	await writeFile(join(repo, name), `${name}\n`);
	git("add", name);
	git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", name);
	return git("rev-parse", "HEAD");
};
const first = await commitFile("a.txt");
const second = await commitFile("b.txt");

const stubs = join(root, "stubs");
await mkdir(join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await mkdir(join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import assert from "node:assert/strict";
import workflowModesExtension, { PLAN_ENTRY } from "./index.ts";

const FIRST = ${JSON.stringify(first)};
const SECOND = ${JSON.stringify(second)};
const appended = [];
const branch = [];
const listeners = new Map();
const events = {
	on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
	emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); },
};
const handlers = new Map();
const tools = new Map();
const pi = {
	events,
	on(name, handler) { handlers.set(name, handler); },
	registerCommand() {},
	registerTool(tool) { tools.set(tool.name, tool); },
	appendEntry(type, data) {
		appended.push({ type, data });
		if (type === PLAN_ENTRY) branch.push({ type: "custom", customType: type, data });
	},
	sendUserMessage() {},
	sendMessage() {},
};
workflowModesExtension(pi);
const context = (cwd) => ({ cwd, hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-test" }, ui: { setStatus() {}, notify() {} } });
const repoContext = context(${JSON.stringify(repo)});

(async () => {
await handlers.get("session_start")?.({}, repoContext);
const request = (name, payload) => new Promise((resolve) => {
	events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); });
	events.emit(name, payload);
});
const saved = await request("workflow-modes:save-plan", { requestId: "save-1", planId: "p1", plan: "# Plan\\n\\n## Section 4 — Tasks\\n- [ ] Alpha\\n- [ ] Beta\\n- [ ] Gamma\\n- [ ] Delta\\n" });
assert.equal(saved.ok, true);
const tick = (requestId, fields) => request("workflow-modes:tick-plan-task", { requestId, ...fields });
const tickWrites = () => appended.filter((item) => item.data?.event === "tick").length;

// Bridge path: short SHA resolves to full SHA; author is the stamped peer.
const alpha = await tick("t1", { title: "Alpha", commit: FIRST.slice(0, 7).toUpperCase(), by: "claude:peer-1" });
assert.equal(alpha.ok, true, alpha.error);
assert.equal(alpha.commit, FIRST);
assert.equal(alpha.by, "claude:peer-1");
const alphaEntry = appended.at(-1).data;
assert.deepEqual({ commit: alphaEntry.commit, by: alphaEntry.by }, { commit: FIRST, by: "claude:peer-1" }, "durable tick entry stores full SHA and author");

// Re-tick: first commit and author win; nothing is appended.
const writes = tickWrites();
const again = await tick("t2", { title: "Alpha", commit: SECOND, by: "codex:other" });
assert.equal(again.ok, true);
assert.equal(again.idempotent, true);
assert.deepEqual({ commit: again.commit, by: again.by }, { commit: FIRST, by: "claude:peer-1" });
assert.equal(tickWrites(), writes);

// Invalid input appends nothing.
for (const [label, fields, message] of [
	["bad format", { title: "Beta", commit: "xyz", by: "claude:peer-1" }, /hexadecimal/],
	["too short", { title: "Beta", commit: "abc12", by: "claude:peer-1" }, /hexadecimal/],
	["unknown sha", { title: "Beta", commit: "deadbeefdeadbeef", by: "claude:peer-1" }, /not a commit/],
	["missing author", { title: "Beta", commit: SECOND }, /tick author is invalid/],
	["malformed author", { title: "Beta", by: "claude:" }, /tick author is invalid/],
	["option-like commit", { title: "Beta", commit: "--output=x", by: "claude:peer-1" }, /hexadecimal/],
]) {
	const result = await tick("bad-" + label, fields);
	assert.equal(result.ok, false, label);
	assert.match(result.error, message, label);
	assert.equal(tickWrites(), writes, label + " must append nothing");
}

// A tick without a commit stays valid.
const beta = await tick("t3", { title: "Beta", by: "cursor:conv-1" });
assert.equal(beta.ok, true);
assert.equal(beta.commit, undefined);
assert.equal(beta.by, "cursor:conv-1");

// Pi tool path: author is always "pi"; a payload author is rejected.
const tickTool = tools.get("workflow_plan_tick");
await assert.rejects(tickTool.execute("forged", { title: "Gamma", by: "claude:peer-1" }, undefined, undefined, repoContext), /only taskId, title, note, and commit/);
const gamma = await tickTool.execute("gamma", { title: "Gamma", commit: SECOND }, undefined, undefined, repoContext);
assert.equal(gamma.details.by, "pi");
assert.equal(gamma.details.commit, SECOND);
assert.match(gamma.content[0].text, new RegExp("Commit: " + SECOND.slice(0, 12)));

// Outside a git repository the commit cannot be verified.
await assert.rejects(tickTool.execute("non-repo", { title: "Delta", commit: FIRST }, undefined, undefined, context(${JSON.stringify(notRepo)})), /not a commit/);
assert.equal(branch.filter((entry) => entry.data?.event === "tick" && entry.data.taskId && entry.data.commit === FIRST).length, 1);

// Tracker read exposes per-task note/commit/author.
const tasks = await request("workflow-modes:get-plan-tasks", { requestId: "tasks-1" });
assert.equal(tasks.ok, true);
const byTitle = Object.fromEntries(tasks.tasks.map((task) => [task.title, task.id]));
assert.deepEqual(tasks.ticks[byTitle.Alpha], { commit: FIRST, by: "claude:peer-1" });
assert.deepEqual(tasks.ticks[byTitle.Beta], { by: "cursor:conv-1" });
assert.deepEqual(tasks.ticks[byTitle.Gamma], { commit: SECOND, by: "pi" });
assert.equal(tasks.ticks[byTitle.Delta], undefined);
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

console.log("test_tick_commit passed");
