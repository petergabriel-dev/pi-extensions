import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	abandonedSummary,
	attemptWarnings,
	MAX_COMMAND_RECORDS,
	MAX_PENDING_TOOL_CALLS,
	MAX_RECORD_TEXT_BYTES,
	openAttempt,
	parseExitCode,
	recordToolCall,
	recordToolResult,
} from "../review-capture.js";

console.log("Running test_review_capture...");

// Pin: every installed Pi copy appends the exit phrase this module parses.
const extensionsDir = fileURLToPath(new URL("../..", import.meta.url));
const bashCopies = readdirSync(extensionsDir)
	.map((name) => join(extensionsDir, name, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js"))
	.filter((file) => existsSync(file));
assert.ok(bashCopies.length > 0, "no installed Pi bash.js to pin against");
for (const file of bashCopies) {
	assert.ok(readFileSync(file, "utf8").includes("Command exited with code ${exitCode}"), `exit phrase changed in ${file}`);
}
assert.equal(parseExitCode("out\n\nCommand exited with code 7"), 7);
assert.equal(parseExitCode("Command exited with code 1\nlater Command exited with code 2"), 2, "last phrase wins");
assert.equal(parseExitCode("Command aborted"), null);

const env = { DEPLOY_TOKEN: "supersecretvalue123" };
const fresh = () => openAttempt({ attemptId: "a1", sessionId: "s1", planId: "p1", taskId: "t1", startedAt: 0 });
const text = (value: string) => [{ type: "text", text: value }];

// Success, failure, unparsed failure, empty failure, unknown result id.
{
	const attempt = fresh();
	recordToolCall(attempt, { toolCallId: "ok", toolName: "bash", input: { command: "npm test" } }, 100, env);
	recordToolResult(attempt, { toolCallId: "ok", content: text("all passed"), isError: false }, 350, env);
	recordToolCall(attempt, { toolCallId: "fail", toolName: "bash", input: { command: "npm run lint" } }, 400, env);
	recordToolResult(attempt, { toolCallId: "fail", content: text("1 error\n\nCommand exited with code 1"), isError: true }, 500, env);
	recordToolCall(attempt, { toolCallId: "killed", toolName: "bash", input: { command: "sleep 99" } }, 500, env);
	recordToolResult(attempt, { toolCallId: "killed", content: text("Command aborted"), isError: true }, 600, env);
	recordToolCall(attempt, { toolCallId: "empty", toolName: "bash", input: { command: "true" } }, 600, env);
	recordToolResult(attempt, { toolCallId: "empty", content: [], isError: true }, 601, env);
	recordToolResult(attempt, { toolCallId: "never-called", content: text("x"), isError: false }, 700, env);
	assert.deepEqual(attempt.commands.map(({ cmd, exit, ms }) => ({ cmd, exit, ms })), [
		{ cmd: "npm test", exit: 0, ms: 250 },
		{ cmd: "npm run lint", exit: 1, ms: 100 },
		{ cmd: "sleep 99", exit: null, ms: 100 },
		{ cmd: "true", exit: null, ms: 1 },
	]);
	assert.equal(attempt.commands[0].tail, "all passed");
	assert.ok(attemptWarnings(attempt).some((warning) => /exit code for 2 failed command/.test(warning)));
}

// Edit/write: successful paths only, deduplicated; other tools ignored.
{
	const attempt = fresh();
	recordToolCall(attempt, { toolCallId: "e1", toolName: "edit", input: { path: "src/a.ts" } }, 0, env);
	recordToolResult(attempt, { toolCallId: "e1", isError: false }, 1, env);
	recordToolCall(attempt, { toolCallId: "e2", toolName: "write", input: { path: "src/a.ts" } }, 0, env);
	recordToolResult(attempt, { toolCallId: "e2", isError: false }, 1, env);
	recordToolCall(attempt, { toolCallId: "e3", toolName: "write", input: { path: "src/failed.ts" } }, 0, env);
	recordToolResult(attempt, { toolCallId: "e3", isError: true }, 1, env);
	recordToolCall(attempt, { toolCallId: "r1", toolName: "read", input: { path: "src/b.ts" } }, 0, env);
	assert.deepEqual(attempt.paths, ["src/a.ts"]);
	assert.equal(attempt.pending.size, 0, "read calls are not tracked");
}

// Redaction and 2 KiB bounds; the exit phrase survives very long output.
{
	const attempt = fresh();
	recordToolCall(attempt, { toolCallId: "s", toolName: "bash", input: { command: `curl -H "Authorization: Bearer ${"t".repeat(40)}" --token supersecretvalue123 ${"x".repeat(5000)}` } }, 0, env);
	recordToolResult(attempt, { toolCallId: "s", content: text(`${"y".repeat(400_000)} key=supersecretvalue123 sk-${"A".repeat(30)}\n\nCommand exited with code 22`), isError: true }, 1, env);
	const [record] = attempt.commands;
	assert.equal(record.exit, 22, "exit phrase at the end of 400 KB output is parsed");
	assert.ok(!record.cmd.includes("supersecretvalue123") && !record.cmd.includes("t".repeat(40)), "command is redacted");
	assert.ok(!record.tail.includes("supersecretvalue123") && !record.tail.includes("A".repeat(30)), "output tail is redacted");
	assert.ok(Buffer.byteLength(record.cmd) <= MAX_RECORD_TEXT_BYTES && Buffer.byteLength(record.tail) <= MAX_RECORD_TEXT_BYTES);
	assert.ok(record.tail.endsWith("Command exited with code 22"));
	assert.ok(attempt.redactions >= 4);
}

// Pending eviction and record caps.
{
	const attempt = fresh();
	for (let index = 0; index <= MAX_PENDING_TOOL_CALLS; index += 1) recordToolCall(attempt, { toolCallId: `p${index}`, toolName: "bash", input: { command: "x" } }, 0, env);
	assert.equal(attempt.pending.size, MAX_PENDING_TOOL_CALLS);
	assert.equal(attempt.pending.has("p0"), false, "oldest pending call is evicted");
	assert.ok(attemptWarnings(attempt).some((warning) => warning === `incomplete: ${MAX_PENDING_TOOL_CALLS + 1} tool call(s) had no matching result`));
	for (let index = 1; index <= MAX_COMMAND_RECORDS + 5; index += 1) recordToolResult(attempt, { toolCallId: `p${index}`, content: text("ok"), isError: false }, 1, env);
	assert.equal(attempt.commands.length, MAX_COMMAND_RECORDS);
	assert.ok(attemptWarnings(attempt).some((warning) => warning.startsWith("truncated: 5 command record")));
	const summary = abandonedSummary(attempt, "mode change");
	assert.equal(summary.commands, MAX_COMMAND_RECORDS + 5);
	assert.deepEqual(Object.keys(summary).sort(), ["attemptId", "commands", "ev", "paths", "planId", "reason", "taskId", "unmatched"], "abandon summary is counts only");
}

// Wiring through the real extension: Build-only capture, tick hand-off, abandon paths.
const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "review-capture-"));
const repo = join(root, "repo");
await mkdir(repo, { recursive: true });
execFileSync("git", ["-C", repo, "init", "-q"]);
await writeFile(join(repo, "a.txt"), "a\n");
execFileSync("git", ["-C", repo, "add", "a.txt"]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "a"]);
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const stubs = join(root, "stubs");
await mkdir(join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await mkdir(join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
const agentDir = join(root, "agent");

const source = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import workflowModesExtension, { flushReviewCapture, PLAN_ENTRY, takeTickedAttempt } from "./index.ts";

const branch = [];
const listeners = new Map();
const events = {
	on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
	emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); },
};
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const pi = {
	events,
	on(name, handler) { handlers.set(name, handler); },
	registerCommand(name, command) { commands.set(name, command); },
	registerTool(tool) { tools.set(tool.name, tool); },
	appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); },
	sendUserMessage() {},
	sendMessage() {},
};
workflowModesExtension(pi);
const ctx = { cwd: ${JSON.stringify(repo)}, hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-cap" }, ui: { setStatus() {}, notify() {} } };
const request = (name, payload) => new Promise((resolve) => {
	events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); });
	events.emit(name, payload);
});
let callId = 0;
const bash = async (command, output = "ok") => {
	const id = "call-" + (++callId);
	const blocked = await handlers.get("tool_call")({ toolCallId: id, toolName: "bash", input: { command } }, ctx);
	if (!blocked) await handlers.get("tool_result")({ toolCallId: id, toolName: "bash", input: { command }, content: [{ type: "text", text: output }], isError: false }, ctx);
};
const mode = (name) => commands.get("mode").handler(name, ctx);
const logText = () => { try { return readFileSync(${JSON.stringify(join(agentDir, "plans", "session-cap", "reviews.jsonl"))}, "utf8"); } catch { return ""; } };
const abandoned = () => logText().trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.ev === "attempt_abandoned");

(async () => {
await handlers.get("session_start")({}, ctx);
const saved = await request("workflow-modes:save-plan", { requestId: "s1", planId: "plan-cap", plan: "# Plan\\n\\n## Section 4 — Tasks\\n- [ ] First\\n- [ ] Second\\n" });
assert.equal(saved.ok, true);

// Off mode: nothing is captured.
await bash("echo off-mode");

// Build: first tool event opens the attempt; the tick hands it to the bundle step.
await mode("build");
await bash("echo one", "one");
await new Promise((resolve) => setTimeout(resolve, 300));
const tasks = await request("workflow-modes:get-plan-tasks", { requestId: "r1" });
await tools.get("workflow_plan_tick").execute("tick-1", { taskId: tasks.nextTask.id }, undefined, undefined, ctx);
const ticked = takeTickedAttempt();
assert.ok(ticked, "tick hands the attempt to the bundle step");
assert.equal(takeTickedAttempt(), undefined, "a ticked attempt is taken once");
assert.equal(ticked.taskId, tasks.nextTask.id);
assert.equal(ticked.planId, "plan-cap");
assert.equal(ticked.baseline, ${JSON.stringify(head)}, "baseline is HEAD at attempt open");
assert.deepEqual(ticked.commands.map((record) => [record.cmd, record.exit, record.tail]), [["echo one", 0, "one"]], "Off-mode command not captured");

// Abandon paths log counts only.
await bash("echo secret-command-text-1");
await mode("plan");
await mode("build");
await bash("echo secret-command-text-2");
await request("workflow-modes:save-plan", { requestId: "s2", planId: "plan-cap-2", plan: "# Plan 2\\n\\n## Section 4 — Tasks\\n- [ ] Only\\n" });
await bash("echo secret-command-text-3");
await handlers.get("session_start")({}, ctx);
await flushReviewCapture();
assert.deepEqual(abandoned().map((event) => [event.reason, event.commands]), [["mode change", 1], ["plan change", 1], ["session switch", 1]]);
assert.ok(!logText().includes("secret-command-text"), "abandon events never store command text");
assert.equal(takeTickedAttempt(), undefined, "abandoned attempts are never handed to the bundle step");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
`;

try {
	await execFileAsync("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: agentDir },
	});
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("test_review_capture passed");
