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
	attachRunSummary,
	attemptWarnings,
	MAX_ATTEMPT_SUBAGENTS,
	normalizeRunSummary,
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

// Subagent run summaries: validated, bounded, re-redacted; only runs started in the attempt; capped.
{
	const base = { owner: "w1", agentName: "worker", status: "done", startedAt: 10, finishedAt: 20, tools: { bash: 2, "bad name!": 1 }, files: ["src/a.ts"], failedCommands: [{ cmd: "npm test", exit: 1, tail: `fail supersecretvalue123 sk-${"B".repeat(30)}` }] };
	for (const bad of [null, [], { ...base, owner: 5 }, { ...base, startedAt: Number.NaN }, { ...base, finishedAt: "x" }]) assert.equal(normalizeRunSummary(bad, env), undefined);
	const summary = normalizeRunSummary({ ...base, files: Array.from({ length: 80 }, (_, index) => `f${index}`), failedCommands: Array.from({ length: 15 }, () => base.failedCommands[0]) }, env)!;
	assert.deepEqual(summary.tools, { bash: 2 }, "invalid tool names are dropped");
	assert.equal(summary.files.length, 50);
	assert.equal(summary.failedCommands.length, 10);
	assert.ok(!JSON.stringify(summary).includes("supersecretvalue123") && !JSON.stringify(summary).includes("B".repeat(30)), "summary text is re-redacted");
	const attempt = openAttempt({ attemptId: "a2", sessionId: "s1", planId: "p1", taskId: "t1", startedAt: 100 });
	attachRunSummary(attempt, { ...summary, startedAt: 50 });
	assert.equal(attempt.subagents.length, 0, "runs started before the attempt are not attached");
	for (let index = 0; index <= MAX_ATTEMPT_SUBAGENTS; index += 1) attachRunSummary(attempt, { ...summary, owner: `w${index}`, startedAt: 100 + index });
	assert.equal(attempt.subagents.length, MAX_ATTEMPT_SUBAGENTS);
	assert.ok(attemptWarnings(attempt).some((warning) => warning.startsWith("truncated: 1 subagent run summary")));
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
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import workflowModesExtension, { flushReviewCapture, PLAN_ENTRY } from "./index.ts";

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
const runSummary = (owner, startedAt) => ({ owner, agentName: "worker", status: "done", startedAt, finishedAt: Date.now(), tools: { edit: 1 }, files: ["src/a.ts"], failedCommands: [], droppedFiles: 0, droppedFailedCommands: 0 });
events.emit("subagents:run-summary", runSummary("before-attempt", 0));
events.emit("subagents:run-summary", runSummary("inside-attempt", Date.now()));
events.emit("subagents:run-summary", { owner: "malformed" });
await new Promise((resolve) => setTimeout(resolve, 300));
const tasks = await request("workflow-modes:get-plan-tasks", { requestId: "r1" });
const tickResult = await tools.get("workflow_plan_tick").execute("tick-1", { taskId: tasks.nextTask.id }, undefined, undefined, ctx);
await flushReviewCapture();
const bundleId = tickResult.details.bundle?.id;
assert.match(bundleId ?? "", /^[0-9a-f]{64}$/, "tick hands the attempt to the bundle step");
const ticked = JSON.parse(readFileSync(${JSON.stringify(join(agentDir, "plans", "session-cap", "evidence"))} + "/" + bundleId + ".json", "utf8"));
assert.equal(ticked.taskId, tasks.nextTask.id);
assert.equal(ticked.planId, "plan-cap");
assert.equal(ticked.baseline, ${JSON.stringify(head)}, "baseline is HEAD at attempt open");
assert.deepEqual(ticked.commands.map((record) => [record.cmd, record.exit, record.tail]), [["echo one", 0, "one"]], "Off-mode command not captured");
assert.deepEqual(ticked.subagents.map((summary) => summary.owner), ["inside-attempt"], "only valid summaries for runs inside the attempt attach");

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
assert.equal(logText().trim().split("\\n").map((line) => JSON.parse(line)).filter((event) => event.ev === "bundle_created").length, 1, "abandoned attempts never produce a bundle");

// After a restart, the tick's own tool_call must not open an attempt: its baseline would be
// the task commit and the bundle would show no changes without a warning.
await mode("build");
const REPO = ${JSON.stringify(repo)};
writeFileSync(REPO + "/b.txt", "b\\n");
execFileSync("git", ["-C", REPO, "add", "b.txt"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "b"]);
const taskCommit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const onlyTask = (await request("workflow-modes:get-plan-tasks", { requestId: "r2" })).nextTask;
const tickInput = { taskId: onlyTask.id, commit: taskCommit };
assert.equal(await handlers.get("tool_call")({ toolCallId: "tick-call-2", toolName: "workflow_plan_tick", input: tickInput }, ctx), undefined);
await new Promise((resolve) => setTimeout(resolve, 300));
const restartTick = await tools.get("workflow_plan_tick").execute("tick-call-2", tickInput, undefined, undefined, ctx);
await flushReviewCapture();
const restartBundle = JSON.parse(readFileSync(${JSON.stringify(join(agentDir, "plans", "session-cap", "evidence"))} + "/" + restartTick.details.bundle.id + ".json", "utf8"));
assert.equal(restartBundle.attemptId, undefined, "the tick itself opens no capture attempt");
assert.ok(restartBundle.warnings.some((warning) => warning.startsWith("incomplete: no captured attempt")), "a missing attempt is reported");
assert.deepEqual(restartBundle.files.map((file) => file.path), ["b.txt"], "the diff is not empty");
assert.equal(restartBundle.baseline, ${JSON.stringify(head)}, "baseline is inferred as the commit's parent");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
`;

// Attribution: the first captured call waits (at most 1 s) for its baseline, and a bridge
// tick never takes Pi's attempt. A git wrapper slows only `rev-parse --verify --quiet HEAD`.
const raceRepo = join(root, "race-repo");
await mkdir(raceRepo, { recursive: true });
execFileSync("git", ["-C", raceRepo, "init", "-q"]);
await writeFile(join(raceRepo, "a.txt"), "a\n");
execFileSync("git", ["-C", raceRepo, "add", "a.txt"]);
execFileSync("git", ["-C", raceRepo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "a"]);
const raceHead = execFileSync("git", ["-C", raceRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const wrapperDir = join(root, "slow-head-git");
await mkdir(wrapperDir);
const delayFile = join(wrapperDir, "delay");
await writeFile(delayFile, "0.3\n");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
await writeFile(join(wrapperDir, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse --verify --quiet HEAD "*) sleep "$(cat ${JSON.stringify(delayFile)})";; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
const raceAgentDir = join(root, "race-agent");
const raceSession = join(raceAgentDir, "plans", "session-race");

const raceSource = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import workflowModesExtension, { flushReviewCapture } from "./index.ts";

const branch = [];
const listeners = new Map();
const events = {
	on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
	emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); },
};
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); }, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const REPO = ${JSON.stringify(raceRepo)};
const ctx = { cwd: REPO, hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-race" }, ui: { setStatus() {}, notify() {} } };
const request = (name, payload) => new Promise((resolve) => {
	events.on(name + "-result", (result) => { if (result.requestId === payload.requestId) resolve(result); });
	events.emit(name, payload);
});
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const commit = (file) => { writeFileSync(REPO + "/" + file, file + "\\n"); git("add", file); git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", file); return git("rev-parse", "HEAD"); };
const call = (id, command) => handlers.get("tool_call")({ toolCallId: id, toolName: "bash", input: { command } }, ctx);
const result = (id, command, text) => handlers.get("tool_result")({ toolCallId: id, toolName: "bash", input: { command }, content: [{ type: "text", text }], isError: false }, ctx);
const logEvents = () => readFileSync(${JSON.stringify(join(raceSession, "reviews.jsonl"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
const bundle = (id) => JSON.parse(readFileSync(${JSON.stringify(join(raceSession, "evidence"))} + "/" + id + ".json", "utf8"));

(async () => {
await handlers.get("session_start")({}, ctx);
await request("workflow-modes:save-plan", { requestId: "s", planId: "plan-race", plan: "# P\\n\\n## Section 4 — Tasks\\n- [ ] Race\\n- [ ] Bridge\\n" });
await commands.get("mode").handler("build", ctx);

// The first captured call is the commit itself: the tool runs only after tool_call returns.
assert.equal(await call("c1", "git commit -am race"), undefined);
const raceCommit = commit("race.txt");
await result("c1", "git commit -am race", "ok");
await new Promise((resolve) => setTimeout(resolve, 500)); // any background baseline lookup has finished
const raceTask =(await request("workflow-modes:get-plan-tasks", { requestId: "r1" })).nextTask;
const raceTick = await tools.get("workflow_plan_tick").execute("t1", { taskId: raceTask.id, commit: raceCommit }, undefined, undefined, ctx);
await flushReviewCapture();
const raceBundle = bundle(raceTick.details.bundle.id);
assert.match(raceBundle.attemptId ?? "", /./, "the bundle uses the attempt");
assert.ok(!raceBundle.warnings.includes("baseline inferred as the commit's parent"), "the attempt's own baseline is used");
assert.equal(raceBundle.baseline, ${JSON.stringify(raceHead)}, "baseline is HEAD from before the first captured call ran");
assert.deepEqual(raceBundle.files.map((file) => file.path), ["race.txt"]);
assert.ok(!raceBundle.warnings.some((warning) => warning.startsWith("incomplete: baseline equals")), "no false incomplete warning");

// The wait is bounded: a hung rev-parse delays the first call by about 1 s, later calls not at all.
writeFileSync(${JSON.stringify(delayFile)}, "1.6\\n");
let started = Date.now();
assert.equal(await call("c2", "echo bridge-work-1"), undefined);
const firstWait = Date.now() - started;
assert.ok(firstWait >= 900 && firstWait < 1500, "first captured call waited " + firstWait + " ms");
await result("c2", "echo bridge-work-1", "bridge-work-1");
started = Date.now();
assert.equal(await call("c3", "echo bridge-work-2"), undefined);
assert.ok(Date.now() - started < 200, "later calls add no wait");
await result("c3", "echo bridge-work-2", "bridge-work-2");
writeFileSync(${JSON.stringify(delayFile)}, "0\\n");

// A harness ticks the task Pi was working on: its bundle is git-only and Pi's attempt is
// abandoned with counts only, never attributed to the harness.
const bridgeTask = (await request("workflow-modes:get-plan-tasks", { requestId: "r2" })).nextTask;
const bridgeCommit = commit("bridge.txt");
const bridgeTick = await request("workflow-modes:tick-plan-task", { requestId: "t2", taskId: bridgeTask.id, commit: bridgeCommit, by: "claude:builder" });
assert.equal(bridgeTick.ok, true, bridgeTick.error);
await new Promise((resolve) => setTimeout(resolve, 1800));
await flushReviewCapture();
const bridgeCreated = logEvents().filter((event) => event.ev === "bundle_created" && event.taskId === bridgeTask.id);
assert.equal(bridgeCreated.length, 1);
const bridgeBundle = bundle(bridgeCreated[0].bundleId);
assert.deepEqual(bridgeBundle.commands, [], "no Pi commands in a harness-built bundle");
assert.equal(bridgeBundle.attemptId, undefined);
assert.ok(bridgeBundle.warnings.some((warning) => warning.startsWith("unavailable: harness build commands")), "the bundle says harness commands are unavailable");
assert.deepEqual(logEvents().filter((event) => event.ev === "attempt_abandoned").map((event) => [event.reason, event.taskId, event.commands]), [["bridge tick", bridgeTask.id, 2]]);
assert.ok(!readFileSync(${JSON.stringify(join(raceSession, "reviews.jsonl"))}, "utf8").includes("bridge-work"), "abandon events never store command text");
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
	await execFileAsync("./node_modules/.bin/tsx", ["-e", raceSource], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: raceAgentDir, PATH: `${wrapperDir}:${process.env.PATH}` },
	});
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("test_review_capture passed");
