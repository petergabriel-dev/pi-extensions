import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "build-design-prompt-"));
const stubs = join(root, "stubs");
const project = join(root, "project");
await mkdir(join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await mkdir(join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR || process.env.TEST_PROJECT || process.cwd();\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import workflowModesExtension, { BUILD_DESIGN_AWARE_PROMPT, composeModeMessage, composeWorkflowPrompt, formatModeBlockReason, MODE_ENTRY, MODE_LABELS, MODE_MESSAGE_TYPE, MODE_TRANSITION_MESSAGE_TYPE, PLAN_ENTRY } from "./index.ts";
import { wrapCommand } from "./sandbox.ts";
const cwd = process.env.TEST_PROJECT;
if (!cwd) throw new Error("TEST_PROJECT missing");
const absent = composeWorkflowPrompt("build", true, undefined, cwd);
if (absent?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("missing manifest injected design block");
mkdirSync(join(cwd, "docs/design"), { recursive: true });
writeFileSync(join(cwd, "docs/design/manifest.json"), "{}");
if (!composeWorkflowPrompt("build", true, undefined, cwd)?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("manifest failed to inject design block");
const buildPrompt = composeWorkflowPrompt("build", true, undefined, cwd);
if (!buildPrompt?.includes("workflow_plan_tick") || !buildPrompt.includes("authoritative queue") || !buildPrompt.includes("immutable seed text")) throw new Error("Build prompt omitted tracker queue rules");
if (composeWorkflowPrompt("design", true, undefined, cwd)?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("non-build mode used cwd");
for (const mode of ["discuss", "plan", "build", "review", "design"] as const) {
	const message = composeModeMessage(mode);
	if (message?.customType !== MODE_MESSAGE_TYPE) throw new Error(mode + " mode message customType changed");
	if (message?.content !== "[workflow-modes] Active workflow mode: " + MODE_LABELS[mode] + ".") throw new Error(mode + " mode message content invalid");
	if (message.display !== false) throw new Error(mode + " mode message must be hidden");
	if (message.content.includes("\\n")) throw new Error(mode + " mode message must be one line");
	if (message.content.split(/\\s+/).length > 40) throw new Error(mode + " mode message exceeds token proxy budget");
}
if (composeModeMessage("off") !== undefined) throw new Error("Off injected a mode message");
const handlers = new Map<string, Function>();
const commands = new Map<string, { handler: Function }>();
const tools = new Map<string, any>();
const operations: Array<{ action: string; type?: string; data?: unknown; message?: unknown }> = [];
const notifications: string[] = [];
const statuses: string[] = [];
let branchEntries: any[] = [{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } }];
let failSend = false;
workflowModesExtension({
	events: { on() {}, emit() {} },
	on(name: string, handler: Function) { handlers.set(name, handler); },
	registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
	registerTool(tool: any) { tools.set(tool.name, tool); },
	appendEntry(type: string, data: unknown) {
		operations.push({ action: "append", type, data });
		if (type === PLAN_ENTRY) branchEntries.push({ type: "custom", customType: type, data });
	},
	sendUserMessage(message: unknown) { operations.push({ action: "user", message }); },
	sendMessage(message: unknown) {
		operations.push({ action: "send", message });
		if (failSend) throw new Error("send failed");
	},
} as never);
const context = {
	sessionManager: { getBranch: () => branchEntries, getSessionId: () => "session-test" },
	ui: { setStatus(key: string, message: string) { statuses.push(key + ":" + message); }, notify(message: string) { notifications.push(message); } },
};
handlers.get("session_start")?.({}, context);
handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }).then(async (result: unknown) => {
	const value = result as { message?: ReturnType<typeof composeModeMessage>; systemPrompt?: string };
	if (value.message?.content !== "[workflow-modes] Active workflow mode: Build.") throw new Error("before_agent_start omitted active mode message");
	if (!value.systemPrompt?.startsWith("BASE")) throw new Error("before_agent_start omitted system prompt");
	process.env.PI_CODING_AGENT_DIR = cwd;
	const planTool = tools.get("workflow_plan_save");
	const tickTool = tools.get("workflow_plan_tick");
	const tasksTool = tools.get("workflow_plan_tasks");
	if (!planTool || !tickTool || !tasksTool) throw new Error("plan tools were not registered");
	operations.length = 0;
	const saved = await planTool.execute("plan-call", { plan: "# Plan\\n\\n## Section 4 — Tasks\\n- [ ] Seed task\\n" }, undefined, undefined, context);
	const savedDetails = saved.details as { path?: string; planId?: string; taskCount?: number };
	if (!savedDetails.planId || !savedDetails.path || savedDetails.taskCount !== 1) throw new Error("plan tool result missing host metadata");
	if (!existsSync(savedDetails.path)) throw new Error("plan tool did not write plan file");
	if ((operations[0]?.data as { event?: string })?.event !== "set" || (operations[1]?.data as { event?: string })?.event !== "activate") throw new Error("plan state was not durably set then activated");
	const firstSet = operations[0]?.data;
	const firstActivate = operations[1]?.data;
	branchEntries = [
		{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } },
		{ type: "custom", customType: PLAN_ENTRY, data: firstSet },
		{ type: "custom", customType: PLAN_ENTRY, data: firstActivate },
	];
	const activeTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: { planId?: string; path?: string; progress?: { done: number; total: number }; nextTask?: { title?: string } } } };
	const activeDetails = activeTurn.message?.details;
	if (activeDetails?.planId !== savedDetails.planId || activeDetails.path !== savedDetails.path || activeDetails.progress?.total !== 1 || activeDetails.progress.done !== 0 || activeDetails.nextTask?.title !== "Seed task") throw new Error("active plan marker missing identity/progress");
	const recovered = await tasksTool.execute("tasks-call", {}, undefined, undefined, context);
	const recoveredDetails = recovered.details as { planId?: string; tasks?: Array<{ id?: string; title?: string }>; completedTaskIds?: string[]; progress?: { done: number; total: number }; nextTask?: { title?: string } };
	const recoveredText = String(recovered.content?.[0]?.text);
	if (recoveredDetails.planId !== savedDetails.planId || recoveredDetails.tasks?.[0]?.title !== "Seed task" || recoveredDetails.progress?.done !== 0 || recoveredDetails.progress?.total !== 1 || recoveredDetails.nextTask?.title !== "Seed task" || !recoveredText.includes("Seed task")) throw new Error("plan task recovery omitted live tracker state");
	writeFileSync(savedDetails.path, "# Hand edited\\n\\n## Section 4 — Tasks\\n- [ ] Edited task\\n");
	const editedTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { systemPrompt?: string; message?: { details?: { planId?: string; progress?: { done: number; total: number }; nextTask?: { id?: string; title?: string } } } };
	if (!editedTurn.systemPrompt?.includes("# Hand edited") || editedTurn.message?.details?.nextTask?.title !== "Seed task") throw new Error("tracker did not remain authoritative after plan hand-edit");
	if (readFileSync(savedDetails.path, "utf8") !== "# Hand edited\\n\\n## Section 4 — Tasks\\n- [ ] Edited task\\n") throw new Error("hand-edited plan text changed unexpectedly");
	const seededTaskId = editedTurn.message?.details?.nextTask?.id;
	if (!seededTaskId || editedTurn.message?.details?.progress?.done !== 0 || editedTurn.message?.details?.progress?.total !== 1) throw new Error("tracker marker missing seeded task state");
	operations.length = 0;
	const ticked = await tickTool.execute("tick-call", { taskId: seededTaskId }, undefined, undefined, context);
	if ((operations[0]?.data as { event?: string; planId?: string; taskId?: string })?.event !== "tick" || (operations[0]?.data as { taskId?: string })?.taskId !== seededTaskId) throw new Error("task tick was not appended");
	if (readFileSync(savedDetails.path, "utf8") !== "# Hand edited\\n\\n## Section 4 — Tasks\\n- [ ] Edited task\\n") throw new Error("task tick mutated plan file");
	if (!(ticked.details as { progress?: { done: number; total: number }; idempotent?: boolean }).progress || (ticked.details as { progress: { done: number; total: number } }).progress.done !== 1 || (ticked.details as { idempotent?: boolean }).idempotent) throw new Error("task tick result missing progress");
	if (!statuses.some((status) => status.includes(savedDetails.planId!) && status.includes("1/1"))) throw new Error("status did not update task progress");
	const repeated = await tickTool.execute("tick-call-replay", { taskId: seededTaskId }, undefined, undefined, context);
	if (!(repeated.details as { idempotent?: boolean }).idempotent || operations.length !== 1) throw new Error("repeated task tick was not idempotent");
	const tickedTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: { progress?: { done: number; total: number }; nextTask?: unknown } } };
	if (tickedTurn.message?.details?.progress?.done !== 1 || tickedTurn.message?.details?.progress?.total !== 1 || tickedTurn.message?.details?.nextTask !== undefined) throw new Error("task tick did not survive marker refresh");
	const tickedBranch = [...branchEntries];
	await handlers.get("session_start")?.({}, context);
	const reloadedTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: { progress?: { done: number; total: number } } } };
	if (reloadedTurn.message?.details?.progress?.done !== 1) throw new Error("task tick did not survive session reload");
	branchEntries = tickedBranch.slice(0, -1);
	await handlers.get("session_tree")?.({}, context);
	const forkTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: { progress?: { done: number; total: number } } } };
	if (forkTurn.message?.details?.progress?.done !== 0) throw new Error("fork branch incorrectly inherited task tick");
	branchEntries = tickedBranch;
	await handlers.get("session_tree")?.({}, context);
	operations.length = 0;
	const sequence = await planTool.execute("plan-call-sequence", { plan: "# Sequence\\n\\n## Section 4 — Tasks\\n- [ ] First task\\n- [ ] Second task\\n" }, undefined, undefined, context);
	const sequenceTasks = ((operations[0]?.data as { tasks?: Array<{ id: string; title: string }> })?.tasks ?? []);
	if (sequenceTasks.length !== 2) throw new Error("sequence plan did not seed two tasks");
	const outOfOrder = await tickTool.execute("tick-sequence-title", { title: "Second task" }, undefined, undefined, context);
	const outOfOrderDetails = outOfOrder.details as { taskId?: string; progress?: { done: number; total: number }; nextTask?: { id?: string; title?: string }; outOfOrder?: boolean };
	if (!outOfOrderDetails.outOfOrder || outOfOrderDetails.taskId !== sequenceTasks[1]?.id || outOfOrderDetails.progress?.done !== 1 || outOfOrderDetails.nextTask?.id !== sequenceTasks[0]?.id) throw new Error("title tick did not flag out-of-order progress");
	if (!String(outOfOrder.content?.[0]?.text).includes("out of order")) throw new Error("title tick result omitted out-of-order note");
	const operationCountAfterOutOfOrder = operations.length;
	const repeatedTitle = await tickTool.execute("tick-sequence-title-replay", { title: "Second task" }, undefined, undefined, context);
	if (!(repeatedTitle.details as { idempotent?: boolean }).idempotent || operations.length !== operationCountAfterOutOfOrder) throw new Error("title re-tick was not idempotent");
	let unknownError = "";
	try {
		await tickTool.execute("tick-sequence-unknown", { title: "Missing task" }, undefined, undefined, context);
	} catch (error) {
		unknownError = error instanceof Error ? error.message : String(error);
	}
	if (!unknownError.includes("First task") || !unknownError.includes(sequenceTasks[0]!.id)) throw new Error("unknown title error omitted expected next task");
	const inOrder = await tickTool.execute("tick-sequence-id", { taskId: sequenceTasks[0]!.id }, undefined, undefined, context);
	const inOrderDetails = inOrder.details as { progress?: { done: number; total: number }; outOfOrder?: boolean };
	if (inOrderDetails.outOfOrder || inOrderDetails.progress?.done !== 2) throw new Error("task id tick did not finish sequence");
	operations.length = 0;
	await planTool.execute("plan-call-ambiguous", { plan: "# Ambiguous\\n\\n## Section 4 — Tasks\\n- [ ] Duplicate task\\n- [ ] Duplicate task\\n" }, undefined, undefined, context);
	const ambiguousTasks = ((operations[0]?.data as { tasks?: Array<{ id: string; title: string }> })?.tasks ?? []);
	let ambiguousError = "";
	try {
		await tickTool.execute("tick-ambiguous", { title: "Duplicate task" }, undefined, undefined, context);
	} catch (error) {
		ambiguousError = error instanceof Error ? error.message : String(error);
	}
	if (!ambiguousError.includes("ambiguous") || !ambiguousError.includes("Duplicate task") || !ambiguousError.includes(ambiguousTasks[0]!.id)) throw new Error("ambiguous title error omitted expected next task");
	operations.length = 0;
	const second = await planTool.execute("plan-call-2", { plan: "# Plan B\\n\\n## Section 4 — Tasks\\n- [ ] Second task\\n" }, undefined, undefined, context);
	const secondDetails = second.details as { path?: string; planId?: string; taskCount?: number };
	if (!secondDetails.planId || !secondDetails.path || secondDetails.taskCount !== 1) throw new Error("second plan save failed");
	await commands.get("plan")?.handler("select " + savedDetails.planId, context);
	const selectedTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { systemPrompt?: string; message?: { details?: { planId?: string } } };
	if (!selectedTurn.systemPrompt?.includes("# Hand edited") || selectedTurn.message?.details?.planId !== savedDetails.planId) throw new Error("plan select did not activate requested plan");
	if (!statuses.some((status) => status.includes(savedDetails.planId!))) throw new Error("status omitted active plan identity");
	operations.length = 0;
	await commands.get("plan")?.handler("clear", context);
	if ((operations.at(-1)?.data as { event?: string; planId?: string })?.event !== "clear" || (operations.at(-1)?.data as { planId?: string })?.planId !== savedDetails.planId) throw new Error("clear did not target active plan");
	if (!existsSync(savedDetails.path)) throw new Error("clear deleted plan file");
	operations.length = 0;
	notifications.length = 0;
	await commands.get("plan")?.handler("save", context);
	if (operations[0]?.action !== "user" || !String(operations[0]?.message).includes("workflow_plan_save")) throw new Error("/plan save did not start directive turn");
	await handlers.get("turn_end")?.({ toolResults: [] }, context);
	if (notifications.filter((message) => message.includes("Plan save tool was not called")).length !== 1) throw new Error("missed plan tool did not emit exactly one nudge");
	branchEntries = [{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } }];
	await handlers.get("session_tree")?.({}, context);
	let noPlanError = "";
	try {
		await tasksTool.execute("tasks-no-plan", {}, undefined, undefined, context);
	} catch (error) {
		noPlanError = error instanceof Error ? error.message : String(error);
	}
	if (!noPlanError.includes("no active saved plan")) throw new Error("plan task recovery omitted no-plan error");
	branchEntries = [
		{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } },
		{ type: "custom", customType: PLAN_ENTRY, data: { event: "set", planId: "missing-plan", path: "/missing/plan.md", savedAt: "2026-07-01T00:00:00.000Z" } },
		{ type: "custom", customType: PLAN_ENTRY, data: { event: "activate", planId: "missing-plan" } },
	];
	notifications.length = 0;
	const missingFirst = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: unknown } };
	if (missingFirst.message?.details !== undefined) throw new Error("missing plan file retained marker identity");
	await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context);
	if (notifications.filter((message) => message.includes("Saved plan unavailable")).length !== 1) throw new Error("missing plan file did not emit one notice");
	branchEntries = [{ role: "assistant", content: "LAST PLAN" }];
	operations.length = 0;
	await commands.get("plan")?.handler("save --last", context);
	if (operations.some((operation) => operation.action === "user") || !operations.some((operation) => operation.action === "append")) throw new Error("/plan save --last did not use deterministic fallback");
	operations.length = 0;
	await commands.get("mode")?.handler("off", context);
	if (operations[0]?.action !== "append" || operations[0]?.type !== MODE_ENTRY || (operations[0]?.data as { mode?: string })?.mode !== "off") throw new Error("Off mode was not persisted first");
	const transition = (operations[1]?.message ?? {}) as { customType?: string; content?: string; display?: boolean };
	if (operations[1]?.action !== "send" || transition.customType !== MODE_TRANSITION_MESSAGE_TYPE) throw new Error("Off transition message missing");
	if (transition.content !== "[workflow-modes] Active workflow mode: OFF." || transition.display !== false) throw new Error("Off transition message invalid");
	if (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }) !== undefined) throw new Error("Off injected per-turn context");
	operations.length = 0;
	await commands.get("mode")?.handler("build", context);
	if (operations.length !== 1 || operations[0]?.action !== "append") throw new Error("active mode was double-announced");
	operations.length = 0;
	failSend = true;
	let failed = false;
	try {
		await commands.get("mode")?.handler("off", context);
	} catch (error) {
		failed = error instanceof Error && error.message === "send failed";
	}
	if (!failed) throw new Error("Off send failure was not surfaced");
	if ((operations[2]?.data as { mode?: string })?.mode !== "build") throw new Error("failed Off send did not restore durable mode");
	const restored = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }) as { message?: { content?: string } };
	if (!restored.message?.content?.startsWith("[workflow-modes] Active workflow mode: Build.")) throw new Error("failed Off send did not restore in-memory mode");
	for (const mode of ["discuss", "plan", "review", "design"] as const) {
		const reason = formatModeBlockReason(mode, "operation was blocked.");
		if (!reason.includes("Workflow mode was " + MODE_LABELS[mode] + " at tool-call time.")) throw new Error(mode + " block reason was not mode-stamped");
		if (!reason.includes("latest [workflow-modes] line")) throw new Error(mode + " block reason omitted authoritative line");
		if (reason.includes("/mode")) throw new Error(mode + " block reason instructed a mode switch");
	}
	const toolCall = handlers.get("tool_call");
	const modeContext = (mode: string) => ({
		sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY, data: { mode } }], getSessionId: () => "session-test" },
		ui: context.ui,
	});
	handlers.get("session_start")?.({}, modeContext("discuss"));
	const mutationBlock = await toolCall?.({ toolName: "edit", input: { path: "README.md" } }) as { reason?: string };
	if (!mutationBlock.reason?.startsWith("edit was blocked.")) throw new Error("mutation block reason was not past-tense");
	const readEvent = { toolName: "bash", input: { command: "rg workflow-mode-no-match" } };
	if (await toolCall?.(readEvent) !== undefined) throw new Error("Discuss read command was blocked");
	const expectedWrap = wrapCommand("rg workflow-mode-no-match", { cwd: process.cwd() });
	if (readEvent.input.command !== expectedWrap.command) throw new Error("wrapped command was not passed through unchanged");
	if (readEvent.input.command.includes("Hint: editing requires") || readEvent.input.command.includes("status=$?")) throw new Error("wrapped command retained bash hint suffix");
	handlers.get("session_start")?.({}, modeContext("review"));
	const reviewBlock = await toolCall?.({ toolName: "bash", input: { command: "curl example.com" } }) as { reason?: string };
	if (!reviewBlock.reason?.startsWith("bash command was blocked;")) throw new Error("Review block reason was not past-tense");
	handlers.get("session_start")?.({}, modeContext("design"));
	const designBlock = await toolCall?.({ toolName: "edit", input: { path: "src/not-a-token.css" } }) as { reason?: string };
	if (!designBlock.reason?.startsWith("edit was blocked outside the design surface")) throw new Error("Design block reason was not past-tense");
});
`;
try {
	await execFileAsync("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, TEST_PROJECT: project },
	});
	assert.equal(existsSync(join(project, "docs/design/manifest.json")), true);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("build design prompt assertions passed");
