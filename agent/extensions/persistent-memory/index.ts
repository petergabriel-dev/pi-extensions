import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCodebaseMap, scheduleRegeneration } from "./codebase-map/regeneration.js";
import { callCarefulModelOneShot } from "./consolidation/careful-model.js";
import { runExtraction } from "./consolidation/extract.js";
import { runReconciliation } from "./consolidation/reconcile.js";
import { listStagingFiles, readStaging, listDeadLetterFiles, readDeadLetter } from "./consolidation/staging.js";
import { registerMarkerHooks } from "./reinforcement/markers.js";
import { applyReinforcementUpdates } from "./reinforcement/tracker.js";
import { clearFiringLog, logFiring, logToolCall, type ToolCallObservation } from "./retrieval/firing-log.js";
import { formatTier1Block, formatTier2Block } from "./retrieval/inject.js";
import { selectTier1 } from "./retrieval/tier1.js";
import { matchTier2, type Match } from "./retrieval/tier2.js";
import { registerRecallTool } from "./retrieval/tier3.js";
import { initializeProjectMemory, type MemoryIgnoreResult, type MemoryInitResult } from "./storage/init.js";
import { ensureMemoryDirs, type MemoryPaths, projectScopeFromMemoryPaths, resolveMemoryIndexPath, resolveMemoryPaths } from "./storage/paths.js";
import { getIndexCounts, openIndex, rebuildIndex, type RebuildCounts, type SqliteDatabase } from "./storage/sqlite.js";
import { classifyReason, shouldSwap, type ClassifiedReason, captureCtx } from "./lifecycle.js";
import { resolveCarefulModel } from "./model-resolution.js";

const DEFAULT_EXTRACTION_TIMEOUT_MS = 180_000;
const EXTRACTION_TIMEOUT_ENV = "PERSISTENT_MEMORY_EXTRACTION_TIMEOUT_MS";
const DEFAULT_EXTRACTION_THINKING_LEVEL: ThinkingLevel = "off";
const EXTRACTION_THINKING_LEVEL_ENV = "PERSISTENT_MEMORY_EXTRACTION_THINKING_LEVEL";
const ALLOWED_EXTRACTION_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 180_000;
const RECONCILIATION_TIMEOUT_ENV = "PERSISTENT_MEMORY_RECONCILIATION_TIMEOUT_MS";
const DEFAULT_RECONCILIATION_CHUNK_SIZE = 20;
const RECONCILIATION_CHUNK_SIZE_ENV = "PERSISTENT_MEMORY_RECONCILIATION_CHUNK_SIZE";
const DEFAULT_RECONCILIATION_BUDGET_MS = 240_000;
const RECONCILIATION_BUDGET_ENV = "PERSISTENT_MEMORY_RECONCILIATION_BUDGET_MS";
const MAX_ERROR_DETAIL_CHARS = 500;

const RECONCILIATION_MODEL_ENV = "PERSISTENT_MEMORY_RECONCILIATION_MODEL";
const EXTRACTION_MODEL_ENV = "PERSISTENT_MEMORY_EXTRACTION_MODEL";

interface ExtractionConfig {
	timeoutMs: number;
	thinkingLevel: ThinkingLevel;
}

interface ReconciliationConfig {
	chunkSize: number;
	budgetMs: number;
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
let extractionInFlight = false;
let callCarefulModelImpl = callCarefulModelOneShot;

export function setCallCarefulModelImplForTest(impl: typeof callCarefulModelOneShot): void {
	callCarefulModelImpl = impl;
}

export default function persistentMemory(pi: ExtensionAPI) {
	registerRecallTool(pi, () => db, currentProjectScope);
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

			triggerBackgroundReconciliation(ctx, memoryPaths, lifecycleGeneration, pi.ui);
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

	pi.on("session_shutdown", async (event, ctx) => {
		lifecycleGeneration++;
		const classified = classifyReason(event?.reason, "quit");
		try {
			if (memoryPaths?.projectMemoryDir && !classified.isReload) {
				const sessionId = getSessionId(ctx);
				const capturedCtx = captureCtx(ctx);
				const extraction = extractionConfig();
				const chosenModel = resolveCarefulModel(EXTRACTION_MODEL_ENV, capturedCtx as any, shutdownExtractionLogger);

				const branchSnapshot = ctx.sessionManager?.getBranch
					? JSON.parse(JSON.stringify(ctx.sessionManager.getBranch()))
					: [];
				const capturedPaths = { ...memoryPaths };

				const runExtractionTask = async () => {
					if (extractionInFlight) {
						console.log("[persistent-memory] extraction already in flight; skipping background run.");
						return;
					}
					extractionInFlight = true;
					try {
						const stubCtx = {
							sessionManager: {
								getBranch: () => branchSnapshot
							}
						};
						await runExtraction(stubCtx, capturedPaths, sessionId, {
							logger: shutdownExtractionLogger,
							callCarefulModel: (systemPrompt, userPrompt) =>
								callCarefulModelImpl(systemPrompt, userPrompt, {
									cwd: capturedCtx.cwd,
									...(chosenModel ? { model: chosenModel as never } : {}),
									thinkingLevel: extraction.thinkingLevel,
									timeoutMs: extraction.timeoutMs,
									logger: shutdownExtractionLogger,
								}),
						});
					} catch (err) {
						console.error(`[persistent-memory] extraction failed: ${formatError(err)}`);
					} finally {
						extractionInFlight = false;
					}
				};

				const isBackgroundReason = event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork";
				if (isBackgroundReason) {
					setTimeout(() => {
						void runExtractionTask();
					}, 0);
				} else {
					await runExtractionTask();
				}
			}

			if (memoryPaths && db && !classified.isReload) {
				try {
					const reinforcement = applyReinforcementUpdates(memoryPaths, db, { logger: console });
					if (reinforcement.rebuild_status === "failed") {
						lastRebuildError = reinforcement.rebuild_error ?? "SQLite rebuild failed after reinforcement.";
						ctx.ui.notify(`persistent-memory reinforcement wrote markdown but index rebuild failed: ${lastRebuildError}`, "warning");
					} else if (reinforcement.rebuild_status === "succeeded") {
						lastRebuildError = null;
					}
					if (reinforcement.write_errors.length > 0) {
						ctx.ui.notify(`persistent-memory reinforcement had ${reinforcement.write_errors.length} markdown write error(s).`, "warning");
					}
				} catch (error) {
					const message = formatError(error);
					console.warn(`[persistent-memory] reinforcement failed: ${message}`);
					ctx.ui.notify(`persistent-memory reinforcement failed: ${message}`, "warning");
				}
			}
		} finally {
			clearPendingReminderLessons();
			if (!classified.isReload) {
				clearFiringLog();
			}
			db?.close();
			db = null;
			memoryPaths = null;
		}
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
			if (trimmed === "reconcile") {
				await reconcileMemoryCommand(ctx);
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
			ctx.ui.notify("Usage: /memory, /memory list, /memory init, /memory staging, /memory reconcile, /memory firings, or /memory deadletter", "warning");
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

function triggerBackgroundReconciliation(
	ctx: { cwd?: string; model?: unknown; modelRegistry?: any; thinkingLevel?: any },
	paths: MemoryPaths,
	startGen: number,
	ui: ExtensionAPI["ui"]
): void {
	if (reconcileInFlight) {
		console.log("[persistent-memory] reconciliation already in flight; skipping background trigger.");
		return;
	}

	const capturedCtx = captureCtx(ctx);

	reconcileInFlight = true;
	try {
		(ui as any).setStatus?.("persistent-memory", "Memory consolidating...");
	} catch (err) {
		// ignore
	}

	setTimeout(async () => {
		let bgDb: SqliteDatabase | null = null;
		try {
			if (!paths.projectMemoryDir) {
				if (shouldSwap(startGen, lifecycleGeneration)) {
					if (db) {
						rebuildIndex(db, paths);
					}
				}
				return;
			}

			const dbPath = indexPathForMemoryPaths(paths);
			bgDb = openIndex(dbPath);

			const reconciliation = reconciliationConfig();
			const result = await runReconciliation(paths, bgDb, {
				rebuildOnNoop: true,
				logger: console,
				chunkSize: reconciliation.chunkSize,
				wallClockBudgetMs: reconciliation.budgetMs,
				shouldContinue: () => shouldSwap(startGen, lifecycleGeneration),
				onChunkStart: (chunkIndex, totalChunks) => {
					try {
						(ui as any).setStatus?.("persistent-memory", `Memory consolidating... (chunk ${chunkIndex}/${totalChunks})`);
					} catch {
						// ignore status errors
					}
				},
				callCarefulModel: (systemPrompt, userPrompt) => {
					const chosenModel = resolveCarefulModel(RECONCILIATION_MODEL_ENV, capturedCtx, console);
					return callCarefulModelImpl(systemPrompt, userPrompt, {
						cwd: capturedCtx.cwd,
						...(chosenModel ? { model: chosenModel as never } : {}),
						...(capturedCtx.thinkingLevel ? { thinkingLevel: capturedCtx.thinkingLevel as never } : {}),
						timeoutMs: reconciliationTimeoutMs(),
						logger: console,
					});
				},
			});

			if (!shouldSwap(startGen, lifecycleGeneration)) {
				console.warn(`[persistent-memory] background reconciliation finished but generation changed (${startGen} -> ${lifecycleGeneration}); discarding background index.`);
				if (bgDb) {
					closeDatabaseQuietly(bgDb, "stale background db");
				}
				return;
			}

			if (result.status === "failed") {
				console.warn(
					`[persistent-memory] background reconciliation failed (${result.reason}): ${formatError(result.error)}; preserving staging and continuing.`,
				);
				if (!result.indexRebuilt && result.reason !== "index_error") {
					try {
						rebuildIndex(bgDb, paths);
					} catch (rebuildError) {
						console.warn(`[persistent-memory] fallback index rebuild failed after reconciliation failure: ${formatError(rebuildError)}`);
					}
				}
			}

			swapActiveMemory(paths, bgDb);
			bgDb = null;
		} catch (error) {
			const message = formatError(error);
			console.error(`[persistent-memory] background reconciliation threw: ${message}`);
			ui.notify(`persistent-memory background reconciliation failed: ${message}`, "error");
		} finally {
			reconcileInFlight = false;
			try {
				(ui as any).setStatus?.("persistent-memory", undefined);
			} catch (err) {
				// ignore
			}
			if (bgDb) {
				closeDatabaseQuietly(bgDb, "failed background db");
			}
		}
	}, 0);
}

function formatError(error: unknown): string {
	const raw = error instanceof Error
		? `${error.name || "Error"}: ${error.message}`
		: error === undefined
			? "No underlying error detail available."
			: String(error);
	const compact = raw.replace(/\s+/g, " ").trim();
	return compact.length > MAX_ERROR_DETAIL_CHARS ? `${compact.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : compact;
}

const shutdownExtractionLogger = {
	info: (...args: unknown[]) => console.info(formatLogArgs(args)),
	warn: (...args: unknown[]) => console.warn(formatLogArgs(args)),
	error: (...args: unknown[]) => console.warn(formatLogArgs(args)),
};

function formatLogArgs(args: unknown[]): string {
	return args.map((arg) => (arg instanceof Error ? formatError(arg) : String(arg))).join(" ");
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

function getSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
	try {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) return sessionId;
	} catch {
		// Fall back below.
	}
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
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

async function reconcileMemoryCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!db || !memoryPaths) {
		ctx.ui.notify(lastRebuildError ? `Memory not initialized: ${lastRebuildError}` : "Memory not initialized.", "error");
		return;
	}
	if (!memoryPaths.projectMemoryDir) {
		ctx.ui.notify("No project memory dir.", "warning");
		return;
	}

	const modelContext = ctx as ExtensionCommandContext & { cwd?: string; model?: unknown; thinkingLevel?: unknown };
	const reconciliation = reconciliationConfig();
	const result = await runReconciliation(memoryPaths, db, {
		rebuildOnNoop: true,
		logger: console,
		chunkSize: reconciliation.chunkSize,
		wallClockBudgetMs: reconciliation.budgetMs,
		shouldContinue: () => true,
		onChunkStart: (chunkIndex, totalChunks) => {
			try {
				(ctx.ui as any).setStatus?.("persistent-memory", `Memory consolidating... (chunk ${chunkIndex}/${totalChunks})`);
			} catch {
				// ignore status errors
			}
		},
		callCarefulModel: (systemPrompt, userPrompt) => {
			const chosenModel = resolveCarefulModel(RECONCILIATION_MODEL_ENV, modelContext, console);
			return callCarefulModelImpl(systemPrompt, userPrompt, {
				cwd: modelContext.cwd ?? process.cwd(),
				...(chosenModel ? { model: chosenModel as never } : {}),
				...(modelContext.thinkingLevel ? { thinkingLevel: modelContext.thinkingLevel as never } : {}),
				timeoutMs: reconciliationTimeoutMs(),
				logger: console,
			});
		},
	});
	try {
		(ctx.ui as any).setStatus?.("persistent-memory", undefined);
	} catch {
		// ignore status errors
	}

	if (result.status === "failed") {
		ctx.ui.notify(`Memory reconciliation failed (${result.reason}): ${formatError(result.error)}; staging preserved.`, "error");
		return;
	}

	lastRebuildError = null;
	ctx.ui.notify(formatReconciliationResult(result), "info");
}

function formatReconciliationResult(result: Exclude<Awaited<ReturnType<typeof runReconciliation>>, { status: "failed" }>): string {
	const counts = result.counts;
	const lines = [
		`Memory reconciliation ${result.status}.`,
		`Staging: ${counts.stagingFiles.consumed}/${counts.stagingFiles.total} consumed, ${counts.stagingFiles.preserved} preserved.`,
		`Candidates: ${formatTotals(counts.candidates.staged)} staged, ${formatTotals(counts.candidates.exactDuplicates)} exact duplicates, ${formatTotals(counts.candidates.remainingForModel)} model candidates, ${formatTotals(counts.candidates.deadLettered)} dead-lettered.`,
		`Actions: ${formatTotals(counts.actions.add)} added, ${formatTotals(counts.actions.merge)} merged, ${counts.actions.supersede} superseded, ${formatTotals(counts.actions.discard)} discarded.`,
		`Writes: ${formatWriteFlags(counts.writes)}. Index rebuilt: ${result.indexRebuilt ? "yes" : "no"}.`,
	];
	return lines.join("\n");
}

function formatTotals(totals: { lessons: number; preferences: number; decisions: number; domain: number }): string {
	return `${totals.lessons} lessons/${totals.preferences} prefs/${totals.decisions} decisions/${totals.domain} domain`;
}

function formatWriteFlags(writes: { lessons: boolean; preferences: boolean; decisions: boolean; domain: boolean }): string {
	const changed = Object.entries(writes)
		.filter(([, didWrite]) => didWrite)
		.map(([name]) => name);
	return changed.length > 0 ? changed.join(", ") : "none";
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

	const lines = [
		"Memory paths:",
		`  Project: ${memoryPaths.projectMemoryDir ?? "(none — running outside a project)"}`,
		`  Global:  ${memoryPaths.globalMemoryDir}`,
		"",
		`Lessons (${counts.lessons}):`,
		...(lessons.length > 0
			? lessons.map((lesson) => `  ${lesson.id} [${lesson.status}] ${lesson.project_scope} — ${lesson.summary}`)
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

	ctx.ui.notify(lines.join("\n"), "info");
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
export function getExtractionInFlightForTest(): boolean {
	return extractionInFlight;
}
