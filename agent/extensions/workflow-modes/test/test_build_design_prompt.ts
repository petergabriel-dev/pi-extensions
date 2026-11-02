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
await mkdir(join(stubs, "typebox"), { recursive: true });
await writeFile(join(stubs, "typebox/index.js"), "exports.Type = {};\n");
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR || process.env.TEST_PROJECT || process.cwd();\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowModesExtension, { ANIMATE_SKILL_PATH, ANIMATION_VOCABULARY_SKILL_PATH, BUILD_DESIGN_AWARE_PROMPT, BUILD_FRONTEND_VERIFICATION_PROMPT, BUILD_PROMPT, BUILD_REFERENCE_PROMPT, FIND_ANIMATION_OPPORTUNITIES_SKILL_PATH, IMPECCABLE_SKILL_PATH, PLAN_FRONTEND_PROMPT, PLAN_REFERENCE_PROMPT, PLAN_TEMPLATE_PATH, composeModeMessage, composeWorkflowPrompt, DISCUSS_PROMPT, formatModeBlockReason, MODE_ENTRY, MODE_LABELS, MODE_MESSAGE_TYPE, MODE_TRANSITION_MESSAGE_TYPE, PLAN_ENTRY } from "./index.ts";
import { wrapCommand } from "./sandbox.ts";
import { promptContextForMode } from "../claude-bridge/index.ts";
const cwd = process.env.TEST_PROJECT;
if (!cwd) throw new Error("TEST_PROJECT missing");
if (PLAN_FRONTEND_PROMPT.length > 2000 || PLAN_REFERENCE_PROMPT.length > 2000) throw new Error("Added Plan prompt text exceeds 2,000 characters");
if (BUILD_FRONTEND_VERIFICATION_PROMPT.length > 2000 || !BUILD_PROMPT.includes(BUILD_FRONTEND_VERIFICATION_PROMPT)) throw new Error("Build frontend verification clause exceeds 2,000 characters or is not composed into BUILD_PROMPT");
if (!DISCUSS_PROMPT.includes("Without a sandbox, Discuss runs no bash; use the read, grep, find, and ls tools instead.")) throw new Error("Discuss prompt omitted the no-sandbox bash rule");
for (const part of ["saved plan", "docs/design/components/", "authoritative", "no unplanned taste", "wrong or contradictory", "through Plan", "required spec is missing"]) {
	if (!BUILD_DESIGN_AWARE_PROMPT.toLowerCase().includes(part.toLowerCase())) throw new Error("Build spec authority omitted " + part);
}
for (const part of ["render every spec viewport and required state", "capture a screenshot for each", "web-design-guidelines", "at most 3 passes", "Claim verified only after reviewing all required screenshots", "browser_*", "/browser on", "playwright-cli", 'note: "unverified: <reason>; setup: npx playwright install chromium / npm i -g @playwright/cli@latest"', "replace <reason> with the actual cause", "unverified in the post-task report"]) {
	if (!BUILD_FRONTEND_VERIFICATION_PROMPT.includes(part)) throw new Error("Build visual gate omitted " + part);
}
if (BUILD_DESIGN_AWARE_PROMPT.includes("/mode design") || BUILD_PROMPT.includes("/mode design")) throw new Error("Build prompt retained removed Design mode");
for (const part of ["docs/design/", "tokenFiles", "before component tasks", "existing design system or base library", "/* @primitive */", "/* @semantic */", "semantic light/dark", "hard-coded values", "Accessibility is non-negotiable", "mobile-first", "single-column previews", "file path", "base component", "props/types", "variants", "states (default, hover, focus-visible, active, disabled, loading, empty, error)", "tokens by name", "layout per breakpoint", "motion token, trigger", "prefers-reduced-motion", "accessibility role, keyboard, aria", "verification viewports (default 375/768/1280 px)", "no code skeletons"]) {
	if (!PLAN_FRONTEND_PROMPT.includes(part)) throw new Error("Plan frontend clause omitted " + part);
}
const planTemplate = readFileSync(PLAN_TEMPLATE_PATH, "utf8");
for (const part of ["Rules-first frontend order", "before component tasks", "Frontend Component Spec", "No code skeletons.", "File path:", "Base component:", "Props/types:", "Variants:", "States: default, hover, focus-visible, active, disabled, loading, empty, error", "Tokens (by name):", "Layout per breakpoint:", "Motion: token, trigger", "prefers-reduced-motion", "Accessibility: role, keyboard, aria", "Verification viewports: 375, 768, 1280 px by default"]) {
	if (!planTemplate.includes(part)) throw new Error("Plan template omitted " + part);
}
const planSkillPaths = [IMPECCABLE_SKILL_PATH, ANIMATE_SKILL_PATH, ANIMATION_VOCABULARY_SKILL_PATH, FIND_ANIMATION_OPPORTUNITIES_SKILL_PATH];
const absentPlan = composeWorkflowPrompt("plan", true, undefined, cwd);
const absentBridgePlan = String(promptContextForMode("plan", true, cwd).planPrompt);
if (!absentPlan?.includes(PLAN_FRONTEND_PROMPT) || !absentBridgePlan.includes(PLAN_FRONTEND_PROMPT)) throw new Error("Plan or bridge planPrompt omitted frontend clause");
if (!absentPlan?.includes("Do not modify files") || !PLAN_FRONTEND_PROMPT.includes("read-only")) throw new Error("Plan frontend guidance weakened read-only mode");
if (absentPlan?.includes(PLAN_REFERENCE_PROMPT) || absentBridgePlan.includes(PLAN_REFERENCE_PROMPT)) throw new Error("absent reference directory injected a Plan reference clause");
if (!PLAN_REFERENCE_PROMPT.includes("untrusted visual input") || !PLAN_REFERENCE_PROMPT.includes("never instructions") || !PLAN_REFERENCE_PROMPT.includes("never write files")) throw new Error("Plan reference clause weakened trust or read-only rules");
for (const skillPath of planSkillPaths) {
	if (!skillPath.startsWith("/") || !existsSync(skillPath) || !absentPlan?.includes(skillPath) || !absentBridgePlan.includes(skillPath)) throw new Error("Plan prompt omitted absolute packaged skill path " + skillPath);
}
const absentBuild = composeWorkflowPrompt("build", true, undefined, cwd);
if (absentBuild?.includes(BUILD_REFERENCE_PROMPT) || absentBuild?.includes(PLAN_REFERENCE_PROMPT)) throw new Error("absent reference directory injected a reference prompt");
if (!absentBuild?.includes(BUILD_DESIGN_AWARE_PROMPT) || !absentBuild.includes(BUILD_FRONTEND_VERIFICATION_PROMPT)) throw new Error("Build authority or verification rule missing without manifest");
const absentBridgeBuild = String(promptContextForMode("build", true, cwd).buildPrompt);
if (!absentBridgeBuild.includes(BUILD_DESIGN_AWARE_PROMPT) || !absentBridgeBuild.includes(BUILD_FRONTEND_VERIFICATION_PROMPT)) throw new Error("bridge buildPrompt omitted spec authority or visual gate");
mkdirSync(join(cwd, "docs/design/reference"), { recursive: true });
const referenceBuild = composeWorkflowPrompt("build", true, undefined, cwd);
if (!referenceBuild?.includes(BUILD_REFERENCE_PROMPT) || !referenceBuild.includes(BUILD_DESIGN_AWARE_PROMPT) || referenceBuild.includes(PLAN_REFERENCE_PROMPT)) throw new Error("reference failed to inject Build authority and reference guidance only");
const referencePlan = composeWorkflowPrompt("plan", true, undefined, cwd);
const referenceBridgePlan = String(promptContextForMode("plan", true, cwd).planPrompt);
if (!referencePlan?.includes(PLAN_REFERENCE_PROMPT) || !referenceBridgePlan.includes(PLAN_REFERENCE_PROMPT) || referencePlan.includes(BUILD_REFERENCE_PROMPT)) throw new Error("reference snapshots were not conditionally routed only to Plan");
for (const mode of ["discuss", "review"] as const) {
	const prompt = composeWorkflowPrompt(mode, true, undefined, cwd);
	if (prompt?.includes(BUILD_REFERENCE_PROMPT) || prompt?.includes(PLAN_REFERENCE_PROMPT)) throw new Error(mode + " mode injected a reference prompt");
}
const noCwdBuild = composeWorkflowPrompt("build", true);
const noCwdPlan = composeWorkflowPrompt("plan", true);
if (noCwdBuild?.includes(BUILD_REFERENCE_PROMPT) || noCwdBuild?.includes(PLAN_REFERENCE_PROMPT) || noCwdPlan?.includes(PLAN_REFERENCE_PROMPT)) throw new Error("reference prompt injected without cwd");
mkdirSync(join(cwd, "docs/design"), { recursive: true });
writeFileSync(join(cwd, "docs/design/manifest.json"), "{}");
if (!composeWorkflowPrompt("build", true, undefined, cwd)?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("manifest failed to inject design block");
const buildPrompt = composeWorkflowPrompt("build", true, undefined, cwd);
const designAwareIndex = buildPrompt?.indexOf(BUILD_DESIGN_AWARE_PROMPT) ?? -1;
const referenceIndex = buildPrompt?.indexOf(BUILD_REFERENCE_PROMPT) ?? -1;
if (designAwareIndex < 0 || referenceIndex <= designAwareIndex) throw new Error("Build reference prompt order was not design-aware then reference");
if (!buildPrompt?.includes("workflow_plan_tick") || !buildPrompt.includes("authoritative queue") || !buildPrompt.includes("immutable seed text")) throw new Error("Build prompt omitted tracker queue rules");
if (!buildPrompt.includes("at most two parallel slice workers") || !buildPrompt.includes("concurrencyCap is default or at least 3") || !buildPrompt.includes("Wait for every slice result before consolidating") || !buildPrompt.includes("Never fan out across saved-plan tasks") || buildPrompt.includes("exactly one worker per task")) throw new Error("Build prompt omitted within-task slicing rules or retained the single-worker rule");
if (!buildPrompt?.includes("end your turn; results arrive as a new turn") || !buildPrompt.includes("only when the user asks for status or to find a transcript or log") || !buildPrompt.includes("live steering. Child questions go to the user automatically; do not answer them yourself unless the user asks")) throw new Error("Build prompt omitted automatic delegation delivery guidance");
for (const mode of ["discuss", "plan", "build", "review"] as const) {
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
const warnings: string[] = [];
const statuses: string[] = [];
const eventListeners = new Map<string, Function[]>();
const events = {
	on(name: string, handler: Function) {
		const listeners = eventListeners.get(name) ?? [];
		listeners.push(handler);
		eventListeners.set(name, listeners);
	},
	emit(name: string, payload?: unknown) {
		for (const listener of eventListeners.get(name) ?? []) listener(payload);
	},
};
let branchEntries: any[] = [{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } }];
let failSend = false;
let failModeAppend = false;
workflowModesExtension({
	events,
	on(name: string, handler: Function) { handlers.set(name, handler); },
	registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
	registerTool(tool: any) { tools.set(tool.name, tool); },
	appendEntry(type: string, data: unknown) {
		if (failModeAppend && type === MODE_ENTRY) throw new Error("append failed");
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
	ui: { setStatus(key: string, message: string) { statuses.push(key + ":" + message); }, notify(message: string, level?: string) { notifications.push(message); if (level === "warning") warnings.push(message); } },
};
Promise.resolve(handlers.get("session_start")?.({}, context)).then(async () => {
	// Restoring a Build branch lands in Plan durably, so it never claims the writer unguarded.
	const landed = operations.find((operation) => operation.action === "append" && operation.type === MODE_ENTRY)?.data as { mode?: string; restoredFrom?: string } | undefined;
	if (landed?.mode !== "plan" || landed.restoredFrom !== "build") throw new Error("restored Build did not durably land in Plan");
	if (notifications.filter((message) => message.includes("Build mode is not restored")).length !== 1) throw new Error("restored Build did not notify exactly once");
	operations.length = 0;
	notifications.length = 0;
	await commands.get("mode")?.handler("build", context);
	return handlers.get("before_agent_start")?.({ systemPrompt: "BASE" });
}).then(async (result: unknown) => {
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
	const tickNote = "unverified: browser unavailable";
	const ticked = await tickTool.execute("tick-call", { taskId: seededTaskId, note: "  " + tickNote + "  " }, undefined, undefined, context);
	const storedTick = operations[0]?.data as { event?: string; planId?: string; taskId?: string; note?: string };
	if (storedTick?.event !== "tick" || storedTick.taskId !== seededTaskId || storedTick.note !== tickNote) throw new Error("task tick note was not trimmed and appended");
	if (readFileSync(savedDetails.path, "utf8") !== "# Hand edited\\n\\n## Section 4 — Tasks\\n- [ ] Edited task\\n") throw new Error("task tick mutated plan file");
	const tickedDetails = ticked.details as { note?: string; progress?: { done: number; total: number }; idempotent?: boolean };
	if (!tickedDetails.progress || tickedDetails.progress.done !== 1 || tickedDetails.note !== tickNote || tickedDetails.idempotent) throw new Error("task tick result missing progress or note");
	if (!String(ticked.content?.[0]?.text).includes(JSON.stringify(tickNote))) throw new Error("task tick text omitted safely quoted note");
	if (!statuses.some((status) => status.includes(savedDetails.planId!) && status.includes("1/1"))) throw new Error("status did not update task progress");
	const repeated = await tickTool.execute("tick-call-replay", { taskId: seededTaskId, note: "replacement note" }, undefined, undefined, context);
	if (!(repeated.details as { idempotent?: boolean; note?: string }).idempotent || (repeated.details as { note?: string }).note !== tickNote || operations.length !== 1 || (operations[0]?.data as { note?: string }).note !== tickNote) throw new Error("repeated task tick changed first note or was not idempotent");
	for (const [label, note] of [["empty", ""], ["whitespace", "   "], ["oversized", "x".repeat(501)], ["wrong-type", 17]] as const) {
		let noteError = "";
		try {
			await tickTool.execute("tick-invalid-" + label, { taskId: seededTaskId, note }, undefined, undefined, context);
		} catch (error) {
			noteError = error instanceof Error ? error.message : String(error);
		}
		if (!noteError.includes("note") || !noteError.includes("500")) throw new Error(label + " tick note was not rejected clearly");
	}
	let extraKeyError = "";
	try {
		await tickTool.execute("tick-invalid-key", { taskId: seededTaskId, unknown: true }, undefined, undefined, context);
	} catch (error) {
		extraKeyError = error instanceof Error ? error.message : String(error);
	}
	if (!extraKeyError.includes("only taskId, title, and note")) throw new Error("unknown tick key was not rejected clearly");
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
	await commands.get("mode")?.handler("build", context);
	if (operations[0]?.action !== "append") throw new Error("Build without guard listeners did not proceed");
	let guardMode = "blocked";
	let guardCalls = 0;
	const changedEvents: unknown[] = [];
	// Mirrors claude-bridge: the blocker phrase carries its own remediation.
	const holderBlocker = "cursor:holder; release it in that Pi session with /build-lease release or by leaving Build";
	events.on("workflow-modes:build-guard", (payload: { blockedBy?: string }) => {
		guardCalls++;
		if (guardMode === "blocked") payload.blockedBy = holderBlocker;
		if (guardMode === "throwing") {
			payload.blockedBy = holderBlocker;
			throw new Error("listener failed");
		}
	});
	events.on("workflow-modes:changed", (payload: unknown) => changedEvents.push(payload));
	operations.length = 0;
	notifications.length = 0;
	changedEvents.length = 0;
	guardCalls = 0;
	await commands.get("mode")?.handler("discuss", context);
	if (guardCalls !== 0 || operations.length !== 1 || changedEvents.length !== 1) throw new Error("Build guard affected non-Build mode");
	operations.length = 0;
	notifications.length = 0;
	warnings.length = 0;
	changedEvents.length = 0;
	guardCalls = 0;
	await commands.get("mode")?.handler("build", context);
	if (guardCalls !== 1 || operations.length !== 0 || changedEvents.length !== 0) throw new Error("blocked Build mode changed durable or live mode");
	if (!warnings.some((message) => message.includes("cursor:holder") && message.includes("/build-lease release"))) throw new Error("blocked Build warning omitted warning level, holder, or release command");
	guardMode = "unblocked";
	operations.length = 0;
	notifications.length = 0;
	changedEvents.length = 0;
	await commands.get("mode")?.handler("build", context);
	if (operations[0]?.action !== "append" || changedEvents.length !== 1) throw new Error("unblocked Build mode did not proceed");
	guardMode = "throwing";
	operations.length = 0;
	notifications.length = 0;
	changedEvents.length = 0;
	warnings.length = 0;
	await commands.get("mode")?.handler("build", context);
	if (operations.length !== 0 || changedEvents.length !== 0 || !warnings.some((message) => message.includes("cursor:holder"))) throw new Error("throwing guard listener did not fail closed with its blocker");
	guardMode = "unblocked";
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
	for (const mode of ["discuss", "plan", "review"] as const) {
		const reason = formatModeBlockReason(mode, "operation was blocked.");
		if (!reason.includes("Workflow mode was " + MODE_LABELS[mode] + " at tool-call time.")) throw new Error(mode + " block reason was not mode-stamped");
		if (!reason.includes("latest [workflow-modes] line")) throw new Error(mode + " block reason omitted authoritative line");
		if (reason.includes("/mode")) throw new Error(mode + " block reason instructed a mode switch");
	}
	const toolCall = handlers.get("tool_call");
	const modeContext = (mode: string, priorMode?: string) => ({
		sessionManager: { getBranch: () => [...(priorMode ? [{ type: "custom", customType: MODE_ENTRY, data: { mode: priorMode } }] : []), { type: "custom", customType: MODE_ENTRY, data: { mode } }], getSessionId: () => "session-test" },
		ui: context.ui,
	});
	handlers.get("session_start")?.({}, modeContext("discuss"));
	const mutationBlock = await toolCall?.({ toolName: "edit", input: { path: "README.md" } }) as { reason?: string };
	if (!mutationBlock.reason?.startsWith("edit was blocked.")) throw new Error("mutation block reason was not past-tense");
	const browserMutationTools = ["browser_goto", "browser_eval", "browser_click", "browser_fill", "browser_close", "browser_kill"];
	const browserReadTools = ["browser_console", "browser_screenshot", "browser_network"];
	for (const mode of ["discuss", "plan", "review"] as const) {
		handlers.get("session_start")?.({}, modeContext(mode));
		for (const toolName of browserMutationTools) {
			const blocked = await toolCall?.({ toolName, input: {} }) as { reason?: string };
			if (!blocked.reason?.startsWith(toolName + " was blocked.")) throw new Error(mode + " " + toolName + " was not blocked");
		}
		for (const toolName of browserReadTools) {
			if (await toolCall?.({ toolName, input: {} }) !== undefined) throw new Error(mode + " " + toolName + " was blocked");
		}
	}
	// Restoring a Build branch lands in Plan; Build is entered only through the guarded /mode build.
	await handlers.get("session_start")?.({}, modeContext("build"));
	if (await toolCall?.({ toolName: "write", input: {} }) === undefined) throw new Error("restored Build session allowed a write");
	operations.length = 0;
	notifications.length = 0;
	await handlers.get("session_tree")?.({}, modeContext("build"));
	const treeLanding = operations.filter((operation) => operation.action === "append" && operation.type === MODE_ENTRY);
	if (treeLanding.length !== 1 || (treeLanding[0]?.data as { mode?: string }).mode !== "plan") throw new Error("tree navigation into Build did not land in Plan");
	operations.length = 0;
	notifications.length = 0;
	await handlers.get("session_start")?.({}, modeContext("plan"));
	await handlers.get("session_start")?.({}, modeContext("off"));
	if (operations.some((operation) => operation.action === "append" && operation.type === MODE_ENTRY) || notifications.some((message) => message.includes("Build mode is not restored"))) throw new Error("restoring Plan or Off changed mode");
	// The landing refreshes the status bar before it awaits the save.
	statuses.length = 0;
	const statusLanding = handlers.get("session_tree")?.({}, modeContext("build"));
	if (!statuses.at(-1)?.includes("Mode: Plan")) throw new Error("restore landing did not refresh the status bar at once");
	await statusLanding;
	// /reload is not a restore: this process already entered Build through the guard.
	operations.length = 0;
	notifications.length = 0;
	await handlers.get("session_start")?.({ reason: "reload" }, modeContext("build"));
	if (operations.some((operation) => operation.action === "append" && operation.type === MODE_ENTRY) || notifications.some((message) => message.includes("Build mode"))) throw new Error("reload landed Build in Plan");
	if (await toolCall?.({ toolName: "write", input: {} }) !== undefined) throw new Error("reload left Build without its guarded writes");
	// A UI failure after a successful save is not reported as a save failure, and never rejects.
	const notifyCalls: string[] = [];
	const throwingUI = { setStatus: context.ui.setStatus, notify(message: string) { notifyCalls.push(message); throw new Error("ui gone"); } };
	await handlers.get("session_tree")?.({}, { ...modeContext("build"), ui: throwingUI });
	if (notifyCalls.length !== 1 || !notifyCalls[0]?.includes("Build mode is not restored automatically")) throw new Error("notify failure was misreported as a save failure");
	if (await toolCall?.({ toolName: "write", input: {} }) === undefined) throw new Error("landing with a throwing notify left Build writable");
	// A failed save still lands in Plan and says so.
	failModeAppend = true;
	warnings.length = 0;
	await handlers.get("session_tree")?.({}, modeContext("build"));
	failModeAppend = false;
	if (!warnings.some((message) => message.includes("saving the switch to Plan failed"))) throw new Error("failed landing save was not reported");
	if (await toolCall?.({ toolName: "write", input: {} }) === undefined) throw new Error("failed landing save left Build writable");
	await commands.get("mode")?.handler("build", context);
	for (const toolName of [...browserMutationTools, ...browserReadTools]) {
		if (await toolCall?.({ toolName, input: {} }) !== undefined) throw new Error("Build " + toolName + " was blocked");
	}
	const guardedBuildTools = ["write", "edit", "bash", "subagent", "subagent_message", "workflow_plan_tick", "remember", "some_future_tool", ...browserMutationTools];
	for (const toolName of guardedBuildTools) {
		if (await toolCall?.({ toolName, input: { command: "echo build" } }) !== undefined) throw new Error("unblocked Build " + toolName + " was blocked");
	}
	guardMode = "blocked";
	for (const toolName of guardedBuildTools) {
		const blocked = await toolCall?.({ toolName, input: { command: "echo build" } }) as { block?: boolean; reason?: string } | undefined;
		if (blocked?.block !== true || !blocked.reason?.startsWith(toolName + " was blocked") || !blocked.reason.includes("cursor:holder") || !blocked.reason.includes("/build-lease release")) throw new Error("Build " + toolName + " ignored another writer claim");
	}
	guardCalls = 0;
	for (const toolName of ["read", "grep", "find", "ls", "ask_user_question", "ccc_search", "workflow_plan_tasks", "subagents_list", ...browserReadTools]) {
		if (await toolCall?.({ toolName, input: {} }) !== undefined) throw new Error("Build read tool " + toolName + " was blocked by a writer claim");
	}
	if (guardCalls !== 0) throw new Error("Build read-only tools asked the writer guard");
	guardMode = "throwing";
	for (const toolName of ["write", "subagent"]) {
		const blocked = await toolCall?.({ toolName, input: {} }) as { block?: boolean; reason?: string } | undefined;
		if (blocked?.block !== true || !blocked.reason?.includes("cursor:holder")) throw new Error("throwing guard listener let Build " + toolName + " through");
	}
	guardMode = "blocked";
	handlers.get("session_start")?.({}, modeContext("off"));
	for (const toolName of ["write", "edit", "bash"]) {
		if (await toolCall?.({ toolName, input: { command: "echo off" } }) !== undefined) throw new Error("Off " + toolName + " was guarded");
	}
	guardMode = "unblocked";
	handlers.get("session_start")?.({}, modeContext("discuss"));
	const readEvent = { toolName: "bash", input: { command: "rg workflow-mode-no-match" } };
	if (await toolCall?.(readEvent) !== undefined) throw new Error("Discuss read command was blocked");
	const expectedWrap = wrapCommand("rg workflow-mode-no-match", { cwd: process.cwd() });
	if (readEvent.input.command !== expectedWrap.command) throw new Error("wrapped command was not passed through unchanged");
	if (readEvent.input.command.includes("Hint: editing requires") || readEvent.input.command.includes("status=$?")) throw new Error("wrapped command retained bash hint suffix");
	handlers.get("session_start")?.({}, modeContext("review"));
	const reviewBlock = await toolCall?.({ toolName: "bash", input: { command: "curl example.com" } }) as { reason?: string };
	if (!reviewBlock.reason?.startsWith("bash command was blocked;")) throw new Error("Review block reason was not past-tense");
	// No sandbox: a removed cwd makes wrapping fail for real, so the handler's
	// no-sandbox branch runs without any test-only override.
	const confirms: string[] = [];
	let approve = true;
	const confirmUI = { setStatus: context.ui.setStatus, notify: context.ui.notify, confirm: async (title: string, message?: string) => { confirms.push(title + " | " + message); return approve; } };
	const askContext = { hasUI: true, ui: confirmUI };
	const startDir = process.cwd();
	const withoutSandbox = async (run: () => Promise<void>) => {
		const goneDir = mkdtempSync(join(tmpdir(), "wm-no-sandbox-"));
		process.chdir(goneDir);
		rmdirSync(goneDir);
		try { await run(); } finally { process.chdir(startDir); }
	};
	await withoutSandbox(async () => {
		const reviewRead = await toolCall?.({ toolName: "bash", input: { command: "rg --pre sh x ." } }, askContext);
		if (reviewRead !== undefined || confirms.length !== 1 || !confirms[0]?.startsWith("Run without sandbox? | rg --pre sh x .")) throw new Error("unsandboxed Review auto-ran or skipped approval");
		approve = false;
		const reviewDeclined = await toolCall?.({ toolName: "bash", input: { command: "sort -o out seed.txt" } }, askContext) as { block?: boolean; reason?: string } | undefined;
		if (reviewDeclined?.block !== true || !reviewDeclined.reason?.includes("declined or approval was unavailable")) throw new Error("declined unsandboxed Review command ran");
		const reviewHeadless = await toolCall?.({ toolName: "bash", input: { command: "git status" } }, { hasUI: false, ui: confirmUI }) as { block?: boolean } | undefined;
		if (reviewHeadless?.block !== true) throw new Error("headless unsandboxed Review ran bash");
		approve = true;
		confirms.length = 0;
		const posting = await toolCall?.({ toolName: "bash", input: { command: "gh pr review 1 --body ok" } }, askContext);
		if (posting !== undefined || confirms.length !== 1 || !confirms[0]?.startsWith("Post this GitHub review?")) throw new Error("unsandboxed Review posting was not confirmed exactly once");
	});
	await handlers.get("session_start")?.({}, modeContext("plan"));
	confirms.length = 0;
	await withoutSandbox(async () => {
		if (await toolCall?.({ toolName: "bash", input: { command: "make test" } }, askContext) !== undefined || !confirms[0]?.startsWith("Run without sandbox? | make test")) throw new Error("unsandboxed Plan did not ask before running");
		const planDenied = await toolCall?.({ toolName: "bash", input: { command: "ls\\nrm x" } }, askContext) as { block?: boolean; reason?: string } | undefined;
		if (planDenied?.block !== true || !planDenied.reason?.includes("Plan runs only single-line commands") || confirms.length !== 1) throw new Error("unsandboxed Plan did not deny a multi-line command");
	});
	await handlers.get("session_start")?.({}, modeContext("discuss"));
	confirms.length = 0;
	await withoutSandbox(async () => {
		const discussDenied = await toolCall?.({ toolName: "bash", input: { command: "ls" } }, askContext) as { block?: boolean; reason?: string } | undefined;
		if (discussDenied?.block !== true || !discussDenied.reason?.includes("Discuss does not run bash") || confirms.length !== 0) throw new Error("unsandboxed Discuss ran or asked about bash");
	});
	handlers.get("session_start")?.({}, modeContext("design", "build"));
	const legacyTurn = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }) as { message?: { content?: string }; systemPrompt?: string };
	if (!legacyTurn.message?.content?.includes("UNKNOWN (read-only") || !legacyTurn.systemPrompt?.includes("unknown or legacy")) throw new Error("legacy mode was not announced as read-only");
	for (const toolName of ["write", "edit", "browser_goto"]) {
		const blocked = await toolCall?.({ toolName, input: { path: "docs/design/manifest.json" } }) as { block?: boolean; reason?: string };
		if (blocked.block !== true || !blocked.reason?.includes("Unknown workflow mode")) throw new Error("legacy mode allowed " + toolName);
	}
	const legacyBash = await toolCall?.({ toolName: "bash", input: { command: "echo x > file" } }) as { block?: boolean; reason?: string };
	if (legacyBash.block !== true || !legacyBash.reason?.includes("Unknown workflow mode")) throw new Error("legacy mode allowed Bash");
	operations.length = 0;
	warnings.length = 0;
	await commands.get("mode")?.handler("design", context);
	if (operations.length !== 0 || !warnings.some((message) => message.includes("Unknown mode"))) throw new Error("/mode design was not rejected as unknown");
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
