import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Container, matchesKey, SelectList, Text, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { DESIGN_DIR, DESIGN_MANIFEST_FILE } from "../engineering-docs/design.js";
import { CAVEMAN_ENTRY, CAVEMAN_PROMPT, composeWorkflowPrompt as composePrompt, NORMAL_MODE_PROMPT, resolveCavemanEnabled } from "./caveman.js";
import { BASH_MUTATION_DENY, BASH_WRITE_REDIRECT, DISCUSS_BASH_ALLOW, PLAN_BASH_ALLOW, REVIEW_BASH_DENY, isBashAllowedInMode, isDesignWriteAllowed } from "./policy.js";
import { resolveSavedPlanState } from "./plan-state.js";
import { wrapCommand } from "./sandbox.js";

export type Mode = "off" | "discuss" | "plan" | "build" | "review" | "design";
export type PlanEvent = "set" | "clear";

export const MODE_ENTRY = "workflow-mode-set";
export const PLAN_ENTRY = "workflow-plan";
export const STATUS_KEY = "workflow-modes";
export const MUTATION_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export { CAVEMAN_ENTRY, CAVEMAN_PROMPT, NORMAL_MODE_PROMPT, resolveCavemanEnabled } from "./caveman.js";
export { BASH_MUTATION_DENY, BASH_WRITE_REDIRECT, DISCUSS_BASH_ALLOW, PLAN_BASH_ALLOW, REVIEW_BASH_ALLOW, REVIEW_BASH_DENY } from "./policy.js";

export interface WorkflowPolicySnapshot {
	mutationTools: string[];
	discussBashAllow: string;
}

export function getWorkflowPolicySnapshot(): WorkflowPolicySnapshot {
	return {
		mutationTools: Array.from(MUTATION_TOOLS),
		discussBashAllow: DISCUSS_BASH_ALLOW.source,
	};
}

const MODE_LABELS: Record<Mode, string> = {
	off: "OFF",
	discuss: "Discuss",
	plan: "Plan",
	build: "Build",
	review: "Review",
	design: "Design",
};

let currentMode: Mode = "off";
let cavemanEnabled = true;
let currentPlan: string | undefined;
let currentPlanId: string | undefined;
let currentPlanSavedAt: string | undefined;
let latestContext: ExtensionContext | null = null;

function normalizeMode(raw: string): Mode | undefined {
	const value = raw.trim().toLowerCase();
	if (value === "off" || value === "none") return "off";
	if (value === "discuss" || value === "discussion") return "discuss";
	if (value === "plan" || value === "planning") return "plan";
	if (value === "build" || value === "building") return "build";
	if (value === "review" || value === "reviewing") return "review";
	if (value === "design" || value === "designing") return "design";
	return undefined;
}

function normalizePlanAction(raw: string): "view" | "save" | "clear" | undefined {
	const value = raw.trim().toLowerCase();
	if (value === "view" || value === "show") return "view";
	if (value === "save" || value === "set") return "save";
	if (value === "clear" || value === "delete" || value === "remove") return "clear";
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				return String((part as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function getLastAssistantText(ctx: ExtensionContext): string | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		const maybe = entry as { type?: string; message?: { role?: string; content?: unknown }; role?: string; content?: unknown };
		const message = maybe.message ?? maybe;
		if (message.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function reconstructFromBranch(ctx: ExtensionContext): void {
	currentMode = "off";
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const mode = normalizeMode(String((e.data as { mode?: unknown } | undefined)?.mode ?? ""));
		if (mode) currentMode = mode;
	}
	cavemanEnabled = resolveCavemanEnabled(branch);
	const plan = resolveSavedPlanState(branch, PLAN_ENTRY);
	currentPlan = plan?.plan;
	currentPlanId = plan?.planId;
	currentPlanSavedAt = plan?.savedAt;
	updateStatus(ctx);
}

function updateStatus(ctx: ExtensionContext): void {
	const cavemanStatus = `${cavemanEnabled ? "ON" : "OFF"}${currentMode === "off" ? " (inactive)" : ""}`;
	ctx.ui.setStatus(STATUS_KEY, `Mode: ${MODE_LABELS[currentMode]} Saved Plan: ${currentPlan ? "ON" : "OFF"} Caveman: ${cavemanStatus}`);
}

async function setMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: Mode): Promise<void> {
	currentMode = mode;
	await Promise.resolve(pi.appendEntry(MODE_ENTRY, { mode, at: Date.now() }));
	updateStatus(ctx);
	ctx.ui.notify(`Mode: ${MODE_LABELS[mode]}`, "info");
	pi.events.emit("workflow-modes:changed", { mode: currentMode, hasPlan: currentPlan !== undefined });
}

async function selectOverlay(ctx: ExtensionCommandContext, title: string, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(String(item.value));
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "60%", minWidth: 42, maxHeight: "70%", margin: 2, anchor: "center" } });
}

async function chooseMode(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Use /mode <off|discuss|plan|build|review|design>.", "warning");
		return;
	}
	const items: SelectItem[] = (["off", "discuss", "plan", "build", "review", "design"] as Mode[]).map((mode) => ({
		value: mode,
		label: `${MODE_LABELS[mode]}${mode === currentMode ? " (current)" : ""}`,
		description:
			mode === "off"
				? "Normal Pi behavior"
				: mode === "discuss"
					? "Grill the idea/feature; read/search only"
					: mode === "plan"
						? "Grill implementation plan; read/search only"
						: mode === "review"
							? "Review changes; read-only"
							: mode === "design"
								? "Design tokens and component specs"
								: "Build with normal tools",
	}));
	const choice = await selectOverlay(ctx, "Select Workflow Mode", items);
	if (choice) await setMode(pi, ctx, choice as Mode);
}

async function showPlan(ctx: ExtensionCommandContext): Promise<void> {
	if (!currentPlan) {
		ctx.ui.notify("No saved plan for this branch.", "info");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(currentPlan, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let offset = 0;
		return {
			render(width: number) {
				const inner = Math.max(20, width - 4);
				const wrapped = currentPlan!.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", inner));
				const height = Math.min(22, Math.max(6, wrapped.length));
				offset = Math.max(0, Math.min(offset, Math.max(0, wrapped.length - height)));
				const body = wrapped.slice(offset, offset + height).map((line) => `│ ${truncateToWidth(line, inner, "").padEnd(inner)} │`);
				const border = theme.fg("accent", `┌${"─".repeat(inner + 2)}┐`);
				const bottom = theme.fg("accent", `└${"─".repeat(inner + 2)}┘`);
				const title = `│ ${theme.fg("accent", theme.bold("Saved Plan"))}${" ".repeat(Math.max(0, inner - 10))} │`;
				const hint = `│ ${theme.fg("dim", "↑↓ scroll • esc/enter close")}${" ".repeat(Math.max(0, inner - 26))} │`;
				return [border, title, ...body, hint, bottom].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "escape") || matchesKey(data, "enter")) return done();
				if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
				if (matchesKey(data, "down")) offset += 1;
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", margin: 2, anchor: "center" } });
}

export async function setSavedWorkflowPlan(pi: ExtensionAPI, ctx: ExtensionContext, text: string, metadata: { planId?: string; savedAt?: string } = {}): Promise<{ event: "set"; plan: string; at: number; planId: string; savedAt: string }> {
	if (typeof text !== "string" || text.trim().length === 0) throw new Error("plan text is required");
	const planId = metadata.planId ?? randomUUID();
	if (typeof planId !== "string" || planId.trim().length === 0) throw new Error("planId is required");
	const savedAt = metadata.savedAt ?? new Date().toISOString();
	if (Number.isNaN(Date.parse(savedAt))) throw new Error("savedAt must be an ISO date");
	const entry = { event: "set" satisfies PlanEvent, plan: text, planId, savedAt, at: Date.parse(savedAt) };
	pi.appendEntry(PLAN_ENTRY, entry);
	currentPlan = text;
	currentPlanId = planId;
	currentPlanSavedAt = savedAt;
	updateStatus(ctx);
	pi.events.emit("workflow-modes:changed", { mode: currentMode, hasPlan: true });
	return entry;
}

async function savePlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx);
	if (!text) return ctx.ui.notify("No assistant message found to save as the current plan.", "warning");
	if (currentPlan) {
		const ok = await ctx.ui.confirm("Overwrite plan?", "Overwrite the existing saved plan for this branch?");
		if (!ok) return;
	}
	await setSavedWorkflowPlan(pi, ctx, text);
	ctx.ui.notify("Saved current plan from the last assistant message.", "success");
}

async function clearPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!currentPlan) return ctx.ui.notify("No saved plan for this branch.", "info");
	const ok = await ctx.ui.confirm("Clear plan?", "Clear the saved plan for this branch?");
	if (!ok) return;
	pi.appendEntry(PLAN_ENTRY, { event: "clear" satisfies PlanEvent, at: Date.now() });
	currentPlan = undefined;
	currentPlanId = undefined;
	currentPlanSavedAt = undefined;
	updateStatus(ctx);
	ctx.ui.notify("Cleared saved plan.", "success");
	pi.events.emit("workflow-modes:changed", { mode: currentMode, hasPlan: false });
}

async function choosePlanAction(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("Use /plan <view|save|clear>.", "warning");
	const choice = await selectOverlay(ctx, "Plan", [
		{ value: "view", label: "View", description: currentPlan ? "View saved plan" : "No saved plan" },
		{ value: "save", label: "Save last assistant message", description: currentPlan ? "Overwrite current plan" : "Save current plan" },
		{ value: "clear", label: "Clear", description: "Clear saved plan" },
	]);
	if (choice === "view") await showPlan(ctx);
	if (choice === "save") await savePlan(pi, ctx);
	if (choice === "clear") await clearPlan(pi, ctx);
}

export const PLAN_TEMPLATE_PATH = fileURLToPath(new URL("./plan-template.md", import.meta.url));

export const DISCUSS_PROMPT = `Workflow mode: Discuss. Behave like a relentless grilling session for the idea or feature. Ask one main question at a time and provide your recommended answer. If a question can be answered by lightly inspecting the codebase, inspect it instead. Prefer ccc_search for semantic discovery; use read plus light read-only Bash discovery (pwd, ls, find, rg, grep) for exact lookup or fallback. When spawn_explorer is available, use it sparingly for genuine multi-file or multi-symbol sweeps; keep quick lookups inline. The main agent remains synthesizer and decision-maker. Do not run tests/builds unless the user explicitly asks. Focus on user value, feature boundaries, terminology, edge cases, and how the idea fits existing behavior. Capture durable requirements, decisions, constraints, open questions, and lessons learned from failures with discussion_notes automatically. A lesson must pair a failure with its resolution. Do not implement or produce detailed code-level plans. Do not claim facts are confirmed unless backed by tool evidence or user-provided evidence. Use recall_memory when prior cross-session memory may be relevant. When the idea is shaped enough, softly suggest switching to Plan mode with /mode plan. Ponytail lazy-senior-dev reflex: favor minimalism. Question whether the request itself matches the actual need (YAGNI), separate required behavior from nice-to-haves, and prefer the smallest approach: deletion over addition, boring over clever, fewest files possible. Never trade away input validation at trust boundaries, error handling that prevents data loss, security, accessibility, or explicitly requested features.`;

export const PLAN_PROMPT = `Workflow mode: Plan. Behave like a relentless implementation-planning session. Investigate before planning. When spawn_explorer is available, default to it for multi-file, multi-symbol, or fan-out discovery; use direct reads mainly to verify surfaced paths or inspect focused evidence. The main agent remains synthesizer, planner, and decision-maker. Use codebase discovery instead of asking when possible: pwd/ls for repo shape, ccc_search for semantic discovery, rg/find/grep for exact files/symbols, then read verified paths. If ccc_search times out, retry once with a narrower query, then fall back to rg/find/read. Verify paths before reading; do not guess paths into ENOENT loops. Run tests/builds/checks/lint/typecheck when useful to reproduce or localize failures; normal caches/artifacts are OK, but source/config/data mutations are not. Automatically write discussion_notes for confirmed durable requirements, decisions, constraints, open questions, important implementation facts, and lessons learned from failures encountered during investigation. A lesson note must include both what failed and the correct approach. Confidence is evidence-gated: say "confirmed" only with successful tool evidence or user-provided evidence; otherwise say likely/hypothesis. Do not give a recommended fix until at least one code location/symbol/file is verified. Use recall_memory when prior cross-session memory may be relevant. Final plans must include a short Evidence section with path/line refs or test/build output, Target files, Plan steps, Open questions if any, and "Switch /mode build to apply." Ask product questions after discovery and before final plan if the answer changes target behavior. Do not modify files or create repo docs. Even for tiny obvious fixes, stop before edits. Ponytail lazy-senior-dev reflex during investigation and task breakdown: climb the ladder — is it necessary (YAGNI)? does the stdlib, a native platform feature, or an already-installed dependency cover it? Prefer deletion over addition, boring over clever, fewest files possible, and fold redundant work into existing tasks so the plan stays minimal. Keep input validation, error handling that prevents data loss, security, accessibility, and explicitly requested features non-negotiable.\n\nWhen the user confirms the approach and asks you to produce the final plan, read ${PLAN_TEMPLATE_PATH} and follow its structure exactly.`;

export const REVIEW_PROMPT = `Workflow mode: Review. Act as a read-only PR reviewer: inspect and assess changes, never modify the repository. When available, use GitHub PR read data from \`gh pr view\`, \`gh pr diff\`, and \`gh pr checks\` or status as the review source. Grade changes against \`docs/engineering/invariants.md\`, \`conventions.md\`, and \`traps.md\`. Draft findings and a verdict first; findings must cite \`file:line\` in plain text. Never auto-post a review: ask for explicit user confirmation immediately before publishing. Publish at most one verdict with \`gh pr review\` using inline \`--body\` only (never a body file). Fetch, merge, and branch alignment happen in Build mode.`;

export const DESIGN_PROMPT = `Workflow mode: Design. Design-system work only. Write only under docs/design/ and declared token files; never app/component source or docs/engineering/. Inspect existing styles and components before creating tokens or specs; adopt or extract existing system instead of inventing a parallel one. If project builds on named base library (for example, shadcn), record it in docs/design/README.md and derive component specs from base components rather than reinventing them. Start tokens before components. Use /* @primitive */ and /* @semantic */ layers in token CSS. Semantic tokens define both light and dark values. Build roughly ten foundation component specs, curated enough to constrain later implementation. Never hard-code values: use token variables. Accessibility is non-negotiable. Every component spec and preview must be responsive-ready: mobile-first, fluid layouts, no fixed pixel widths; every component spec includes a Responsive section. Preview pages use a single-column vertical layout with stacked sections — never grid galleries or multi-column tile layouts. Previews must be viewable in both themes through project's theme-switch convention. Design surface only; suggest /mode build for component code.`;

export const BUILD_PROMPT = `Workflow mode: Build. Implement requested changes using the available tools.

Ponytail lazy-senior-dev mode. Before writing code, evaluate in order: 1) Is it necessary (YAGNI)? 2) Standard-library solution — use it. 3) Native platform feature — use it. 4) Existing dependency — use it. 5) Single-line solution — implement it. 6) Only then write minimal working code.
Reject unnecessary abstractions, new dependencies, and boilerplate — deletion over addition, boring over clever, fewest files possible. When stdlib options are equivalent in size, choose the edge-case-correct one. Mark intentional shortcuts with a \`ponytail:\` comment documenting the limitation and upgrade path. Scope all of this to the current task; do not re-litigate scope already decided in the saved plan.
Non-negotiable — these rules do NOT apply, never cut them: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and explicitly requested features.
Testing: non-trivial logic leaves ONE runnable check behind — an assert-based self-check or a single small framework-free test file; trivial one-liners need none.

General behavior:
- If no saved session plan is provided, handle ordinary build requests normally. Ask briefly if requirements are unclear.
- If a saved session plan is provided and the user request appears unrelated to it, ask whether to follow the plan, ignore it for this request, clear it, or replace it before proceeding.
- When implementation appears complete, softly remind the user to clear the saved plan with /plan clear if it is no longer needed.

Saved-plan task orchestration:
- When a saved session plan contains Section 4 — Tasks, treat only unchecked markdown tasks inside Section 4 as the task queue.
- A task is an unchecked top-level Section 4 checkbox line in the form \`- [ ] ...\`, plus its nested metadata lines such as Given/When/Then, NFRs, Verification Gate, and Checkpoint.
- Ignore checked tasks, prose, headings, numbered lists, and all Section 5 Definition of Done checklist items when selecting the next task.
- Do not mutate the saved plan or mark checkboxes as checked. Track progress through commits, chat reports, and discussion_notes.

Confirmation gates:
- Before starting task 1 from a saved Section 4 task queue, summarize the plan title or feature if available, total unchecked Section 4 tasks, and the first task. Then ask: \"Ready to start on task 1?\"
- Start task 1 only after explicit confirmation such as yes, y, proceed, continue, next task, or go ahead.
- After every completed, failed, or blocked task, stop and ask for explicit confirmation before starting another task.
- Treat non-confirmation replies as discussion or clarification, not permission to advance.

One-task-at-a-time rules:
- Execute exactly one Section 4 task per confirmation.
- Do not batch tasks, skip tasks, start future tasks opportunistically, or make broad unrelated changes.
- If a task is ambiguous or conflicts with NFRs or the saved plan, stop and ask the user.

Docs task rules:
- Tasks tagged [DOCS:architecture], [DOCS:dev-workflow], [DOCS:conventions], [DOCS:invariants], [DOCS:traps], or [DOCS:decisions] are normal Section 4 tasks — treat them like any other task.
- A [DOCS:decisions] task must include [ADR:new], [ADR:update], or [ADR:supersede].
- A bare [DOCS] tag without a specific area is invalid. Warn and ask for clarification.
- When executing a docs task: update the smallest relevant file(s) under docs/engineering/, commit, and regenerate the decision index if ADR files changed.
- When executing an ADR task: create/edit the ADR file with metadata (status, date, decision, why, affects, consequences, read-when), then run docs/engineering update-decision-index or equivalent.
- If a task changes project truth but has no [DOCS:*] tag, ask whether a docs task should be added before proceeding.

Per-task execution:
- Load the task block and relevant context package before editing.
- If the task names a skill with \`Use Skill: [skill]\`, load and follow that skill when applicable.
- For [LOAD-BEARING] tasks, before editing restate the invariants from the task's Given/When/Then and why they are load-bearing.
- Implement only what is needed for the current task.

Worker delegation:
- Use the worker-orchestration skill's A+B model for contract-first delegation. When spawn_worker is available and the confirmed task is substantial (multi-file or multi-step changes), spawn exactly one worker per task inside the Section-4 loop. Pass the task text as \`task\` and derive \`fileOwnership\` from the task's scope or target files. The parent agent retains task selection, Verification Gate, commit, and confirmation; the worker handles the isolated implementation.
- Skip worker delegation for trivial one-line tasks — execute them directly in the parent.
- Do not fan out multiple workers concurrently within the saved-plan loop. Parallel fan-out is reserved for ad-hoc multi-task requests that are not driven by a saved plan.
- Carry the ponytail reflex into delegation: include the minimalism bar (prefer reuse, stdlib, and existing dependencies; minimum viable for the task) in the worker's task text so the worker does not over-build what it is handed.

Verification:
- Run the task's Verification Gate first when possible.
- Run targeted checks appropriate to the changed files and task.
- Run the full suite only when the task or plan explicitly requires it, the task is [LOAD-BEARING], the change is load-bearing/risky, or it is clearly appropriate.
- If verification fails, stop. Do not commit or advance unless the user explicitly authorizes a deviation.
- For [LOAD-BEARING] tasks, explicitly verify each stated invariant before committing.

Checkpoint and commit:
- Commit after each successfully verified task before advancing to the next task.
- Use a task-specific commit message when possible.
- Report the commit hash.
- If commit fails, stop and ask the user how to proceed. Do not advance unless explicitly authorized.

Recall memory:
- Use recall_memory when prior cross-session memory may be relevant — especially before adopting a new approach in familiar code or when a problem feels familiar.

Discussion notes:
- When a tool call fails and a subsequent retry succeeds with a different approach, capture the resolution as a discussion_notes lesson. Include the failed approach, the failure signature, and the working approach. Capture lessons especially around: incorrect endpoint paths, environmental quirks (missing tools, non-standard layouts), command flags or syntax that don't work as expected, and configuration or build steps that aren't obvious from the code.
- After each successful task checkpoint, create a discussion_notes note recording the completed task, commit hash, verification summary, deviations if any, and next task if known.
- After each failed or blocked task checkpoint, create a discussion_notes note recording the blocked task, reason, verification status, commit status, and decision needed.

Required post-task report format:
- On success: Task completed, Commit, Verification, Deviations, Next task, then ask whether to proceed.
- On failure/block: Task blocked, Reason, Verification, Commit status, Next action needed, then ask how to proceed.
`;

export const BUILD_DESIGN_AWARE_PROMPT = `Consult docs/design/components/ specs before creating or modifying frontend components. Compose from documented components first. Documented means filled Purpose, Props/API, and Accessibility sections; template stubs do not count. If a genuinely new component has no documented spec, do not invent it silently: state spec is missing, suggest /mode design, proceed only with explicit user approval. Implementations follow spec Responsive section: mobile-first, no fixed widths.`;

export function composeWorkflowPrompt(mode: Mode, enabled: boolean, savedPlan?: string, cwd?: string): string | undefined {
	const buildPrompt = mode === "build" && cwd && existsSync(resolve(cwd, DESIGN_DIR, DESIGN_MANIFEST_FILE))
		? `${BUILD_PROMPT}\n\n${BUILD_DESIGN_AWARE_PROMPT}`
		: BUILD_PROMPT;
	return composePrompt(mode, enabled, { discuss: DISCUSS_PROMPT, plan: PLAN_PROMPT, build: buildPrompt, review: REVIEW_PROMPT, design: DESIGN_PROMPT }, savedPlan);
}

export default function (pi: ExtensionAPI) {
	pi.events.on("workflow-modes:save-plan", async (data: unknown) => {
		const request = data && typeof data === "object" ? data as { requestId?: unknown; plan?: unknown; planId?: unknown } : {};
		const requestId = typeof request.requestId === "string" ? request.requestId : undefined;
		const plan = typeof request.plan === "string" ? request.plan : undefined;
		const planId = typeof request.planId === "string" ? request.planId : requestId;
		const emitResult = (result: Record<string, unknown>) => {
			pi.events.emit("workflow-modes:save-plan-result", { requestId, planId, ...result });
		};
		if (!requestId) return emitResult({ ok: false, error: "workflow-modes save-plan requestId is required" });
		if (!plan || plan.trim().length === 0) return emitResult({ ok: false, error: "workflow-modes save-plan plan is required" });
		if (!latestContext) return emitResult({ ok: false, error: "workflow-modes has no active context" });
		try {
			const entry = await setSavedWorkflowPlan(pi, latestContext, plan, { planId });
			emitResult({ ok: true, planId: entry.planId, savedAt: entry.savedAt, chars: plan.length });
		} catch (error) {
			emitResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	// Public interop: other extensions emit "workflow-modes:get" to request state;
	// we respond by emitting "workflow-modes:state".
	pi.events.on("workflow-modes:get", () => {
		pi.events.emit("workflow-modes:state", {
			mode: currentMode,
			cavemanEnabled,
			hasPlan: currentPlan !== undefined,
			...(currentPlan ? { plan: currentPlan, planId: currentPlanId, savedAt: currentPlanSavedAt } : {}),
		});
	});

	// Re-emit state on session restore so late-loaded extensions can sync
	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		reconstructFromBranch(ctx);
		pi.events.emit("workflow-modes:changed", { mode: currentMode, hasPlan: currentPlan !== undefined });
	});
	pi.on("session_tree", async (_event, ctx) => {
		latestContext = ctx;
		reconstructFromBranch(ctx);
		pi.events.emit("workflow-modes:changed", { mode: currentMode, hasPlan: currentPlan !== undefined });
	});

	pi.on("before_agent_start", async (event) => {
		const extra = composeWorkflowPrompt(currentMode, cavemanEnabled, currentPlan, process.cwd());
		if (!extra) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
	});

	pi.on("tool_call", async (event) => {
			if (currentMode !== "discuss" && currentMode !== "plan" && currentMode !== "review" && currentMode !== "design") return;

		if (MUTATION_TOOLS.has(event.toolName)) {
			if (currentMode === "design") {
				const filePath = String((event.input as { path?: unknown }).path ?? "");
				if (filePath && await isDesignWriteAllowed(process.cwd(), filePath)) return;
				return {
					block: true,
					reason: `${event.toolName} is blocked outside design surface (docs/design/** and declared token files). Switch to Build mode with /mode build for implementation changes.`,
				};
			}
			return {
				block: true,
				reason: `${event.toolName} is blocked in ${MODE_LABELS[currentMode]} mode. Switch to Build mode with /mode build for implementation changes.`,
			};
		}

		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "").trim();

		// Review has an explicit allow-list; enforce it before sandboxing so a
		// missing or failing launcher cannot turn the review sandbox into a bypass.
		if (currentMode === "review" && !isBashAllowedInMode(command, "review")) {
			return {
				block: true,
				reason: "bash command blocked in Review mode. Only read commands and approved gh PR commands are allowed.",
			};
		}

		try {
			const wrapped = wrapCommand(command, { cwd: process.cwd(), ...(currentMode === "review" ? { allowNetwork: true } : {}) });
			if (wrapped.wrapped) {
				(event.input as { command?: string }).command = `${wrapped.command}; status=$?; if [ $status -ne 0 ]; then echo 'Hint: editing requires /mode build.' >&2; fi; exit $status`;
				return;
			}
		} catch {
			// Fall through to the conservative regex gate below. Read-only mode must never fail open or hard-crash.
		}

		const normalized = command.replace(/\s+/g, " ");
		const allowed = currentMode === "review"
			? isBashAllowedInMode(normalized, "review")
			: currentMode === "plan" || currentMode === "design" ? PLAN_BASH_ALLOW.test(normalized) : DISCUSS_BASH_ALLOW.test(normalized);
		const denied = BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized) || (currentMode === "review" && REVIEW_BASH_DENY.test(normalized));
		if (!allowed || denied) {
			return {
				block: true,
				reason: `bash command blocked in ${MODE_LABELS[currentMode]} mode. Allowed: ${currentMode === "plan" || currentMode === "design" ? "discovery plus tests/builds/checks" : currentMode === "review" ? "read commands plus approved gh PR commands" : "pwd, ls, find, rg, grep, ccc search"}. Mutating commands require /mode build.`,
			};
		}
	});

	pi.registerCommand("caveman", {
		description: "Toggle Caveman mode for active workflow modes",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value && value !== "on" && value !== "off") {
				return ctx.ui.notify("Unknown Caveman state. Use on or off.", "warning");
			}
			cavemanEnabled = value ? value === "on" : !cavemanEnabled;
			pi.appendEntry(CAVEMAN_ENTRY, { enabled: cavemanEnabled });
			updateStatus(ctx);
			ctx.ui.notify(`Caveman: ${cavemanEnabled ? "ON" : "OFF"}${currentMode === "off" ? " (inactive)" : ""}.`, "info");
		},
	});

	pi.registerCommand("mode", {
		description: "Select workflow mode: Off, Discuss, Plan, Build, Review, or Design",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) return chooseMode(pi, ctx);
			const mode = normalizeMode(arg);
			if (!mode) return ctx.ui.notify("Unknown mode. Use off, discuss, plan, build, review, or design.", "warning");
			await setMode(pi, ctx, mode);
		},
	});

	pi.registerCommand("plan", {
		description: "Manage the branch-local saved plan",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) return choosePlanAction(pi, ctx);
			const action = normalizePlanAction(arg);
			if (!action) return ctx.ui.notify("Unknown plan action. Use view, save, or clear.", "warning");
			if (action === "view") await showPlan(ctx);
			if (action === "save") await savePlan(pi, ctx);
			if (action === "clear") await clearPlan(pi, ctx);
		},
	});
}
