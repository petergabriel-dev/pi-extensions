import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCodebaseMap, scheduleRegeneration } from "./codebase-map/regeneration.js";
import type { callCarefulModelOneShot } from "./consolidation/careful-model.js";
import { runExtraction, type ExtractionRunResult } from "./consolidation/extract.js";
import { runReconciliation, type ReconciliationRunResult } from "./consolidation/reconcile.js";
import { listStagingFiles, readStaging, listDeadLetterFiles, readDeadLetter, repairStagingFile, writeStaging } from "./consolidation/staging.js";
import { registerMarkerHooks } from "./reinforcement/markers.js";
import { logFiring, logToolCall, type ToolCallObservation } from "./retrieval/firing-log.js";
import { formatTier1Block, formatTier2Block } from "./retrieval/inject.js";
import { selectTier1 } from "./retrieval/tier1.js";
import { matchTier2, type Match } from "./retrieval/tier2.js";
import { initializeProjectMemory, type MemoryIgnoreResult, type MemoryInitResult } from "./storage/init.js";
import { ensureMemoryDirs, type MemoryPaths, projectScopeFromMemoryPaths, resolveMemoryIndexPath, resolveMemoryPaths } from "./storage/paths.js";
import { getIndexCounts, openIndex, rebuildIndex, type RebuildCounts, type SqliteDatabase } from "./storage/sqlite.js";
import { readRecentReconcileRuns, recordReconcileRun, type ReconcileRunSource } from "./storage/run-log.js";
import { classifyReason, shouldSwap, type ClassifiedReason } from "./lifecycle.js";
import { readMemoryModelOverride, resolveAdjudicationModel, resolveExtractionModel, writeMemoryModelOverride, type MemoryModelRole } from "./model-resolution.js";
import { sweepLessons, flagLowSignalLessons, detectContradictions } from "./consolidation/sweep.js";
import { parseLessonsFile, rewriteLessonsFile } from "./storage/markdown.js";
import type { StagingFile } from "./types.js";

const DEFAULT_EXTRACTION_TIMEOUT_MS = 180_000;
const EXTRACTION_TIMEOUT_ENV = "PERSISTENT_MEMORY_EXTRACTION_TIMEOUT_MS";
const DEFAULT_EXTRACTION_THINKING_LEVEL: ThinkingLevel = "off";
const EXTRACTION_THINKING_LEVEL_ENV = "PERSISTENT_MEMORY_EXTRACTION_THINKING_LEVEL";
const ALLOWED_EXTRACTION_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 180_000;
const RECONCILIATION_TIMEOUT_ENV = "PERSISTENT_MEMORY_RECONCILIATION_TIMEOUT_MS";
const DEFAULT_RECONCILIATION_THINKING_LEVEL: ThinkingLevel = "off";
const RECONCILIATION_THINKING_LEVEL_ENV = "PERSISTENT_MEMORY_RECONCILIATION_THINKING_LEVEL";
const ALLOWED_RECONCILIATION_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_RECONCILIATION_CHUNK_SIZE = 20;
const RECONCILIATION_CHUNK_SIZE_ENV = "PERSISTENT_MEMORY_RECONCILIATION_CHUNK_SIZE";
const DEFAULT_RECONCILIATION_BUDGET_MS = 240_000;
const RECONCILIATION_BUDGET_ENV = "PERSISTENT_MEMORY_RECONCILIATION_BUDGET_MS";
const MAX_ERROR_DETAIL_CHARS = 500;
const MEMORY_UI_KEY = "persistent-memory";
const MEMORY_PANEL_CLEAR_MS = 5_000;

const RECONCILIATION_MODEL_ENV = "PERSISTENT_MEMORY_RECONCILIATION_MODEL";
const EXTRACTION_MODEL_ENV = "PERSISTENT_MEMORY_EXTRACTION_MODEL";
export const ADJUDICATION_MODEL_ENV = "PERSISTENT_MEMORY_ADJUDICATION_MODEL";

function resolveReconciliationAdjudicationModel(
	ctx: { modelRegistry?: any; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void },
): any {
	const adjudicationOverride = process.env[ADJUDICATION_MODEL_ENV]?.trim();
	const legacyReconciliationOverride = process.env[RECONCILIATION_MODEL_ENV]?.trim();
	const envName = adjudicationOverride ? ADJUDICATION_MODEL_ENV : legacyReconciliationOverride ? RECONCILIATION_MODEL_ENV : ADJUDICATION_MODEL_ENV;
	return resolveAdjudicationModel(envName, ctx, logger);
}

interface ExtractionConfig {
	timeoutMs: number;
	thinkingLevel: ThinkingLevel;
}

interface ReconciliationConfig {
	chunkSize: number;
	budgetMs: number;
	thinkingLevel: ThinkingLevel;
}

interface RebuiltIndex {
	db: SqliteDatabase;
	counts: RebuildCounts;
}

let memoryPaths: MemoryPaths | null = null;
let db: SqliteDatabase | null = null;
let lastRebuildError: string | null = null;
let pendingReminderLessons = new Map<string, Match["lesson"]>();

let lifecycleGeneration = 0;
let reconcileInFlight = false;
let canonicalWriterInFlight = false;
type CarefulModelImpl = typeof callCarefulModelOneShot;
const defaultCallCarefulModelImpl: CarefulModelImpl = async (...args) => {
	const module = await import("./consolidation/careful-model.js");
	return module.callCarefulModelOneShot(...args);
};
let callCarefulModelImpl: CarefulModelImpl = defaultCallCarefulModelImpl;
let memoryPanelClearTimer: NodeJS.Timeout | null = null;

export function setCallCarefulModelImplForTest(impl: CarefulModelImpl): void {
	callCarefulModelImpl = impl;
}

export function __resetCallCarefulModelImplForTest(): void {
	callCarefulModelImpl = defaultCallCarefulModelImpl;
}

export function __setPersistentMemoryStateForTest(state: {
	memoryPaths?: MemoryPaths | null;
	db?: SqliteDatabase | null;
	lifecycleGeneration?: number;
	reconcileInFlight?: boolean;
}): void {
	if ("memoryPaths" in state) memoryPaths = state.memoryPaths ?? null;
	if ("db" in state) db = state.db ?? null;
	if (state.lifecycleGeneration !== undefined) lifecycleGeneration = state.lifecycleGeneration;
	if (state.reconcileInFlight !== undefined) reconcileInFlight = state.reconcileInFlight;
}

export function __bumpPersistentMemoryGenerationForTest(): void {
	lifecycleGeneration++;
}

export default function persistentMemory(pi: ExtensionAPI) {
	void import("./retrieval/tier3.js")
		.then(({ registerRecallTool }) => {
			registerRecallTool(pi, () => db, currentProjectScope);
		})
		.catch((error) => {
			console.warn(`[persistent-memory] recall tool unavailable: ${formatError(error)}`);
		});
	registerMarkerHooks(pi);

	pi.on("session_start", async (event, ctx) => {
		try {
			clearPendingReminderLessons();
			memoryPaths = resolveMemoryPaths(ctx.cwd ?? process.cwd());
			ensureMemoryDirs(memoryPaths);

			if (db) db.close();
			db = openIndex(indexPathForMemoryPaths(memoryPaths));

			const classified = classifyReason(event?.reason, "startup");
			lifecycleGeneration++;

			if (classified.isReload) {
				lastRebuildError = null;
				scheduleRegeneration(memoryPaths);
				return;
			}

			lastRebuildError = null;
			scheduleRegeneration(memoryPaths);
			if (ctx.hasUI) {
				updateMemoryMeter(ctx.ui);
			}

		} catch (error) {
			lastRebuildError = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`persistent-memory failed to initialize: ${lastRebuildError}`, "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!memoryPaths) return;

			const blocks: string[] = [];
			const codebaseMap = loadCodebaseMap(memoryPaths);
			if (codebaseMap) blocks.push(codebaseMap);

			if (db) {
				const tier1 = selectTier1(db, currentProjectScope());
				for (const lesson of tier1.lessons) {
					logFiring({
						lesson_id: lesson.id,
						trigger: { type: "topic", value: "<tier-1-always-load>" },
						fired_at: new Date().toISOString(),
						context_summary: "before_agent_start",
						tier: 1,
					});
				}
				if (tier1.lessons.length > 0) blocks.push(formatTier1Block(tier1.lessons));
			}

			if (blocks.length === 0) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
		} catch (error) {
			notifyHookError(ctx, "before_agent_start", error);
		}
	});

	pi.on("context", async (event, ctx) => {
		try {
			if (!db || !memoryPaths) return;
			const messages = [...event.messages] as MessageLike[];
			const lastUserIdx = findLastUserIndex(messages);
			if (lastUserIdx < 0) return;

			const pendingLessons = getPendingReminderLessons();
			const userText = extractText(messages[lastUserIdx]?.content);
			const matches = userText ? matchTier2(db, currentProjectScope(), { user_message_text: userText }) : [];
			if (matches.length > 0) logMatches(matches, userText.slice(0, 100));

			const lessons = uniqueLessons([...pendingLessons, ...matches.map((match) => match.lesson)]);
			if (lessons.length === 0) return;

			const block = formatTier2Block(lessons);
			messages.splice(lastUserIdx, 0, {
				role: "custom",
				customType: "persistent-memory",
				content: block,
				display: false,
				timestamp: Date.now(),
			});
			if (pendingLessons.length > 0) clearPendingReminderLessons();
			return { messages };
		} catch (error) {
			notifyHookError(ctx, "context", error);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!db || !memoryPaths) return;
			const bashCommand = event.toolName === "bash" ? String((event.input as { command?: unknown })?.command ?? "") : undefined;
			const matches = matchTier2(db, currentProjectScope(), {
				tool_name: event.toolName,
				tool_input: event.input,
				bash_command: bashCommand,
			});
			const advisoryMatches = matches.filter(
				(match) => match.matched_trigger.type === "tool" || match.matched_trigger.type === "command",
			);
			const toolCall = logToolCall({
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				tool_input: event.input,
				bash_command: bashCommand,
				blocked: false,
			});
			if (matches.length === 0) return;

			logMatches(matches, `${event.toolName}: ${safeJson(event.input).slice(0, 100)}`, { toolCall });
			queuePendingReminderLessons(advisoryMatches);
		} catch (error) {
			notifyHookError(ctx, "tool_call", error);
		}
	});

	pi.on("session_shutdown", async (event, _ctx) => {
		lifecycleGeneration++;
		void classifyReason(event?.reason, "quit");
		clearPendingReminderLessons();
		db?.close();
		db = null;
		memoryPaths = null;
	});

	pi.registerCommand("memory", {
		description: "Inspect persistent memory",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "list") {
				await listMemory(ctx);
				return;
			}
			if (trimmed === "init") {
				await initMemoryCommand(ctx);
				return;
			}
			if (trimmed === "staging") {
				await listStaging(ctx);
				return;
			}
			if (trimmed === "status") {
				await memoryStatusCommand(ctx);
				return;
			}
			if (trimmed === "reconcile") {
				await reconcileMemoryCommand(ctx);
				return;
			}
			if (trimmed === "consolidate") {
				await consolidateMemoryCommand(ctx);
				return;
			}
			if (trimmed === "firings") {
				await listFirings(ctx);
				return;
			}
			if (trimmed === "deadletter") {
				await listDeadLetter(ctx);
				return;
			}
			if (trimmed === "recover") {
				await recoverMemoryCommand(ctx);
				return;
			}
			if (trimmed === "sweep") {
				await sweepMemoryCommand(ctx);
				return;
			}
			if (trimmed === "lowsignal") {
				await lowSignalCommand(ctx);
				return;
			}
			if (trimmed === "contradictions") {
				await contradictionsCommand(ctx);
				return;
			}
			if (trimmed === "model" || trimmed.startsWith("model ")) {
				await memoryModelCommand(trimmed.slice("model".length), ctx);
				return;
			}
			ctx.ui.notify("Usage: /memory, /memory list, /memory init, /memory staging, /memory status, /memory reconcile, /memory consolidate, /memory recover, /memory firings, /memory deadletter, /memory sweep, /memory lowsignal, /memory contradictions, /memory model [extraction|adjudication] [provider/model]", "warning");
		},
	});
}

type MessageLike = {
	role?: string;
	content?: unknown;
	customType?: string;
	display?: boolean;
	timestamp?: number;
};

function formatError(error: unknown): string {
	const raw = error instanceof Error
		? `${error.name || "Error"}: ${error.message}`
		: error === undefined
			? "No underlying error detail available."
			: String(error);
	const compact = raw.replace(/\s+/g, " ").trim();
	return compact.length > MAX_ERROR_DETAIL_CHARS ? `${compact.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : compact;
}

function extractionConfig(): ExtractionConfig {
	return {
		timeoutMs: parsePositiveIntegerEnv(process.env[EXTRACTION_TIMEOUT_ENV], DEFAULT_EXTRACTION_TIMEOUT_MS),
		thinkingLevel: parseExtractionThinkingLevel(process.env[EXTRACTION_THINKING_LEVEL_ENV]),
	};
}

function parseExtractionThinkingLevel(raw: string | undefined): ThinkingLevel {
	if (!raw) return DEFAULT_EXTRACTION_THINKING_LEVEL;
	const normalized = raw.trim().toLowerCase();
	return isAllowedExtractionThinkingLevel(normalized) ? normalized : DEFAULT_EXTRACTION_THINKING_LEVEL;
}

function isAllowedExtractionThinkingLevel(value: string): value is ThinkingLevel {
	return ALLOWED_EXTRACTION_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseReconciliationThinkingLevel(raw: string | undefined): ThinkingLevel {
	if (!raw) return DEFAULT_RECONCILIATION_THINKING_LEVEL;
	const normalized = raw.trim().toLowerCase();
	return isAllowedReconciliationThinkingLevel(normalized) ? normalized : DEFAULT_RECONCILIATION_THINKING_LEVEL;
}

function isAllowedReconciliationThinkingLevel(value: string): value is ThinkingLevel {
	return ALLOWED_RECONCILIATION_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return fallback;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function reconciliationTimeoutMs(): number {
	const raw = process.env[RECONCILIATION_TIMEOUT_ENV];
	if (!raw) return DEFAULT_RECONCILIATION_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RECONCILIATION_TIMEOUT_MS;
}

function reconciliationConfig(): ReconciliationConfig {
	return {
		chunkSize: parsePositiveIntegerEnv(process.env[RECONCILIATION_CHUNK_SIZE_ENV], DEFAULT_RECONCILIATION_CHUNK_SIZE),
		budgetMs: parsePositiveIntegerEnv(process.env[RECONCILIATION_BUDGET_ENV], DEFAULT_RECONCILIATION_BUDGET_MS),
		thinkingLevel: parseReconciliationThinkingLevel(process.env[RECONCILIATION_THINKING_LEVEL_ENV]),
	};
}

function currentProjectScope(): string | null {
	return memoryPaths ? projectScopeFromMemoryPaths(memoryPaths) : null;
}

function findLastUserIndex(messages: MessageLike[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return "";
			return String((part as { text?: unknown }).text ?? "");
		})
		.filter(Boolean)
		.join("\n");
}

function queuePendingReminderLessons(matches: Match[]): void {
	for (const match of matches) pendingReminderLessons.set(match.lesson.id, match.lesson);
}

function getPendingReminderLessons(): Match["lesson"][] {
	return Array.from(pendingReminderLessons.values());
}

function clearPendingReminderLessons(): void {
	pendingReminderLessons.clear();
}

function uniqueLessons(lessons: Match["lesson"][]): Match["lesson"][] {
	const out: Match["lesson"][] = [];
	const seen = new Set<string>();
	for (const lesson of lessons) {
		if (seen.has(lesson.id)) continue;
		seen.add(lesson.id);
		out.push(lesson);
	}
	return out;
}

function logMatches(
	matches: Match[],
	contextSummary: string,
	details: { toolCall?: ToolCallObservation } = {},
): void {
	for (const match of matches) {
		logFiring({
			lesson_id: match.lesson.id,
			trigger: match.matched_trigger,
			fired_at: new Date().toISOString(),
			context_summary: contextSummary,
			tier: 2,
			blocked: false,
			...(details.toolCall
				? {
					tool_call_index: details.toolCall.index,
					tool_call_id: details.toolCall.tool_call_id,
					tool_name: details.toolCall.tool_name,
					tool_input_excerpt: details.toolCall.tool_input_excerpt,
					...(details.toolCall.bash_command_excerpt ? { bash_command_excerpt: details.toolCall.bash_command_excerpt } : {}),
				}
				: {}),
		});
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function notifyHookError(ctx: { ui?: { notify?: (message: string, level: "error") => void } }, hook: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[persistent-memory] ${hook} failed: ${message}`);
	ctx.ui?.notify?.(`persistent-memory ${hook} failed: ${message}`, "error");
}

function queryAll<T>(sql: string): T[] {
	if (!db) return [];
	return db.prepare(sql).all() as T[];
}

async function initMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	const commandContext = ctx as ExtensionCommandContext & { cwd?: string };
	const cwd = commandContext.cwd ?? process.cwd();
	let result: MemoryInitResult;
	try {
		result = initializeProjectMemory(cwd);
	} catch (error) {
		ctx.ui.notify(`Memory init failed: ${formatError(error)}`, "error");
		return;
	}

	let rebuilt: RebuiltIndex | null = null;
	let recoveryMessage: string | null = null;
	try {
		rebuilt = openRebuiltIndex(result.target.paths);
	} catch (error) {
		if (!isReadonlySqliteError(error)) {
			ctx.ui.notify(
				`Memory init created layout but index rebuild failed: ${formatError(error)}\nExisting memory session left unchanged.`,
				"warning",
			);
			return;
		}

		const reset = await ctx.ui.confirm(
			"Reset memory index?",
			`SQLite index rebuild failed: ${formatError(error)}\n\nindex.db is derived cache. Delete and rebuild it?\nMarkdown memory files will not be changed.`,
		);
		if (!reset) {
			ctx.ui.notify(
				`Memory init created layout but index rebuild failed: ${formatError(error)}\nindex.db left unchanged; memory search may be stale.`,
				"warning",
			);
			return;
		}

		const dbPath = indexPathForMemoryPaths(result.target.paths);
		try {
			fs.rmSync(dbPath, { force: true });
			rebuilt = openRebuiltIndex(result.target.paths);
			recoveryMessage = `Index reset: deleted and rebuilt ${formatDisplayPath(dbPath, cwd)}.`;
		} catch (resetError) {
			ctx.ui.notify(
				`Memory init deleted index.db but rebuild failed: ${formatError(resetError)}\nMarkdown memory files were not changed. Existing memory session left unchanged.`,
				"warning",
			);
			return;
		}
	}

	swapActiveMemory(result.target.paths, rebuilt.db);
	ctx.ui.notify(formatInitResult(result, cwd, rebuilt.counts, recoveryMessage), "info");
}

function openRebuiltIndex(paths: MemoryPaths): RebuiltIndex {
	const nextDb = openIndex(indexPathForMemoryPaths(paths));
	try {
		return { db: nextDb, counts: rebuildIndex(nextDb, paths) };
	} catch (error) {
		closeDatabaseQuietly(nextDb, "failed init target");
		throw error;
	}
}

function swapActiveMemory(nextPaths: MemoryPaths, nextDb: SqliteDatabase): void {
	const previousDb = db;
	memoryPaths = nextPaths;
	db = nextDb;
	lastRebuildError = null;
	scheduleRegeneration(nextPaths);
	if (previousDb && previousDb !== nextDb) closeDatabaseQuietly(previousDb, "previous active");
}

function closeDatabaseQuietly(targetDb: SqliteDatabase, label: string): void {
	try {
		targetDb.close();
	} catch (error) {
		console.warn(`[persistent-memory] failed to close ${label} database: ${formatError(error)}`);
	}
}

function recordReconcileRunIfUseful(
	paths: MemoryPaths,
	source: ReconcileRunSource,
	startedAt: Date,
	result: ReconciliationRunResult,
	model: unknown,
): void {
	if (!shouldRecordReconcileResult(result)) return;
	try {
		const finishedAt = new Date();
		recordReconcileRun(paths, {
			source,
			status: result.status,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
			model: formatModelForRunLog(model),
			...("reason" in result ? { reason: result.reason } : {}),
			counts: result.counts,
			...(result.candidateOutcomes ? { candidateOutcomes: result.candidateOutcomes } : {}),
			...(result.candidateMetrics ? { candidateMetrics: result.candidateMetrics } : {}),
			llmCalled: result.llmCalled,
			indexRebuilt: result.indexRebuilt,
			...(result.status === "failed" ? { message: formatError(result.error) } : {}),
		});
	} catch (error) {
		console.warn(`[persistent-memory] failed to record ${source} reconciliation run: ${formatError(error)}`);
	}
}

function recordThrownReconcileRun(
	paths: MemoryPaths,
	source: ReconcileRunSource,
	startedAt: Date,
	model: unknown,
	error: unknown,
): void {
	try {
		const finishedAt = new Date();
		recordReconcileRun(paths, {
			source,
			status: "failed",
			reason: "unexpected_error",
			message: formatError(error),
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
			model: formatModelForRunLog(model),
		});
	} catch (logError) {
		console.warn(`[persistent-memory] failed to record thrown ${source} reconciliation run: ${formatError(logError)}`);
	}
}

function shouldRecordReconcileResult(result: ReconciliationRunResult): boolean {
	if (result.status === "failed") return true;
	if (result.indexRebuilt) return true;
	const counts = result.counts;
	// T9: preserved is always 0; deadLettered files are also terminal activity.
	return counts.stagingFiles.total > 0
		|| counts.stagingFiles.consumed > 0
		|| counts.stagingFiles.deadLettered > 0
		|| totalCategoryTotals(counts.candidates.deadLettered) > 0;
}

function totalCategoryTotals(totals: { lessons: number; preferences: number; decisions: number; domain: number }): number {
	return totals.lessons + totals.preferences + totals.decisions + totals.domain;
}

function formatModelForRunLog(model: unknown): string | null {
	if (!model) return null;
	if (typeof model === "string") return model;
	if (typeof model !== "object") return String(model);
	const record = model as { provider?: unknown; id?: unknown; name?: unknown };
	const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
	if (!id) return null;
	return typeof record.provider === "string" ? `${record.provider}/${id}` : id;
}

export function updateMemoryMeter(
	ui: ExtensionAPI["ui"],
	options: { showPanel?: boolean; clearPanel?: boolean; clearAfterMs?: number; panelTitle?: string } = {},
): void {
	if (!ui || typeof ui.setStatus !== "function") return;
	try {
		ui.setStatus?.(MEMORY_UI_KEY, formatMemoryStatusLine());
		if (options.clearPanel) {
			clearMemoryPanelTimer();
			ui.setWidget?.(MEMORY_UI_KEY, undefined);
			return;
		}
		if (options.showPanel) {
			clearMemoryPanelTimer();
			ui.setWidget?.(MEMORY_UI_KEY, formatMemoryPanelLines(options.panelTitle ?? "Memory status"), { placement: "belowEditor" });
			if (options.clearAfterMs) {
				memoryPanelClearTimer = setTimeout(() => {
					memoryPanelClearTimer = null;
					try {
						ui.setWidget?.(MEMORY_UI_KEY, undefined);
					} catch {
						// ignore widget clear failures
					}
				}, options.clearAfterMs);
			}
		}
	} catch (error) {
		console.warn(`[persistent-memory] memory meter update failed: ${formatError(error)}`);
	}
}

function clearMemoryPanelTimer(): void {
	if (!memoryPanelClearTimer) return;
	clearTimeout(memoryPanelClearTimer);
	memoryPanelClearTimer = null;
}

function formatMemoryStatusLine(): string {
	if (!memoryPaths?.projectMemoryDir) return lastRebuildError ? `Mem: error ${lastRebuildError}` : "Mem: not initialized";
	const stagingCount = safeStagingCount(memoryPaths);
	const lastRun = readRecentReconcileRuns(memoryPaths, 1).at(-1);
	const active = reconcileInFlight ? " · reconciling" : "";
	const last = lastRun ? ` · last ${lastRun.status}${lastRun.reason ? `/${lastRun.reason}` : ""} ${formatAge(lastRun.finishedAt)}` : " · no runs";
	return `Mem: ${stagingCount} staged${active}${last}`;
}

function formatMemoryPanelLines(title: string): string[] {
	if (!memoryPaths?.projectMemoryDir) return [title, "No project memory dir."];
	const recent = readRecentReconcileRuns(memoryPaths, 3);
	const lines = [
		title,
		`Staging files: ${safeStagingCount(memoryPaths)}`,
		`Reconciliation: ${reconcileInFlight ? "in flight" : "idle"}`,
		`Last index error: ${lastRebuildError ?? "none"}`,
	];
	if (recent.length === 0) {
		lines.push("Recent runs: none");
	} else {
		lines.push("Recent runs:");
		for (const run of recent) {
			lines.push(`- ${run.source} ${run.status}${run.reason ? `/${run.reason}` : ""} ${formatAge(run.finishedAt)}`);
		}
	}
	return lines;
}

function safeStagingCount(paths: MemoryPaths): number {
	try {
		return paths.projectMemoryDir ? listStagingFiles(paths.projectMemoryDir).length : 0;
	} catch {
		return 0;
	}
}

function formatAge(iso: string): string {
	const timestamp = Date.parse(iso);
	if (!Number.isFinite(timestamp)) return "unknown age";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function isReadonlySqliteError(error: unknown): boolean {
	const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; name?: unknown } : null;
	const text = [record?.code, record?.name, record?.message, String(error)]
		.filter((part): part is string => typeof part === "string")
		.join(" ")
		.toLowerCase();
	return text.includes("sqlite_readonly") || text.includes("readonly database");
}

function indexPathForMemoryPaths(paths: MemoryPaths): string {
	return resolveMemoryIndexPath(paths);
}

function formatInitResult(result: MemoryInitResult, cwd: string, counts: RebuildCounts, recoveryMessage: string | null = null): string {
	return [
		"Memory init complete.",
		`Root: ${formatDisplayPath(result.target.root, cwd)}`,
		`Memory: ${formatDisplayPath(result.target.projectMemoryDir, cwd)}`,
		`Dirs created: ${formatPathList(result.layout.createdDirs, cwd)}`,
		`Markdown: ${result.layout.createdFiles.length} created, ${result.layout.preservedFiles.length} preserved.`,
		`Git ignore: ${formatIgnoreResult(result.ignore, cwd)}`,
		...(recoveryMessage ? [recoveryMessage] : []),
		`Index rebuilt: ${formatRebuildCounts(counts)}.`,
	].join("\n");
}

function formatPathList(paths: string[], cwd: string): string {
	return paths.length > 0 ? paths.map((filePath) => formatDisplayPath(filePath, cwd)).join(", ") : "none";
}

function formatRebuildCounts(counts: RebuildCounts): string {
	return `${counts.lessons} lessons/${counts.preferences} prefs/${counts.decisions} decisions/${counts.domainFacts} domain`;
}

function formatIgnoreResult(ignore: MemoryIgnoreResult, cwd: string): string {
	if (ignore.status === "not_git") return "not a Git repo; skipped.";
	if (ignore.status === "already_ignored") return ".pi/ already ignored by Git.";
	const excludePath = ignore.excludePath ? formatDisplayPath(ignore.excludePath, cwd) : "Git local exclude";
	if (ignore.status === "added") return `added .pi/ to ${excludePath}.`;
	return `.pi/ already present in ${excludePath}.`;
}

function formatDisplayPath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return filePath;
}

export async function consolidateMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!db || !memoryPaths) {
		ctx.ui.notify(lastRebuildError ? `Memory not initialized: ${lastRebuildError}` : "Memory not initialized.", "error");
		return;
	}
	if (!memoryPaths.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}
	if (reconcileInFlight) {
		ctx.ui.notify("Memory reconciliation already running; try again after it finishes.", "warning");
		return;
	}
	if (typeof ctx.sessionManager?.getBranch !== "function") {
		ctx.ui.notify("Memory consolidate requires sessionManager.getBranch(); current session branch unavailable.", "error");
		return;
	}
	const releaseLock = acquireCanonicalWriterLock(memoryPaths);
	if (!releaseLock) {
		ctx.ui.notify("Memory canonical writer already running; try again after it finishes.", "warning");
		return;
	}

	const runPaths = { ...memoryPaths };
	const modelContext = ctx as ExtensionCommandContext & { cwd?: string; model?: unknown; thinkingLevel?: unknown };
	const extraction = extractionConfig();
	const extractionModel = resolveExtractionModel(EXTRACTION_MODEL_ENV, modelContext, console);
	const sessionId = getSessionId(ctx as { sessionManager?: { getSessionId?: () => string } });
	let extractionResult: ExtractionRunResult | null = null;
	try {
		extractionResult = await runExtraction(ctx as any, runPaths, sessionId, {
			logger: console,
			callCarefulModel: (systemPrompt, userPrompt) => callCarefulModelImpl(systemPrompt, userPrompt, {
				cwd: modelContext.cwd ?? process.cwd(),
				...(extractionModel ? { model: extractionModel as never } : {}),
				thinkingLevel: extraction.thinkingLevel,
				timeoutMs: extraction.timeoutMs,
				logger: console,
			}),
		});
		if (extractionResult.status === "failed") {
			ctx.ui.notify(`Memory consolidation extraction failed (${extractionResult.reason}): ${formatError(extractionResult.error)}; staging preserved.`, "error");
			return;
		}

		const hasStaging = listStagingFiles(runPaths.projectMemoryDir).length > 0;
		if (!hasStaging) {
			ctx.ui.notify(formatConsolidationNothing(extractionResult), "info");
			return;
		}

		const reconcileResult = await runReconciliationForeground(ctx, runPaths, "manual");
		if (reconcileResult.status === "failed") {
			ctx.ui.notify(`Memory consolidation reconcile failed (${reconcileResult.reason}): ${formatError(reconcileResult.error)}; staging preserved.`, "error");
			return;
		}
		ctx.ui.notify(formatConsolidationResult(extractionResult, reconcileResult), "info");
	} catch (error) {
		ctx.ui.notify(`Memory consolidation failed: ${formatError(error)}; staging preserved.`, "error");
	} finally {
		releaseLock();
	}
}

export async function reconcileMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!db || !memoryPaths) {
		ctx.ui.notify(lastRebuildError ? `Memory not initialized: ${lastRebuildError}` : "Memory not initialized.", "error");
		return;
	}
	if (!memoryPaths.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}
	if (reconcileInFlight) {
		ctx.ui.notify("Memory reconciliation already running; staging will be processed by the in-flight run.", "warning");
		return;
	}
	const releaseLock = acquireCanonicalWriterLock(memoryPaths);
	if (!releaseLock) {
		ctx.ui.notify("Memory canonical writer already running; try again after it finishes.", "warning");
		return;
	}

	try {
		const result = await runReconciliationForeground(ctx, { ...memoryPaths }, "manual");
		if (result.status === "failed") {
			ctx.ui.notify(`Memory reconciliation failed (${result.reason}): ${formatError(result.error)}; staging preserved.`, "error");
			return;
		}
		ctx.ui.notify(formatReconciliationResult(result), "info");
	} catch (error) {
		ctx.ui.notify(`Memory reconciliation failed: ${formatError(error)}; staging preserved.`, "error");
	} finally {
		releaseLock();
	}
}

async function runReconciliationForeground(
	ctx: ExtensionCommandContext,
	runPaths: MemoryPaths,
	source: ReconcileRunSource,
): Promise<ReconciliationRunResult> {
	const startGen = lifecycleGeneration;
	const startedAt = new Date();
	const modelContext = ctx as ExtensionCommandContext & { cwd?: string; model?: unknown; thinkingLevel?: unknown };
	const reconciliation = reconciliationConfig();
	const chosenModel = resolveReconciliationAdjudicationModel(modelContext, console);
	reconcileInFlight = true;
	let ownDb: SqliteDatabase | null = null;
	try {
		ownDb = openIndex(indexPathForMemoryPaths(runPaths));
		const result = await runReconciliation(runPaths, ownDb, {
			rebuildOnNoop: true,
			logger: console,
			chunkSize: reconciliation.chunkSize,
			wallClockBudgetMs: reconciliation.budgetMs,
			shouldContinue: () => shouldSwap(startGen, lifecycleGeneration),
			onChunkStart: (chunkIndex, totalChunks) => {
				if ((ctx as ExtensionCommandContext & { hasUI?: boolean }).hasUI) {
					updateMemoryMeter(ctx.ui, { showPanel: true, panelTitle: `Memory reconciliation running (chunk ${chunkIndex}/${totalChunks})` });
				}
			},
			callCarefulModel: (systemPrompt, userPrompt) => callCarefulModelImpl(systemPrompt, userPrompt, {
				cwd: modelContext.cwd ?? process.cwd(),
				...(chosenModel ? { model: chosenModel as never } : {}),
				thinkingLevel: reconciliation.thinkingLevel,
				timeoutMs: reconciliationTimeoutMs(),
				logger: console,
			}),
		});
		recordReconcileRunIfUseful(runPaths, source, startedAt, result, chosenModel);

		// Keep this check and swap/discard block await-free. An await here would let a lifecycle
		// event interleave and could publish a stale reconciliation index into a newer generation.
		if (shouldSwap(startGen, lifecycleGeneration)) {
			swapActiveMemory(runPaths, ownDb);
			ownDb = null;
		} else {
			console.warn(`[persistent-memory] manual reconciliation finished but generation changed (${startGen} -> ${lifecycleGeneration}); discarding manual index.`);
			closeDatabaseQuietly(ownDb, "stale manual db");
			ownDb = null;
		}
		if (result.status === "failed" && result.reason === "index_error") lastRebuildError = formatError(result.error);
		else if (result.status !== "failed") lastRebuildError = null;
		return result;
	} catch (error) {
		recordThrownReconcileRun(runPaths, source, startedAt, chosenModel, error);
		throw error;
	} finally {
		reconcileInFlight = false;
		if ((ctx as ExtensionCommandContext & { hasUI?: boolean }).hasUI) {
			updateMemoryMeter(ctx.ui, { clearPanel: true });
		}
		if (ownDb) closeDatabaseQuietly(ownDb, "manual reconcile db");
	}
}

function acquireCanonicalWriterLock(paths: MemoryPaths): (() => void) | null {
	if (!paths.projectMemoryDir || canonicalWriterInFlight) return null;
	const lockPath = path.join(paths.projectMemoryDir, "canonical-writer.lock");
	let fd: number;
	try {
		fd = fs.openSync(lockPath, "wx");
		fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
	} catch {
		return null;
	}
	canonicalWriterInFlight = true;
	return () => {
		canonicalWriterInFlight = false;
		try { fs.closeSync(fd); } catch {}
		try { fs.rmSync(lockPath, { force: true }); } catch {}
	};
}

function getSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
	try {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) return sessionId;
	} catch {
		// Fall back below.
	}
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function formatConsolidationNothing(extraction: ExtractionRunResult): string {
	if (extraction.status === "written") return `Memory consolidation extracted ${extraction.totalCandidates} candidate(s), but nothing remained to reconcile.`;
	return "Memory consolidation skipped: nothing to consolidate.";
}

function formatConsolidationResult(
	extraction: ExtractionRunResult,
	reconcile: Exclude<ReconciliationRunResult, { status: "failed" }>,
): string {
	const extracted = extraction.status === "written" ? extraction.totalCandidates : 0;
	const counts = reconcile.counts;
	return [
		`Memory consolidation ${reconcile.status}.`,
		`Extracted: ${extracted} candidate(s).`,
		`Added: ${formatTotals(counts.actions.add)}. Re-staged files: ${counts.stagingFiles.preserved}. Dead-lettered: ${formatTotals(counts.candidates.deadLettered)}.`,
		`Staging: ${counts.stagingFiles.consumed}/${counts.stagingFiles.total} consumed, ${counts.stagingFiles.deadLettered} dead-lettered files.`,
		`Writes: ${formatWriteFlags(counts.writes)}. Index rebuilt: ${reconcile.indexRebuilt ? "yes" : "no"}.`,
	].join("\n");
}

function formatReconciliationResult(result: Exclude<Awaited<ReturnType<typeof runReconciliation>>, { status: "failed" }>): string {
	const counts = result.counts;
	const lines = [
		`Memory reconciliation ${result.status}.`,
		`Staging: ${counts.stagingFiles.consumed}/${counts.stagingFiles.total} consumed, ${counts.stagingFiles.deadLettered} dead-lettered.`,
		`Candidates: ${formatTotals(counts.candidates.staged)} staged, ${formatTotals(counts.candidates.exactDuplicates)} exact duplicates, ${formatTotals(counts.candidates.remainingForModel)} model candidates, ${formatTotals(counts.candidates.deadLettered)} dead-lettered.`,
		`Actions: ${formatTotals(counts.actions.add)} added, ${formatTotals(counts.actions.merge)} merged, ${counts.actions.supersede} superseded, ${formatTotals(counts.actions.discard)} discarded.`,
		...(result.candidateMetrics ? [`Per-candidate outcomes: ${result.candidateMetrics.total} total, discard/dup rate ${formatPercent(result.candidateMetrics.discardDupRate)}.`] : []),
		`Writes: ${formatWriteFlags(counts.writes)}. Index rebuilt: ${result.indexRebuilt ? "yes" : "no"}.`,
	];
	return lines.join("\n");
}

function formatTotals(totals: { lessons: number; preferences: number; decisions: number; domain: number }): string {
	return `${totals.lessons} lessons/${totals.preferences} prefs/${totals.decisions} decisions/${totals.domain} domain`;
}

function formatPercent(value: number): string {
	return `${Math.round(value * 1000) / 10}%`;
}

function summarizeCandidateOutcomes(outcomes: Array<{ outcome: string }>): string {
	const counts = new Map<string, number>();
	for (const row of outcomes) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
	return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([outcome, count]) => `${outcome}=${count}`).join(", ");
}

function formatWriteFlags(writes: { lessons: boolean; preferences: boolean; domain: boolean; decisions: boolean }): string {
	const changed = Object.entries(writes)
		.filter(([, didWrite]) => didWrite)
		.map(([name]) => name);
	return changed.length > 0 ? changed.join(", ") : "none";
}

function modelReference(model: any): string {
	return `${model.provider}/${model.id}`;
}

function resolveAvailableModelReference(reference: string | undefined, available: any[]): any | undefined {
	if (!reference) return undefined;
	const lowerRef = reference.toLowerCase();
	const exact = available.find((model) => modelReference(model).toLowerCase() === lowerRef || String(model.id).toLowerCase() === lowerRef);
	if (exact) return exact;
	if (reference.includes("/")) {
		const slashIdx = reference.indexOf("/");
		const provider = reference.slice(0, slashIdx).toLowerCase();
		const id = reference.slice(slashIdx + 1).toLowerCase();
		return available.find((model) => String(model.provider).toLowerCase() === provider && String(model.id).toLowerCase() === id);
	}
	return available.find((model) => String(model.id).toLowerCase().includes(lowerRef) || String(model.name).toLowerCase().includes(lowerRef));
}

async function memoryModelCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const roleArg = parts[0];
	const roles: MemoryModelRole[] = ["extraction", "adjudication"];
	const role = roles.includes(roleArg as MemoryModelRole)
		? roleArg as MemoryModelRole
		: roleArg
			? undefined
			: roleFromLabel(await ctx.ui.select("Persistent memory model role", roles.map((item) => `${item} (current: ${readMemoryModelOverride(item) ?? "default"})`)));
	if (!role) {
		if (!roleArg) return;
		return ctx.ui.notify(`Unknown memory model role: ${roleArg}.`, "warning");
	}

	const available = await Promise.resolve(ctx.modelRegistry?.getAvailable?.() ?? []);
	if (available.length === 0) return ctx.ui.notify("No available models found.", "warning");

	const requestedModel = parts[0] === role ? parts[1] : parts[0];
	const selectedRef = requestedModel
		? requestedModel
		: await ctx.ui.select(
			`Model for persistent memory ${role}`,
			available.map((model) => modelReference(model)),
		);
	if (!selectedRef) return;
	const selected = resolveAvailableModelReference(selectedRef, available);
	if (!selected) return ctx.ui.notify(`Unknown available model${requestedModel ? `: ${requestedModel}` : ""}.`, "warning");

	const reference = modelReference(selected);
	writeMemoryModelOverride(role, reference);
	ctx.ui.notify(`Persistent memory ${role} model: ${reference}`, "info");
}

function roleFromLabel(label: string | undefined): MemoryModelRole | undefined {
	if (!label) return undefined;
	if (label.startsWith("extraction")) return "extraction";
	if (label.startsWith("adjudication")) return "adjudication";
	return undefined;
}

async function memoryStatusCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify(lastRebuildError ? `Memory not initialized: ${lastRebuildError}` : "No project memory dir.", "warning");
		return;
	}

	const stagingFiles = listStagingFiles(memoryPaths.projectMemoryDir);
	const recentRuns = readRecentReconcileRuns(memoryPaths, 5);
	const lines = [
		"Memory status:",
		`  Staging files: ${stagingFiles.length}`,
		`  Reconciliation: ${reconcileInFlight ? "in flight" : "idle"}`,
		`  Last index error: ${lastRebuildError ?? "none"}`,
	];

	if (recentRuns.length === 0) {
		lines.push("  Recent reconcile runs: none");
	} else {
		lines.push("  Recent reconcile runs:");
		for (const run of recentRuns) {
			const reason = run.reason ? ` (${run.reason})` : "";
			const model = run.model ? ` model=${run.model}` : "";
			const metric = run.candidateMetrics
				? ` outcomes=${run.candidateMetrics.total} discard/dup=${formatPercent(run.candidateMetrics.discardDupRate)}`
				: "";
			lines.push(`    ${run.finishedAt} ${run.source} ${run.status}${reason} ${run.durationMs}ms${model}${metric}`);
			if (run.candidateOutcomes && run.candidateOutcomes.length > 0) {
				const summarized = summarizeCandidateOutcomes(run.candidateOutcomes);
				lines.push(`      per-candidate: ${summarized}`);
			}
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
	if ((ctx as ExtensionCommandContext & { hasUI?: boolean }).hasUI) {
		updateMemoryMeter(ctx.ui, { showPanel: true, panelTitle: "Memory status", clearAfterMs: MEMORY_PANEL_CLEAR_MS });
	}
}

async function listStaging(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const files = listStagingFiles(memoryPaths.projectMemoryDir);
	if (files.length === 0) {
		ctx.ui.notify("No staging files.", "info");
		return;
	}

	const lines = [`Staging files (${files.length}):`];
	for (const filePath of files) {
		const data = readStaging(filePath);
		if (!data) {
			lines.push(`  ${path.basename(filePath)}: (parse failed)`);
			continue;
		}
		const candidates = data.candidates;
		lines.push(
			`  ${path.basename(filePath)}: ${candidates.lessons?.length ?? 0} lessons, ${candidates.preferences?.length ?? 0} prefs, ${candidates.decisions?.length ?? 0} decisions, ${candidates.domain?.length ?? 0} domain`,
		);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function recoverMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}
	const releaseLock = acquireCanonicalWriterLock(memoryPaths);
	if (!releaseLock) {
		ctx.ui.notify("Memory canonical writer already running; try again after it finishes.", "warning");
		return;
	}
	try {
		const result = recoverDeadLetters(memoryPaths);
		ctx.ui.notify(
			`Memory recover complete: ${result.requeued} re-queued, ${result.duplicates} duplicate(s) skipped, ${result.skipped} malformed left in deadletter.`,
			result.skipped > 0 ? "warning" : "info",
		);
	} catch (error) {
		ctx.ui.notify(`Memory recover failed: ${formatError(error)}; deadletter files preserved.`, "error");
	} finally {
		releaseLock();
	}
}

function recoverDeadLetters(paths: MemoryPaths): { requeued: number; duplicates: number; skipped: number } {
	if (!paths.projectMemoryDir) return { requeued: 0, duplicates: 0, skipped: 0 };
	const groups = new Map<string, { staging: StagingFile; files: string[]; seen: Set<string>; requeued: number; duplicates: number }>();
	let skipped = 0;
	for (const filePath of listDeadLetterFiles(paths.projectMemoryDir)) {
		const dead = readDeadLetter(filePath);
		if (!dead || !isRecoverableCategory(dead.category)) { skipped += 1; continue; }
		const sessionId = typeof dead.session_id === "string" && dead.session_id.trim() ? dead.session_id : "recovered";
		const group = groups.get(sessionId) ?? newRecoverGroup(paths, sessionId, dead.produced_at);
		groups.set(sessionId, group);
		const candidate = { ...dead.candidate, reconcile_attempts: dead.attempts };
		const key = `${dead.category}:${stableJson(candidate)}`;
		if (group.seen.has(key)) {
			group.duplicates += 1;
			group.files.push(filePath);
			continue;
		}
		(group.staging.candidates[dead.category] as unknown[]).push(candidate);
		const repaired = repairStagingFile(group.staging);
		if (!repaired) {
			(group.staging.candidates[dead.category] as unknown[]).pop();
			skipped += 1;
			continue;
		}
		group.staging = repaired;
		group.seen.add(key);
		group.files.push(filePath);
		group.requeued += 1;
	}

	let requeued = 0;
	let duplicates = 0;
	for (const group of groups.values()) {
		if (group.files.length === 0) continue;
		const repaired = repairStagingFile(group.staging);
		if (!repaired) { skipped += group.files.length; continue; }
		writeStaging(path.join(paths.projectMemoryDir, "staging", `${group.staging.session_id}.json`), repaired);
		for (const filePath of group.files) fs.rmSync(filePath, { force: true });
		requeued += group.requeued;
		duplicates += group.duplicates;
	}
	return { requeued, duplicates, skipped };
}

function newRecoverGroup(paths: MemoryPaths, sessionId: string, producedAt: string): { staging: StagingFile; files: string[]; seen: Set<string>; requeued: number; duplicates: number } {
	const existingPath = path.join(paths.projectMemoryDir!, "staging", `${sessionId}.json`);
	const existing = readStaging(existingPath);
	const staging: StagingFile = existing ?? {
		schemaVersion: 1,
		session_id: sessionId,
		produced_at: producedAt || new Date().toISOString(),
		project_root: paths.projectRoot ?? "",
		candidates: { lessons: [], preferences: [], decisions: [], domain: [] },
	};
	const seen = new Set<string>();
	for (const category of ["lessons", "preferences", "decisions", "domain"] as const) {
		for (const candidate of staging.candidates[category]) seen.add(`${category}:${stableJson(candidate)}`);
	}
	return { staging, files: [], seen, requeued: 0, duplicates: 0 };
}

function isRecoverableCategory(category: unknown): category is keyof StagingFile["candidates"] {
	return category === "lessons" || category === "preferences" || category === "decisions" || category === "domain";
}

function stableJson(value: unknown): string {
	if (!value || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

async function listDeadLetter(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const files = listDeadLetterFiles(memoryPaths.projectMemoryDir);
	if (files.length === 0) {
		ctx.ui.notify("No dead-lettered candidates.", "info");
		return;
	}

	const lines = [`Dead-lettered candidates (${files.length}):`];
	for (const filePath of files) {
		const data = readDeadLetter(filePath);
		if (!data) {
			lines.push(`  ${path.basename(filePath)}: (parse failed)`);
			continue;
		}
		const summaryOrText = data.candidate?.summary || data.candidate?.text || "(empty)";
		lines.push(
			`  [${data.category}] "${summaryOrText}" (Attempts: ${data.attempts}) - Reason: ${data.last_gate_reason} - Session: ${data.session_id}`,
		);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// T12 — /memory lowsignal
// ---------------------------------------------------------------------------

async function lowSignalCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const lessonsPath = path.join(memoryPaths.projectMemoryDir, "lessons.md");
	if (!fs.existsSync(lessonsPath)) {
		ctx.ui.notify("No lessons file found.", "info");
		return;
	}

	const lessons = parseLessonsFile(lessonsPath);

	// Show currently flagged low-signal lessons
	const flagged = lessons.filter((l) => l.meta.low_signal);
	if (flagged.length === 0) {
		// Also compute what would be flagged
		const firedIds = gatherFiredLessonIds(memoryPaths.projectMemoryDir);
		const { result } = flagLowSignalLessons(lessons, { firedLessonIds: firedIds });
		if (result.flaggedIds.length === 0) {
			ctx.ui.notify("No low-signal lessons detected.", "info");
		} else {
			ctx.ui.notify(`No currently flagged lessons, but ${result.flaggedIds.length} would be flagged on next sweep: ${result.flaggedIds.join(", ")}`, "info");
		}
		return;
	}

	const lines = [`⚠ Low-signal lessons (${flagged.length}):`];
	for (const lesson of flagged) {
		const age = lesson.meta.last_seen_at ?? lesson.meta.created_at;
		lines.push(`  ${lesson.id} [rc=${lesson.meta.reinforcement_count}] last=${age} — ${lesson.summary}`);
	}
	lines.push("", "Run /memory sweep to refresh flags. Low-signal lessons are flagged for review, never deleted.");
	ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// T12 — /memory contradictions
// ---------------------------------------------------------------------------

async function contradictionsCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const lessonsPath = path.join(memoryPaths.projectMemoryDir, "lessons.md");
	if (!fs.existsSync(lessonsPath)) {
		ctx.ui.notify("No lessons file found.", "info");
		return;
	}

	const lessons = parseLessonsFile(lessonsPath);
	const existingGroups = new Map<string, string[]>();
	for (const lesson of lessons) {
		if (!lesson.meta.contradiction_group) continue;
		const group = existingGroups.get(lesson.meta.contradiction_group) ?? [];
		group.push(lesson.id);
		existingGroups.set(lesson.meta.contradiction_group, group);
	}

	if (existingGroups.size > 0) {
		const lines = [`⚡ Queued contradiction groups (${existingGroups.size}):`];
		for (const [groupId, memberIds] of existingGroups) {
			const summaries = memberIds
				.map((id) => {
					const lesson = lessons.find((l) => l.id === id);
					return lesson ? `${id} — ${lesson.summary}` : id;
				})
				.join(", ");
			lines.push(`  ${groupId}: ${summaries}`);
		}
		lines.push("", "Contradictions are queued for adjudication, never auto-resolved.");
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const { result } = detectContradictions(lessons);
	if (result.pairs.length === 0) {
		ctx.ui.notify("No contradictions detected among active lessons.", "info");
		return;
	}

	const lines = [`⚡ Suspected contradictions (${result.pairs.length} pairs in ${result.groups.size} groups):`];
	for (const [groupId, memberIds] of result.groups) {
		const summaries = Array.from(memberIds)
			.map((id) => {
				const lesson = lessons.find((l) => l.id === id);
				return lesson ? `${id} — ${lesson.summary}` : id;
			})
			.join(", ");
		lines.push(`  ${groupId}: ${summaries}`);
	}

	lines.push("", "Shared triggers:");
	for (const pair of result.pairs) {
		lines.push(`  ${pair.lessonA} ↔ ${pair.lessonB}: ${pair.sharedTrigger}`);
	}

	lines.push("", "Run /memory sweep to assign contradiction groups. Contradictions are queued for adjudication, never auto-resolved.");
	ctx.ui.notify(lines.join("\n"), "info");
}

/** Read the firing log and return the set of lesson IDs that have fired. */
function gatherFiredLessonIds(projectMemoryDir: string): Set<string> {
	const firedIds = new Set<string>();
	const logPath = path.join(projectMemoryDir, "firings.jsonl");
	if (!fs.existsSync(logPath)) return firedIds;
	try {
		const raw = fs.readFileSync(logPath, "utf-8");
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (record?.lesson_id) firedIds.add(record.lesson_id);
			} catch { /* skip malformed lines */ }
		}
	} catch { /* skip unreadable log */ }
	return firedIds;
}

async function listFirings(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const logPath = path.join(memoryPaths.projectMemoryDir, "firings.jsonl");
	if (!fs.existsSync(logPath)) {
		ctx.ui.notify("No fired-without-effect events recorded.", "info");
		return;
	}

	const rawLines = fs.readFileSync(logPath, "utf-8").split(/\r?\n/).filter(Boolean);
	if (rawLines.length === 0) {
		ctx.ui.notify("No fired-without-effect events recorded.", "info");
		return;
	}

	const recent = rawLines.slice(-20);
	const start = rawLines.length - recent.length + 1;
	const lines = [`Recent fired-without-effect events (${recent.length} of ${rawLines.length}):`];
	for (let index = 0; index < recent.length; index++) {
		lines.push(`  ${formatFiringLogLine(recent[index]!, start + index)}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function formatFiringLogLine(line: string, lineNumber: number): string {
	try {
		const record = asRecord(JSON.parse(line));
		const firing = asRecord(record.firing);
		const later = asRecord(record.later_tool_call);
		const at = stringValue(record.logged_at) || stringValue(record.fired_at) || "unknown-time";
		const lessonId = stringValue(record.lesson_id) || "unknown-lesson";
		const trigger = formatTriggerSummary(record.trigger);
		const toolName = stringValue(later.tool_name) || stringValue(firing.tool_name);
		const excerpt = stringValue(later.bash_command_excerpt)
			|| stringValue(firing.bash_command_excerpt)
			|| stringValue(later.tool_input_excerpt)
			|| stringValue(firing.tool_input_excerpt);
		return `#${lineNumber} ${at} ${lessonId} ${trigger}${toolName ? ` tool=${toolName}` : ""}${excerpt ? ` — ${compactDisplay(excerpt, 140)}` : ""}`;
	} catch {
		return `#${lineNumber} (malformed JSONL) ${compactDisplay(line, 180)}`;
	}
}

function formatTriggerSummary(raw: unknown): string {
	const trigger = asRecord(raw);
	if (trigger.type === "command") return `command:${compactDisplay(stringValue(trigger.pattern), 80)}`;
	if (trigger.type === "tool") {
		const pattern = stringValue(trigger.pattern);
		return `tool:${stringValue(trigger.value)}${pattern ? `/${compactDisplay(pattern, 60)}` : ""}`;
	}
	if (trigger.type === "path" || trigger.type === "filename" || trigger.type === "topic") {
		return `${String(trigger.type)}:${compactDisplay(stringValue(trigger.value), 80)}`;
	}
	return "trigger:unknown";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function compactDisplay(value: string, maxChars: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

async function listMemory(ctx: ExtensionCommandContext): Promise<void> {
	if (!db || !memoryPaths) {
		ctx.ui.notify(lastRebuildError ? `Memory not initialized: ${lastRebuildError}` : "Memory not initialized.", "error");
		return;
	}

	const counts = getIndexCounts(db);
	const lessons = queryAll<{ id: string; summary: string; project_scope: string; status: string }>(
		"SELECT id, summary, project_scope, status FROM lessons ORDER BY id",
	);
	const preferences = queryAll<{ id: string; text: string; scope: string }>(
		"SELECT id, text, scope FROM preferences ORDER BY id",
	);
	const decisions = queryAll<{ id: string; summary: string; scope: string }>(
		"SELECT id, summary, scope FROM decisions ORDER BY id",
	);
	const domainFacts = queryAll<{ id: string; summary: string; scope: string }>(
		"SELECT id, summary, scope FROM domain_facts ORDER BY id",
	);

	// T12: gather low-signal and contradiction info from markdown
	let lowSignalLessonIds: string[] = [];
	let contradictionGroups: Map<string, string[]> = new Map();
	if (memoryPaths.projectMemoryDir) {
		const lessonsPath = path.join(memoryPaths.projectMemoryDir, "lessons.md");
		const allLessons = parseLessonsFile(lessonsPath);
		for (const lesson of allLessons) {
			if (lesson.meta.low_signal) lowSignalLessonIds.push(lesson.id);
			if (lesson.meta.contradiction_group) {
				const group = contradictionGroups.get(lesson.meta.contradiction_group) ?? [];
				group.push(lesson.id);
				contradictionGroups.set(lesson.meta.contradiction_group, group);
			}
		}
	}
	const lowSignalSet = new Set(lowSignalLessonIds);

	const lines = [
		"Memory paths:",
		`  Project: ${memoryPaths.projectMemoryDir ?? "(none — running outside a project)"}`,
		`  Global:  ${memoryPaths.globalMemoryDir}`,
		"",
		`Lessons (${counts.lessons}):`,
		...(lessons.length > 0
			? lessons.map((lesson) => {
					const tags: string[] = [];
					if (lowSignalSet.has(lesson.id)) tags.push("⚠low-signal");
					// Check if this lesson is in a contradiction group
					for (const [group, ids] of contradictionGroups) {
						if (ids.includes(lesson.id)) {
							tags.push(`⚡${group}`);
							break;
						}
					}
					const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
					return `  ${lesson.id} [${lesson.status}] ${lesson.project_scope} — ${lesson.summary}${tagStr}`;
				})
			: ["  (none)"]),
		"",
		`Preferences (${counts.preferences}):`,
		...(preferences.length > 0
			? preferences.map((preference) => `  ${preference.id} [${preference.scope}] ${preference.text}`)
			: ["  (none)"]),
		"",
		`Decisions (${counts.decisions}):`,
		...(decisions.length > 0
			? decisions.map((decision) => `  ${decision.id} [${decision.scope}] ${decision.summary}`)
			: ["  (none)"]),
		"",
		`Domain (${counts.domainFacts}):`,
		...(domainFacts.length > 0
			? domainFacts.map((domainFact) => `  ${domainFact.id} [${domainFact.scope}] ${domainFact.summary}`)
			: ["  (none)"]),
	];

	// T12: append low-signal + contradiction summaries
	if (lowSignalLessonIds.length > 0) {
		lines.push("", `⚠ Low-signal (${lowSignalLessonIds.length}): ${lowSignalLessonIds.join(", ")}`);
	}
	if (contradictionGroups.size > 0) {
		lines.push("", `⚡ Contradiction groups (${contradictionGroups.size}):`);
		for (const [group, ids] of contradictionGroups) {
			lines.push(`  ${group}: ${ids.join(", ")}`);
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function sweepMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!memoryPaths?.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	if (reconcileInFlight) {
		ctx.ui.notify("Reconciliation is in flight; wait for it to finish before running /memory sweep.", "warning");
		return;
	}

	try {
		const result = runOfflineSweep(memoryPaths);

		const summaryLines: string[] = [];

		// T11: archival results
		if (result.archivalChanged) {
			summaryLines.push(`Archived: ${result.archivedCount} lesson(s).`);
		} else {
			summaryLines.push("Archival: nothing to archive.");
		}

		// T12: low-signal results
		if (result.lowSignalChanged) {
			summaryLines.push(`⚠ Low-signal flagged: ${result.lowSignalCount} lesson(s).`);
		} else {
			summaryLines.push("Low-signal: no new flags.");
		}

		// T12: contradiction results
		if (result.contradictionChanged) {
			summaryLines.push(`⚡ Contradictions detected: ${result.contradictionPairs} pair(s) in ${result.contradictionGroups} group(s).`);
		} else {
			summaryLines.push("Contradictions: none detected.");
		}

		if (!result.anyChange) {
			ctx.ui.notify("Sweep found nothing to change.", "info");
			return;
		}

		// Rebuild sqlite index to reflect all changes
		if (db) {
			try {
				rebuildIndex(db, memoryPaths);
				lastRebuildError = null;
			} catch (error) {
				lastRebuildError = formatError(error);
				ctx.ui.notify(`Sweep applied but index rebuild failed: ${lastRebuildError}`, "warning");
				return;
			}
		}

		ctx.ui.notify(`Sweep complete: ${summaryLines.join(" ")}`, "info");
	} catch (error) {
		ctx.ui.notify(`Sweep failed: ${formatError(error)}`, "error");
	}
}

function runOfflineSweep(paths: MemoryPaths): {
	anyChange: boolean;
	archivalChanged: boolean;
	archivedCount: number;
	lowSignalChanged: boolean;
	lowSignalCount: number;
	contradictionChanged: boolean;
	contradictionPairs: number;
	contradictionGroups: number;
} {
	if (!paths.projectMemoryDir) {
		return { anyChange: false, archivalChanged: false, archivedCount: 0, lowSignalChanged: false, lowSignalCount: 0, contradictionChanged: false, contradictionPairs: 0, contradictionGroups: 0 };
	}

	const lessonsPath = path.join(paths.projectMemoryDir, "lessons.md");
	let lessons = parseLessonsFile(lessonsPath);
	if (lessons.length === 0) {
		return { anyChange: false, archivalChanged: false, archivedCount: 0, lowSignalChanged: false, lowSignalCount: 0, contradictionChanged: false, contradictionPairs: 0, contradictionGroups: 0 };
	}

	let anyChange = false;

	// Phase 1: T11 archival sweep
	const sweepResult = sweepLessons(lessons);
	const archivalChanged = sweepResult.result.changed;
	const archivedCount = sweepResult.result.archivedLessonIds.length;
	if (archivalChanged) {
		lessons = sweepResult.lessons;
		anyChange = true;
	}

	// Phase 2: T12 low-signal flagging
	// Gather fired lesson IDs from the firing log
	const firedIds = new Set<string>();
	const logPath = path.join(paths.projectMemoryDir, "firings.jsonl");
	if (fs.existsSync(logPath)) {
		try {
			const raw = fs.readFileSync(logPath, "utf-8");
			for (const line of raw.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line);
					if (record?.lesson_id) firedIds.add(record.lesson_id);
				} catch { /* skip malformed lines */ }
			}
		} catch { /* skip unreadable log */ }
	}

	const lowSignalResult = flagLowSignalLessons(lessons, { firedLessonIds: firedIds });
	const lowSignalChanged = lowSignalResult.result.changed;
	const lowSignalCount = lowSignalResult.result.flaggedIds.length;
	if (lowSignalChanged) {
		lessons = lowSignalResult.lessons;
		anyChange = true;
	}

	// Phase 3: T12 contradiction detection
	const contradictionResult = detectContradictions(lessons);
	const contradictionChanged = contradictionResult.result.changed;
	const contradictionPairs = contradictionResult.result.pairs.length;
	const contradictionGroups = contradictionResult.result.groups.size;
	if (contradictionChanged) {
		lessons = contradictionResult.lessons;
		anyChange = true;
	}

	// Write back to markdown if anything changed
	if (anyChange) {
		rewriteLessonsFile(lessonsPath, lessons);
	}

	return {
		anyChange,
		archivalChanged,
		archivedCount,
		lowSignalChanged,
		lowSignalCount,
		contradictionChanged,
		contradictionPairs,
		contradictionGroups,
	};
}

export function getLifecycleGenerationForTest(): number {
	return lifecycleGeneration;
}
export function setLifecycleGenerationForTest(val: number): void {
	lifecycleGeneration = val;
}
export function getDbForTest(): any | null {
	return db;
}
export function setDbForTest(val: any | null): void {
	db = val;
}
export function getMemoryPathsForTest(): any | null {
	return memoryPaths;
}
export function setMemoryPathsForTest(val: any | null): void {
	memoryPaths = val;
}
export function getReconcileInFlightForTest(): boolean {
	return reconcileInFlight;
}
