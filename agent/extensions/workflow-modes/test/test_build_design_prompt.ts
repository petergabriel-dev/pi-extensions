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
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {};\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
let branchEntries: any[] = [{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } }];
let failSend = false;
workflowModesExtension({
	events: { on() {}, emit() {} },
	on(name: string, handler: Function) { handlers.set(name, handler); },
	registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
	registerTool(tool: any) { tools.set(tool.name, tool); },
	appendEntry(type: string, data: unknown) { operations.push({ action: "append", type, data }); },
	sendUserMessage(message: unknown) { operations.push({ action: "user", message }); },
	sendMessage(message: unknown) {
		operations.push({ action: "send", message });
		if (failSend) throw new Error("send failed");
	},
} as never);
const context = {
	sessionManager: { getBranch: () => branchEntries, getSessionId: () => "session-test" },
	ui: { setStatus() {}, notify(message: string) { notifications.push(message); } },
};
handlers.get("session_start")?.({}, context);
handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }).then(async (result: unknown) => {
	const value = result as { message?: ReturnType<typeof composeModeMessage>; systemPrompt?: string };
	if (value.message?.content !== "[workflow-modes] Active workflow mode: Build.") throw new Error("before_agent_start omitted active mode message");
	if (!value.systemPrompt?.startsWith("BASE")) throw new Error("before_agent_start omitted system prompt");
	process.env.PI_CODING_AGENT_DIR = cwd;
	const planTool = tools.get("workflow_plan_save");
	if (!planTool) throw new Error("plan authoring tool was not registered");
	operations.length = 0;
	const saved = await planTool.execute("plan-call", { plan: "# Plan\\n\\n## Section 4 — Tasks\\n- [ ] Seed task\\n" }, undefined, undefined, context);
	const savedDetails = saved.details as { path?: string; planId?: string; taskCount?: number };
	if (!savedDetails.planId || !savedDetails.path || savedDetails.taskCount !== 1) throw new Error("plan tool result missing host metadata");
	if (!existsSync(savedDetails.path)) throw new Error("plan tool did not write plan file");
	if ((operations[0]?.data as { event?: string })?.event !== "set" || (operations[1]?.data as { event?: string })?.event !== "activate") throw new Error("plan state was not durably set then activated");
	branchEntries = [
		{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } },
		{ type: "custom", customType: PLAN_ENTRY, data: operations[0]?.data },
		{ type: "custom", customType: PLAN_ENTRY, data: operations[1]?.data },
	];
	const activeTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { message?: { details?: { planId?: string; path?: string; progress?: { done: number; total: number }; nextTask?: { title?: string } } } };
	const activeDetails = activeTurn.message?.details;
	if (activeDetails?.planId !== savedDetails.planId || activeDetails.path !== savedDetails.path || activeDetails.progress?.total !== 1 || activeDetails.progress.done !== 0 || activeDetails.nextTask?.title !== "Seed task") throw new Error("active plan marker missing identity/progress");
	writeFileSync(savedDetails.path, "# Hand edited\\n\\n## Section 4 — Tasks\\n- [ ] Edited task\\n");
	const editedTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, context) as { systemPrompt?: string; message?: { details?: { nextTask?: { title?: string } } } };
	if (!editedTurn.systemPrompt?.includes("# Hand edited") || editedTurn.message?.details?.nextTask?.title !== "Edited task") throw new Error("before_agent_start did not reread edited plan file");
	operations.length = 0;
	notifications.length = 0;
	await commands.get("plan")?.handler("save", context);
	if (operations[0]?.action !== "user" || !String(operations[0]?.message).includes("workflow_plan_save")) throw new Error("/plan save did not start directive turn");
	await handlers.get("turn_end")?.({ toolResults: [] }, context);
	if (notifications.filter((message) => message.includes("Plan save tool was not called")).length !== 1) throw new Error("missed plan tool did not emit exactly one nudge");
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
	if (restored.message?.content !== "[workflow-modes] Active workflow mode: Build.") throw new Error("failed Off send did not restore in-memory mode");
	for (const mode of ["discuss", "plan", "review", "design"] as const) {
		const reason = formatModeBlockReason(mode, "operation was blocked.");
		if (!reason.includes("Workflow mode was " + MODE_LABELS[mode] + " at tool-call time.")) throw new Error(mode + " block reason was not mode-stamped");
		if (!reason.includes("latest [workflow-modes] line")) throw new Error(mode + " block reason omitted authoritative line");
		if (reason.includes("/mode")) throw new Error(mode + " block reason instructed a mode switch");
	}
	const toolCall = handlers.get("tool_call");
	const modeContext = (mode: string) => ({
		sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY, data: { mode } }] },
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
