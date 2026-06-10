import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeExtractionResult, parseModelJson } from "./extract.js";
import { buildReconciliationUserPrompt, RECONCILIATION_SYSTEM_PROMPT } from "./prompts.js";
import { deleteStaging, listStagingFiles, repairStagingFile, writeStaging, writeDeadLetter, type DeadLetteredCandidate } from "./staging.js";
import {
	parseDecisionsFile,
	parseDomainFile,
	parseLessonsFile,
	parsePreferencesFile,
	rewriteDecisionsFile,
	rewriteDomainFile,
	rewriteLessonsFile,
	rewritePreferencesFile,
} from "../storage/markdown.js";
import type { MemoryPaths } from "../storage/paths.js";
import {
	rebuildIndex as rebuildSqliteIndex,
	insertLessons,
	insertPreferences,
	insertDecisions,
	insertDomainFacts,
	type SqliteDatabase,
} from "../storage/sqlite.js";
import type { Decision, DomainFact, Lesson, LessonCandidate, Preference, StagingFile, Trigger } from "../types.js";
import { shortlist, type ShortlistCandidate, type ShortlistRecord } from "./shortlist.js";
import { parseAdjudication, type AdjudicationVerdict } from "./adjudication.js";

export class ReconciliationValidationError extends Error {
	constructor(
		public gate: "extra keys" | "coverage mismatch" | "missing trigger" | "unknown target_id",
		public affectedCount: number,
		public details?: string,
		public offendingRefs: string[] = [],
	) {
		const msg = `Validation gate failed: ${gate} (affected candidates: ${affectedCount})${details ? `. Details: ${details}` : ""}`;
		super(msg);
		this.name = "ReconciliationValidationError";
	}
}

export type PreferenceCandidate = StagingFile["candidates"]["preferences"][number];
export type DecisionCandidate = StagingFile["candidates"]["decisions"][number];
export type DomainCandidate = StagingFile["candidates"]["domain"][number];
export type ReconciliationCategory = "lessons" | "preferences" | "decisions" | "domain";

export interface ReconciliationCandidate<T> {
	ref: string;
	session_id: string;
	produced_at: string;
	category: ReconciliationCategory;
	index: number;
	candidate: T;
}

export interface PreparedReconciliationCandidates {
	lessons: ReconciliationCandidate<LessonCandidate>[];
	preferences: ReconciliationCandidate<PreferenceCandidate>[];
	decisions: ReconciliationCandidate<DecisionCandidate>[];
	domain: ReconciliationCandidate<DomainCandidate>[];
}

export interface LessonReinforcementBump {
	target_id: string;
	count: number;
}

export interface LessonBypass {
	candidate: ReconciliationCandidate<LessonCandidate>;
	matchedExisting: Lesson;
}

export interface LessonPreFilterResult {
	bypassed: LessonBypass[];
	remaining: ReconciliationCandidate<LessonCandidate>[];
	reinforcementBumps: LessonReinforcementBump[];
}

export interface ExactDupe<TCandidate, TExisting> {
	candidate: ReconciliationCandidate<TCandidate>;
	matchedExisting: TExisting;
}

export interface SimplePreFilterResult<TCandidate, TExisting> {
	bypassed: ExactDupe<TCandidate, TExisting>[];
	remaining: ReconciliationCandidate<TCandidate>[];
}

export interface MemoryPreFilterInput {
	existing: {
		lessons: Lesson[];
		preferences: Preference[];
		decisions: Decision[];
		domain: DomainFact[];
	};
	candidates: PreparedReconciliationCandidates;
	projectScope: string;
}

export interface MemoryPreFilterResult {
	lessons: LessonPreFilterResult;
	preferences: SimplePreFilterResult<PreferenceCandidate, Preference>;
	decisions: SimplePreFilterResult<DecisionCandidate, Decision>;
	domain: SimplePreFilterResult<DomainCandidate, DomainFact>;
	remaining: PreparedReconciliationCandidates;
	llmNeeded: boolean;
}

export interface DeterministicAddSplit {
	deterministic: PreparedReconciliationCandidates;
	collision: PreparedReconciliationCandidates;
}

export interface ReconciliationLogger {
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface ReconciliationDeps {
	callCarefulModel?: (systemPrompt: string, userPrompt: string) => Promise<string>;
	now?: () => Date;
	logger?: ReconciliationLogger;
	rebuildOnNoop?: boolean;
	rebuildIndex?: (db: SqliteDatabase, paths: MemoryPaths) => unknown;
	chunkSize?: number;
	wallClockBudgetMs?: number;
	shouldContinue?: () => boolean;
	nowMs?: () => number;
	onChunkStart?: (chunkIndex: number, totalChunks: number) => void;
	/** Test hook called after each deterministic add is committed to markdown + sqlite.
	 *  If it throws, reconciliation fails but already-committed candidates persist. */
	afterDeterministicAddForTest?: (ref: string) => void;
	/** Adjudication model for batched lesson collision resolution (T6).
	 *  Receives a single prompt listing all candidates with their shortlists.
	 *  Must return a JSON object with a `verdicts` array in the same order. */
	callAdjudicationModel?: (prompt: string) => Promise<string>;
	/** Maximum number of lesson candidates per adjudication batch (default 20). */
	adjudicationBatchSize?: number;
}

export interface CategoryTotals {
	lessons: number;
	preferences: number;
	decisions: number;
	domain: number;
}

export interface ReconciliationRunCounts {
	stagingFiles: {
		total: number;
		valid: number;
		malformed: number;
		wrongProject: number;
		deadLettered: number;
		consumed: number;
		preserved: number;
	};
	candidates: {
		staged: CategoryTotals;
		exactDuplicates: CategoryTotals;
		remainingForModel: CategoryTotals;
		deadLettered: CategoryTotals;
	};
	actions: {
		add: CategoryTotals;
		merge: CategoryTotals;
		supersede: number;
		discard: CategoryTotals;
	};
	writes: {
		lessons: boolean;
		preferences: boolean;
		decisions: boolean;
		domain: boolean;
	};
}

export type ReconciliationRunResult =
	| {
			status: "skipped";
			reason: "no_project" | "no_staging" | "no_valid_staging";
			counts: ReconciliationRunCounts;
			llmCalled: false;
			indexRebuilt: boolean;
	  }
	| {
			status: "completed";
			counts: ReconciliationRunCounts;
			llmCalled: boolean;
			indexRebuilt: boolean;
	  }
	| {
			status: "failed";
			reason:
				| "model_error"
				| "parse_error"
				| "invalid_model_response"
				| "write_error"
				| "index_error"
				| "delete_error"
				| "unexpected_error";
			counts: ReconciliationRunCounts;
			llmCalled: boolean;
			indexRebuilt: boolean;
			error?: unknown;
	  };

type LoadedStagingFile = {
	filePath: string;
	data: StagingFile;
};

export type ProjectMemory = {
	lessons: Lesson[];
	preferences: Preference[];
	decisions: Decision[];
	domain: DomainFact[];
};

type ExistingRecordIds = {
	lessons: Set<string>;
	preferences: Set<string>;
	decisions: Set<string>;
	domain: Set<string>;
};

type CandidateRefIndex = Map<string, ReconciliationCandidate<LessonCandidate | PreferenceCandidate | DecisionCandidate | DomainCandidate>>;

type ReconcileCandidateSetResult =
	| {
			status: "completed";
			plan: NormalizedReconciliationPlan;
			appliedRefs: Set<string>;
			attemptedRefs: Set<string>;
			modelErrored: false;
			bestError?: ReconciliationValidationError;
	  }
	| {
			status: "failed";
			reason: "model_error" | "parse_error" | "invalid_model_response";
			plan: NormalizedReconciliationPlan;
			appliedRefs: Set<string>;
			attemptedRefs: Set<string>;
			modelErrored: boolean;
			error?: unknown;
			bestError?: ReconciliationValidationError;
	  };

export type LessonAction =
	| { action: "add"; candidate_refs: string[]; summary: string; detail: string; triggers: Trigger[] }
	| { action: "merge"; candidate_refs: string[]; target_id: string; summary: string; detail: string; triggers: Trigger[] }
	| { action: "supersede"; candidate_refs: string[]; target_id: string; summary: string; detail: string; triggers: Trigger[] }
	| { action: "discard"; candidate_refs: string[]; reason: string };

export type PreferenceAction =
	| { action: "add"; candidate_refs: string[]; text: string }
	| { action: "merge"; candidate_refs: string[]; target_id: string; text: string }
	| { action: "discard"; candidate_refs: string[]; reason: string };

export type SummaryDetailAction =
	| { action: "add"; candidate_refs: string[]; summary: string; detail: string }
	| { action: "merge"; candidate_refs: string[]; target_id: string; summary: string; detail: string }
	| { action: "discard"; candidate_refs: string[]; reason: string };

export interface NormalizedReconciliationPlan {
	lessons: LessonAction[];
	preferences: PreferenceAction[];
	decisions: SummaryDetailAction[];
	domain: SummaryDetailAction[];
}

const EMPTY_TOTALS: CategoryTotals = { lessons: 0, preferences: 0, decisions: 0, domain: 0 };

export async function runReconciliation(
	memoryPaths: MemoryPaths,
	db: SqliteDatabase,
	deps: ReconciliationDeps = {},
): Promise<ReconciliationRunResult> {
	const counts = emptyRunCounts();
	const logger = deps.logger ?? console;
	let llmCalled = false;
	let indexRebuilt = false;

	try {
		if (!memoryPaths.projectMemoryDir || !memoryPaths.projectRoot) {
			return { status: "skipped", reason: "no_project", counts, llmCalled: false, indexRebuilt };
		}

		const stagingFiles = listStagingFiles(memoryPaths.projectMemoryDir);
		counts.stagingFiles.total = stagingFiles.length;
		if (stagingFiles.length === 0) {
			if (deps.rebuildOnNoop) {
				try {
					indexRebuilt = rebuildIndexOrThrow(deps, db, memoryPaths);
				} catch (error) {
					return { status: "failed", reason: "index_error", counts, llmCalled: false, indexRebuilt, error };
				}
			}
			return deps.rebuildOnNoop
				? { status: "completed", counts, llmCalled: false, indexRebuilt }
				: { status: "skipped", reason: "no_staging", counts, llmCalled: false, indexRebuilt };
		}

		const loaded = loadValidSameProjectStaging(stagingFiles, memoryPaths.projectRoot, memoryPaths.projectMemoryDir);
		counts.stagingFiles.valid = loaded.valid.length;
		counts.stagingFiles.malformed = 0;
		counts.stagingFiles.wrongProject = loaded.wrongProject.length;
		counts.stagingFiles.deadLettered = loaded.deadLettered.length;
		counts.stagingFiles.preserved = loaded.wrongProject.length;
		counts.candidates.deadLettered = loaded.deadLetteredCandidates;

		if (loaded.valid.length === 0) {
			if (deps.rebuildOnNoop) {
				try {
					indexRebuilt = rebuildIndexOrThrow(deps, db, memoryPaths);
				} catch (error) {
					return { status: "failed", reason: "index_error", counts, llmCalled: false, indexRebuilt, error };
				}
			}
			return deps.rebuildOnNoop
				? { status: "completed", counts, llmCalled: false, indexRebuilt }
				: { status: "skipped", reason: "no_valid_staging", counts, llmCalled: false, indexRebuilt };
		}

		let projectMemory = readProjectMemory(memoryPaths.projectMemoryDir);
		const projectScope = projectScopeFromRoot(memoryPaths.projectRoot);
		const candidates = prepareStagingCandidates(loaded.valid.map((file) => file.data));
		counts.candidates.staged = candidateTotals(candidates);

		const preFilter = preFilterMemoryCandidates({
			existing: projectMemory,
			candidates,
			projectScope,
		});
		counts.candidates.exactDuplicates = exactTotals(preFilter);
		counts.candidates.remainingForModel = candidateTotals(preFilter.remaining);

		const shortlistSplit = splitByShortlist(preFilter.remaining, projectMemory, projectScope);
		counts.candidates.remainingForModel = candidateTotals(shortlistSplit.collision);

		let plan = emptyPlan();
		let appliedRefs = new Set<string>();
		let attemptedRefs = new Set<string>();
		let bypassedRefsApplied = false;
		let bestError: ReconciliationValidationError | undefined = undefined;
		let terminalFailure: { reason: "model_error" | "parse_error" | "invalid_model_response"; error?: unknown } | undefined = undefined;
		let incrementalWritesDone = false;
		let generationStopped = false;

		const deterministicRefs: string[] = [];
		const hasDeterministic = hasRemainingCandidates(shortlistSplit.deterministic);
		const hasCollision = hasRemainingCandidates(shortlistSplit.collision);

		// --- Deterministic ADD path (zero-model) -----------------------------------
		// Candidates with empty shortlists are added deterministically before any
		// model path, with host-owned ids/timestamps, committed one at a time for
		// crash safety.
		// Helper: process a single deterministic candidate with per-category commit.
		const processOne = async (
			category: ReconciliationCategory,
			candidate: ReconciliationCandidate<any>,
		) => {
			const single = emptyPreparedCandidates();
			(single as any)[category].push(candidate);
			const detPlan = buildDeterministicPlan(single);
			const nowIso = (deps.now?.() ?? new Date()).toISOString();
			// For lessons, use scope_suggestion || projectScope per T4 spec
			const effectiveScope = category === "lessons"
				? ((candidate.candidate as LessonCandidate).scope_suggestion || projectScope)
				: projectScope;
			const effectivePreFilter = bypassedRefsApplied
				? preFilterForChunk(preFilter, single, false)
				: preFilterForChunk(preFilter, single, true);
			const nextMemory = materializeReconciliation(projectMemory, effectivePreFilter, detPlan, effectiveScope, nowIso);

			try {
				counts.writes = mergeWrites(counts.writes, writeChangedProjectMemory(memoryPaths.projectMemoryDir, projectMemory, nextMemory));

				// Incremental sqlite: upsert any new *or changed* records so that
				// supersedes/merges/bumps are reflected without a final full rebuild.
				if (isSqliteLike(db)) {
					upsertChangedProjectMemoryToSqlite(db, memoryPaths.projectMemoryDir!, projectMemory, nextMemory);
					incrementalWritesDone = true;
				}

				// Test hook: throw here to simulate crash after first commit
				deps.afterDeterministicAddForTest?.(candidate.ref);
			} catch (error) {
				// Crash between candidates: first candidate already committed,
				// later candidates remain staged.
				throw error;
			}

			bypassedRefsApplied = true;
			deterministicRefs.push(candidate.ref);
			plan = mergePlans(plan, detPlan);
			projectMemory = readProjectMemory(memoryPaths.projectMemoryDir);
		};

		if (hasDeterministic) {
			try {
				// Process deterministic candidates one-by-one with generation guard
				// between each so stale runs stop before additional writes.
				for (const candidate of shortlistSplit.deterministic.lessons) {
					if (deps.shouldContinue?.() === false) { generationStopped = true; break; }
					await processOne("lessons", candidate);
				}
				for (const candidate of shortlistSplit.deterministic.preferences) {
					if (deps.shouldContinue?.() === false) { generationStopped = true; break; }
					await processOne("preferences", candidate);
				}
				for (const candidate of shortlistSplit.deterministic.decisions) {
					if (deps.shouldContinue?.() === false) { generationStopped = true; break; }
					await processOne("decisions", candidate);
				}
				for (const candidate of shortlistSplit.deterministic.domain) {
					if (deps.shouldContinue?.() === false) { generationStopped = true; break; }
					await processOne("domain", candidate);
				}
			} catch (error) {
				return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
			}
		}

		// --- Model path for collision candidates -----------------------------------
		const modelCandidates = shortlistSplit.collision;

		// --- T6 adjudication path for lesson collision candidates ------------------
		if (deps.callAdjudicationModel && modelCandidates.lessons.length > 0) {
			const batchSize = normalizePositiveInteger(deps.adjudicationBatchSize, 20);
			const lessonCandidates = modelCandidates.lessons;

			// Compute shortlists for each lesson candidate (re-fetch from current memory).
			const lessonShortlists: ShortlistRecord[][] = [];
			for (const candidate of lessonCandidates) {
				const sc: ShortlistCandidate = {
					type: "lesson",
					summary: candidate.candidate.summary,
					detail: candidate.candidate.detail,
					scope_suggestion: candidate.candidate.scope_suggestion,
					triggers: candidate.candidate.triggers,
				};
				lessonShortlists.push(shortlist(sc, projectMemory.lessons as ShortlistRecord[]));
			}

			// Batch and adjudicate. Failures park only the affected batch; they do
			// not fail the whole run or roll back earlier per-candidate commits.
			for (let offset = 0; offset < lessonCandidates.length; offset += batchSize) {
				// Generation guard: stop processing if lifecycle generation changed.
				if (deps.shouldContinue?.() === false) { generationStopped = true; break; }

				const batchCandidates = lessonCandidates.slice(offset, offset + batchSize);
				const batchShortlists = lessonShortlists.slice(offset, offset + batchSize);

				// Mark all in batch as attempted.
				for (const c of batchCandidates) attemptedRefs.add(c.ref);

				const prompt = buildAdjudicationPrompt(batchCandidates, batchShortlists);

				let rawResponse: string;
				try {
					rawResponse = await deps.callAdjudicationModel(prompt);
					llmCalled = true;
				} catch (error) {
					logger.warn?.("[persistent-memory] adjudication model call failed; parking batch.");
					// Park entire batch — no verdicts applied, candidates stay staged.
					continue;
				}

				const adjudicationResult = parseAdjudication(rawResponse);
				if (adjudicationResult.status === "parked") {
					logger.warn?.(`[persistent-memory] adjudication parse returned parked: ${adjudicationResult.message}; parking batch.`);
					continue;
				}

				// Map valid verdicts to plan actions. Partial batches are tolerated:
				// salvaged valid verdicts are applied; missing/invalid ones are parked.
				const mapped = mapVerdictsToPlan(adjudicationResult.verdicts, batchCandidates, batchShortlists, projectMemory, adjudicationResult.parked);

				// Track parked refs as attempted so they get reconcile_attempts incremented.
				for (const ref of mapped.parkedRefs) attemptedRefs.add(ref);

				if (mapped.appliedRefs.size > 0) {
					// Build a minimal prefilter for materializeReconciliation.
					// Only the adjudicated batch candidates are "remaining"; no bypassed here.
					const batchRemaining: PreparedReconciliationCandidates = {
						lessons: batchCandidates.filter((c) => mapped.appliedRefs.has(c.ref)),
						preferences: [],
						decisions: [],
						domain: [],
					};
					const batchPreFilter = preFilterForChunk(preFilter, batchRemaining, !bypassedRefsApplied);
					const nowIso = (deps.now?.() ?? new Date()).toISOString();
					const effectiveScope = projectScope;
					const nextMemory = materializeReconciliation(projectMemory, batchPreFilter, mapped.plan, effectiveScope, nowIso);

					try {
						counts.writes = mergeWrites(counts.writes, writeChangedProjectMemory(memoryPaths.projectMemoryDir, projectMemory, nextMemory));
					} catch (error) {
						return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
					}

					// Incremental sqlite: upsert new AND changed records (supersede
					// changes old target status; merge bumps reinforcement, etc.).
					if (isSqliteLike(db)) {
						upsertChangedProjectMemoryToSqlite(db, memoryPaths.projectMemoryDir!, projectMemory, nextMemory);
						incrementalWritesDone = true;
					}

					bypassedRefsApplied = true;
					projectMemory = readProjectMemory(memoryPaths.projectMemoryDir);
					plan = mergePlans(plan, mapped.plan);
					for (const ref of mapped.appliedRefs) appliedRefs.add(ref);
				}
			}
		}

		// Remove adjudicated lesson candidates from modelCandidates so the
		// legacy path below only sees non-lesson collision candidates.
		modelCandidates.lessons = [];

		if (hasRemainingCandidates(modelCandidates)) {
			if (!deps.callCarefulModel) {
				// No model available but collision candidates exist — they stay staged.
				// deterministicRefs already committed; collision candidates remain for model.
				counts.candidates.remainingForModel = candidateTotals(modelCandidates);
				// Fall through to staging cleanup below (collision candidates remain staged)
			} else {
				// Model available: existing chunked reconciliation
				const chunkSize = normalizePositiveInteger(deps.chunkSize, totalCandidates(modelCandidates));
				const budgetMs = normalizePositiveInteger(deps.wallClockBudgetMs, Number.POSITIVE_INFINITY);
				const startedAtMs = deps.nowMs?.() ?? Date.now();
				let isFirstApply = !bypassedRefsApplied;
				const chunks = chunkCandidates(modelCandidates, chunkSize);

				for (const [chunkIndex, candidatesSubset] of chunks.entries()) {
					deps.onChunkStart?.(chunkIndex + 1, chunks.length);
					if (deps.callCarefulModel) llmCalled = true;
					const reconcileResult = await reconcileCandidateSet(projectMemory, candidatesSubset, projectScope, deps, logger);
					for (const ref of reconcileResult.attemptedRefs) attemptedRefs.add(ref);
					bestError = reconcileResult.bestError ?? bestError;
					if (reconcileResult.status === "failed") {
						terminalFailure = { reason: reconcileResult.reason, error: reconcileResult.error };
						break;
					}

					const chunkPreFilter = preFilterForChunk(preFilter, candidatesSubset, isFirstApply);
					const nowIso = (deps.now?.() ?? new Date()).toISOString();
					const nextMemory = materializeReconciliation(projectMemory, chunkPreFilter, reconcileResult.plan, projectScope, nowIso);
					try {
						counts.writes = mergeWrites(counts.writes, writeChangedProjectMemory(memoryPaths.projectMemoryDir, projectMemory, nextMemory));
						// Incremental sqlite for legacy model path so final rebuild is unnecessary.
						if (isSqliteLike(db)) {
							upsertChangedProjectMemoryToSqlite(db, memoryPaths.projectMemoryDir!, projectMemory, nextMemory);
							incrementalWritesDone = true;
						}
					} catch (error) {
						return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
					}

					if (isFirstApply) bypassedRefsApplied = true;
					projectMemory = readProjectMemory(memoryPaths.projectMemoryDir);
					plan = mergePlans(plan, reconcileResult.plan);
					for (const ref of reconcileResult.appliedRefs) appliedRefs.add(ref);
					isFirstApply = false;

					const elapsedMs = (deps.nowMs?.() ?? Date.now()) - startedAtMs;
					if (elapsedMs >= budgetMs || deps.shouldContinue?.() === false) { generationStopped = true; break; }
				}
			}
		} else {
			// No remaining candidates for model — handle bypassed-only case
			if (!bypassedRefsApplied && !preFilter.llmNeeded) {
				const nowIso = (deps.now?.() ?? new Date()).toISOString();
				const nextMemory = materializeReconciliation(projectMemory, preFilter, plan, projectScope, nowIso);
				try {
					counts.writes = writeChangedProjectMemory(memoryPaths.projectMemoryDir, projectMemory, nextMemory);
					// Incremental sqlite for bypassed-only path (reinforcement bumps, etc.).
					if (isSqliteLike(db)) {
						upsertChangedProjectMemoryToSqlite(db, memoryPaths.projectMemoryDir!, projectMemory, nextMemory);
						incrementalWritesDone = true;
					}
					bypassedRefsApplied = true;
				} catch (error) {
					return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
				}
			}
		}

		counts.actions = actionTotals(plan);

		const bypassedRefs = bypassedRefsApplied
			? [
				...preFilter.lessons.bypassed.map((b) => b.candidate.ref),
				...preFilter.preferences.bypassed.map((b) => b.candidate.ref),
				...preFilter.decisions.bypassed.map((b) => b.candidate.ref),
				...preFilter.domain.bypassed.map((b) => b.candidate.ref),
			]
			: [];
		const resolvedRefs = new Set<string>([
			...bypassedRefs,
			...appliedRefs,
			...deterministicRefs,
		]);

		try {
			const maxAttempts = parsePositiveIntegerEnv(process.env.PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS, 3);
			const lastGateReason = bestError ? bestError.message : "unknown validation failure";

			for (const file of loaded.valid) {
				const stagingData = file.data;

				const finalLeftoverLessons: LessonCandidate[] = [];
				for (const [i, lesson] of stagingData.candidates.lessons.entries()) {
					const ref = `${stagingData.session_id}:lessons:${i + 1}`;
					if (resolvedRefs.has(ref)) continue;
					if (!attemptedRefs.has(ref)) {
						finalLeftoverLessons.push(lesson);
						continue;
					}
					const attempts = (lesson.reconcile_attempts ?? 0) + 1;
					if (attempts > maxAttempts) {
						writeDeadLetter(memoryPaths.projectMemoryDir!, {
							session_id: stagingData.session_id,
							produced_at: stagingData.produced_at,
							attempts,
							last_gate_reason: lastGateReason,
							category: "lessons",
							candidate: { ...lesson, reconcile_attempts: attempts },
						});
						counts.candidates.deadLettered.lessons += 1;
						console.warn(`[persistent-memory] Dead-lettered lesson candidate from session ${stagingData.session_id} after ${attempts} attempts: ${lastGateReason}`);
					} else {
						finalLeftoverLessons.push({
							...lesson,
							reconcile_attempts: attempts,
						});
					}
				}

				const finalLeftoverPreferences: StagingFile["candidates"]["preferences"] = [];
				for (const [i, pref] of stagingData.candidates.preferences.entries()) {
					const ref = `${stagingData.session_id}:preferences:${i + 1}`;
					if (resolvedRefs.has(ref)) continue;
					if (!attemptedRefs.has(ref)) {
						finalLeftoverPreferences.push(pref);
						continue;
					}
					const attempts = (pref.reconcile_attempts ?? 0) + 1;
					if (attempts > maxAttempts) {
						writeDeadLetter(memoryPaths.projectMemoryDir!, {
							session_id: stagingData.session_id,
							produced_at: stagingData.produced_at,
							attempts,
							last_gate_reason: lastGateReason,
							category: "preferences",
							candidate: { ...pref, reconcile_attempts: attempts },
						});
						counts.candidates.deadLettered.preferences += 1;
						console.warn(`[persistent-memory] Dead-lettered preference candidate from session ${stagingData.session_id} after ${attempts} attempts: ${lastGateReason}`);
					} else {
						finalLeftoverPreferences.push({
							...pref,
							reconcile_attempts: attempts,
						});
					}
				}

				const finalLeftoverDecisions: StagingFile["candidates"]["decisions"] = [];
				for (const [i, dec] of stagingData.candidates.decisions.entries()) {
					const ref = `${stagingData.session_id}:decisions:${i + 1}`;
					if (resolvedRefs.has(ref)) continue;
					if (!attemptedRefs.has(ref)) {
						finalLeftoverDecisions.push(dec);
						continue;
					}
					const attempts = (dec.reconcile_attempts ?? 0) + 1;
					if (attempts > maxAttempts) {
						writeDeadLetter(memoryPaths.projectMemoryDir!, {
							session_id: stagingData.session_id,
							produced_at: stagingData.produced_at,
							attempts,
							last_gate_reason: lastGateReason,
							category: "decisions",
							candidate: { ...dec, reconcile_attempts: attempts },
						});
						counts.candidates.deadLettered.decisions += 1;
						console.warn(`[persistent-memory] Dead-lettered decision candidate from session ${stagingData.session_id} after ${attempts} attempts: ${lastGateReason}`);
					} else {
						finalLeftoverDecisions.push({
							...dec,
							reconcile_attempts: attempts,
						});
					}
				}

				const finalLeftoverDomain: StagingFile["candidates"]["domain"] = [];
				for (const [i, dom] of stagingData.candidates.domain.entries()) {
					const ref = `${stagingData.session_id}:domain:${i + 1}`;
					if (resolvedRefs.has(ref)) continue;
					if (!attemptedRefs.has(ref)) {
						finalLeftoverDomain.push(dom);
						continue;
					}
					const attempts = (dom.reconcile_attempts ?? 0) + 1;
					if (attempts > maxAttempts) {
						writeDeadLetter(memoryPaths.projectMemoryDir!, {
							session_id: stagingData.session_id,
							produced_at: stagingData.produced_at,
							attempts,
							last_gate_reason: lastGateReason,
							category: "domain",
							candidate: { ...dom, reconcile_attempts: attempts },
						});
						counts.candidates.deadLettered.domain += 1;
						console.warn(`[persistent-memory] Dead-lettered domain candidate from session ${stagingData.session_id} after ${attempts} attempts: ${lastGateReason}`);
					} else {
						finalLeftoverDomain.push({
							...dom,
							reconcile_attempts: attempts,
						});
					}
				}

				const totalActiveLeftovers = finalLeftoverLessons.length + finalLeftoverPreferences.length + finalLeftoverDecisions.length + finalLeftoverDomain.length;

				if (totalActiveLeftovers === 0) {
					deleteStaging(file.filePath);
					counts.stagingFiles.consumed += 1;
				} else {
					const updatedStaging: StagingFile = {
						schemaVersion: 1,
						session_id: stagingData.session_id,
						produced_at: stagingData.produced_at,
						project_root: stagingData.project_root,
						candidates: {
							lessons: finalLeftoverLessons,
							preferences: finalLeftoverPreferences,
							decisions: finalLeftoverDecisions,
							domain: finalLeftoverDomain,
						}
					};
					writeStaging(file.filePath, updatedStaging);
					counts.stagingFiles.preserved += 1;
				}
			}
		} catch (error) {
			return { status: "failed", reason: "delete_error", counts, llmCalled, indexRebuilt, error };
		}

		// Candidate-processing paths use incremental sqlite writes only. Do not run
		// a final whole-index rebuild here: no-op rebuild compatibility is limited
		// to early-return paths with no valid staged work.
		void incrementalWritesDone;
		void generationStopped;

		if (terminalFailure) {
			return { status: "failed", reason: terminalFailure.reason, counts, llmCalled, indexRebuilt, error: terminalFailure.error };
		}

		return { status: "completed", counts, llmCalled, indexRebuilt };
	} catch (error) {
		logger.warn?.("[persistent-memory] reconciliation failed unexpectedly; preserving staging.");
		return { status: "failed", reason: "unexpected_error", counts, llmCalled, indexRebuilt, error };
	}
}

async function reconcileCandidateSet(
	existing: ProjectMemory,
	candidatesSubset: PreparedReconciliationCandidates,
	projectScope: string,
	deps: ReconciliationDeps,
	logger: ReconciliationLogger,
): Promise<ReconcileCandidateSetResult> {
	const attemptedRefs = allCandidateRefs(candidatesSubset);

	if (!deps.callCarefulModel) {
		return {
			status: "failed",
			reason: "model_error",
			plan: emptyPlan(),
			appliedRefs: new Set(),
			attemptedRefs: new Set(),
			modelErrored: true,
			error: new Error("No reconciliation model configured."),
		};
	}

	const userPrompt = buildReconciliationUserPrompt({ projectName: projectScope, existing, candidates: candidatesSubset });
	let rawResponse: string;
	try {
		rawResponse = await deps.callCarefulModel(RECONCILIATION_SYSTEM_PROMPT, userPrompt);
	} catch (error) {
		logger.warn?.("[persistent-memory] reconciliation model call failed; preserving staging.");
		return { status: "failed", reason: "model_error", plan: emptyPlan(), appliedRefs: new Set(), attemptedRefs: new Set(), modelErrored: true, error };
	}

	let parsed: unknown;
	try {
		parsed = parseModelJson(rawResponse);
	} catch (error) {
		logger.warn?.("[persistent-memory] reconciliation model returned malformed JSON; preserving staging.");
		return { status: "failed", reason: "parse_error", plan: emptyPlan(), appliedRefs: new Set(), attemptedRefs: new Set(), modelErrored: false, error };
	}

	let normalized = normalizeReconciliationResponse(parsed, existing, candidatesSubset);
	let bestParsed = parsed;
	let bestError = normalized instanceof ReconciliationValidationError ? normalized : undefined;

	if (normalized instanceof ReconciliationValidationError) {
		logger.warn?.(`[persistent-memory] reconciliation model returned invalid actions (${normalized.message}); attempting repair retry.`);

		const repairUserPrompt = `${userPrompt}

Your previous response failed validation:
Validation Gate: ${normalized.gate}
Details: ${normalized.message}
Offending candidate refs: ${normalized.offendingRefs.join(", ")}

Please correct these errors and output the complete and valid JSON matching the instructions.`;

		try {
			const rawRepairResponse = await deps.callCarefulModel(RECONCILIATION_SYSTEM_PROMPT, repairUserPrompt);
			const parsedRepair = parseModelJson(rawRepairResponse);
			const normalizedRepair = normalizeReconciliationResponse(parsedRepair, existing, candidatesSubset);
			
			if (normalizedRepair instanceof ReconciliationValidationError) {
				logger.warn?.(`[persistent-memory] reconciliation repair model also returned invalid actions (${normalizedRepair.message}); proceeding to partial reconciliation.`);
				bestParsed = parsedRepair;
				bestError = normalizedRepair;
			} else {
				normalized = normalizedRepair;
			}
		} catch (err) {
			logger.warn?.(`[persistent-memory] reconciliation repair model call/parse failed: ${err}; proceeding to partial reconciliation with first response.`);
		}
	}

	if (normalized instanceof ReconciliationValidationError) {
		const partial = normalizeReconciliationResponsePartial(bestParsed, existing, candidatesSubset);
		const plan = partial.plan;
		const totalActions = plan.lessons.length + plan.preferences.length + plan.decisions.length + plan.domain.length;
		if (totalActions === 0) {
			logger.warn?.("[persistent-memory] reconciliation model response is entirely invalid; re-staging validation-rejected candidates.");
			return { status: "failed", reason: "invalid_model_response", plan, appliedRefs: partial.appliedRefs, attemptedRefs, modelErrored: false, error: bestError, bestError };
		}
		return { status: "completed", plan, appliedRefs: partial.appliedRefs, attemptedRefs, modelErrored: false, bestError };
	}

	return { status: "completed", plan: normalized, appliedRefs: attemptedRefs, attemptedRefs, modelErrored: false, bestError };
}

export function normalizeReconciliationResponse(
	response: unknown,
	existing: ProjectMemory,
	candidates: PreparedReconciliationCandidates,
): NormalizedReconciliationPlan | ReconciliationValidationError {
	const expectedRefs = allCandidateRefs(candidates);
	const allCount = expectedRefs.size;

	try {
		const root = asRecord(response);
		const expectedCategories = ["lessons", "preferences", "decisions", "domain"];
		if (!hasOnlyKeys(root, expectedCategories)) {
			const keys = Object.keys(root);
			const extra = keys.filter((k) => !expectedCategories.includes(k));
			throw new ReconciliationValidationError("extra keys", allCount, `extra root keys: ${extra.join(", ")}`);
		}
		if (!Array.isArray(root.lessons)) {
			throw new ReconciliationValidationError("coverage mismatch", allCount, "root.lessons is not an array");
		}
		if (!Array.isArray(root.preferences)) {
			throw new ReconciliationValidationError("coverage mismatch", allCount, "root.preferences is not an array");
		}
		if (!Array.isArray(root.decisions)) {
			throw new ReconciliationValidationError("coverage mismatch", allCount, "root.decisions is not an array");
		}
		if (!Array.isArray(root.domain)) {
			throw new ReconciliationValidationError("coverage mismatch", allCount, "root.domain is not an array");
		}

		const existingIds: ExistingRecordIds = {
			lessons: new Set(existing.lessons.map((record) => record.id)),
			preferences: new Set(existing.preferences.map((record) => record.id)),
			decisions: new Set(existing.decisions.map((record) => record.id)),
			domain: new Set(existing.domain.map((record) => record.id)),
		};
		const seenRefs = new Set<string>();

		const lessons = normalizeLessonActions(root.lessons, candidateRefSet(candidates.lessons), existingIds.lessons, seenRefs);
		const preferences = normalizePreferenceActions(root.preferences, candidateRefSet(candidates.preferences), existingIds.preferences, seenRefs);
		const decisions = normalizeSummaryDetailActions(root.decisions, candidateRefSet(candidates.decisions), existingIds.decisions, seenRefs);
		const domain = normalizeSummaryDetailActions(root.domain, candidateRefSet(candidates.domain), existingIds.domain, seenRefs);

		if (!setsEqual(seenRefs, expectedRefs)) {
			const uncovered = [...expectedRefs].filter((ref) => !seenRefs.has(ref));
			const extra = [...seenRefs].filter((ref) => !expectedRefs.has(ref));
			const totalMismatch = uncovered.length + extra.length;
			let details = "";
			if (uncovered.length > 0) details += `missing candidate refs: ${uncovered.join(", ")}. `;
			if (extra.length > 0) details += `unexpected candidate refs: ${extra.join(", ")}.`;
			throw new ReconciliationValidationError("coverage mismatch", totalMismatch, details.trim(), [...uncovered, ...extra]);
		}

		return { lessons, preferences, decisions, domain };
	} catch (error) {
		if (error instanceof ReconciliationValidationError) {
			return error;
		}
		throw error;
	}
}

export function normalizeReconciliationResponsePartial(
	response: unknown,
	existing: ProjectMemory,
	candidates: PreparedReconciliationCandidates,
): { plan: NormalizedReconciliationPlan; appliedRefs: Set<string> } {
	const root = asRecord(response);
	const existingIds: ExistingRecordIds = {
		lessons: new Set(existing.lessons.map((record) => record.id)),
		preferences: new Set(existing.preferences.map((record) => record.id)),
		decisions: new Set(existing.decisions.map((record) => record.id)),
		domain: new Set(existing.domain.map((record) => record.id)),
	};
	const seenRefs = new Set<string>();

	const lessons = Array.isArray(root.lessons)
		? normalizeLessonActions(root.lessons, candidateRefSet(candidates.lessons), existingIds.lessons, seenRefs, true)
		: [];
	const preferences = Array.isArray(root.preferences)
		? normalizePreferenceActions(root.preferences, candidateRefSet(candidates.preferences), existingIds.preferences, seenRefs, true)
		: [];
	const decisions = Array.isArray(root.decisions)
		? normalizeSummaryDetailActions(root.decisions, candidateRefSet(candidates.decisions), existingIds.decisions, seenRefs, true)
		: [];
	const domain = Array.isArray(root.domain)
		? normalizeSummaryDetailActions(root.domain, candidateRefSet(candidates.domain), existingIds.domain, seenRefs, true)
		: [];

	return {
		plan: { lessons, preferences, decisions, domain },
		appliedRefs: seenRefs,
	};
}

export function prepareStagingCandidates(stagingFiles: StagingFile[]): PreparedReconciliationCandidates {
	const prepared: PreparedReconciliationCandidates = {
		lessons: [],
		preferences: [],
		decisions: [],
		domain: [],
	};

	for (const staging of [...stagingFiles].sort(compareStagingFiles)) {
		prepared.lessons.push(...prepareCategory(staging, "lessons", staging.candidates.lessons ?? []));
		prepared.preferences.push(...prepareCategory(staging, "preferences", staging.candidates.preferences ?? []));
		prepared.decisions.push(...prepareCategory(staging, "decisions", staging.candidates.decisions ?? []));
		prepared.domain.push(...prepareCategory(staging, "domain", staging.candidates.domain ?? []));
	}

	return prepared;
}

function emptyRunCounts(): ReconciliationRunCounts {
	return {
		stagingFiles: { total: 0, valid: 0, malformed: 0, wrongProject: 0, deadLettered: 0, consumed: 0, preserved: 0 },
		candidates: {
			staged: { ...EMPTY_TOTALS },
			exactDuplicates: { ...EMPTY_TOTALS },
			remainingForModel: { ...EMPTY_TOTALS },
			deadLettered: { ...EMPTY_TOTALS },
		},
		actions: {
			add: { ...EMPTY_TOTALS },
			merge: { ...EMPTY_TOTALS },
			supersede: 0,
			discard: { ...EMPTY_TOTALS },
		},
		writes: { lessons: false, preferences: false, decisions: false, domain: false },
	};
}

export function loadValidSameProjectStaging(filePaths: string[], projectRoot: string, projectMemoryDir: string): {
	valid: LoadedStagingFile[];
	deadLettered: string[];
	deadLetteredCandidates: CategoryTotals;
	wrongProject: string[];
} {
	const valid: LoadedStagingFile[] = [];
	const deadLettered: string[] = [];
	const deadLetteredCandidates: CategoryTotals = { ...EMPTY_TOTALS };
	const wrongProject: string[] = [];

	for (const filePath of filePaths) {
		const raw = readRawStaging(filePath);
		let data = normalizeStagingFile(raw);
		if (!data) {
			const repaired = repairStagingFile(raw);
			data = normalizeStagingFile(repaired);
			if (data) writeStaging(filePath, data);
		}
		if (!data) {
			const rawProjectRoot = requireString(asRecord(raw).project_root);
			if (rawProjectRoot && !sameProjectRoot(rawProjectRoot, projectRoot)) {
				wrongProject.push(filePath);
				continue;
			}
			for (const deadLetter of malformedStagingDeadLetters(raw, filePath)) {
				writeDeadLetter(projectMemoryDir, deadLetter);
				deadLetteredCandidates[deadLetter.category] += 1;
			}
			deleteStaging(filePath);
			deadLettered.push(filePath);
			continue;
		}
		if (!sameProjectRoot(data.project_root, projectRoot)) {
			wrongProject.push(filePath);
			continue;
		}
		valid.push({ filePath, data });
	}

	return { valid, deadLettered, deadLetteredCandidates, wrongProject };
}

function readRawStaging(filePath: string): unknown {
	const text = fs.readFileSync(filePath, "utf-8");
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function malformedStagingDeadLetters(raw: unknown, filePath: string): DeadLetteredCandidate[] {
	const root = asRecord(raw);
	const session_id = requireString(root.session_id) ?? `malformed-${path.basename(filePath, ".json")}`;
	const produced_at = requireTimestamp(root.produced_at) ?? new Date(0).toISOString();
	const last_gate_reason = "malformed staging file";
	const categories: ReconciliationCategory[] = ["lessons", "preferences", "decisions", "domain"];
	const candidates = asRecord(root.candidates);
	const extracted: DeadLetteredCandidate[] = [];
	for (const category of categories) {
		const values = candidates[category];
		if (!Array.isArray(values)) continue;
		for (const candidate of values) {
			const attemptValue = asRecord(candidate).reconcile_attempts;
			extracted.push({
				session_id,
				produced_at,
				attempts: typeof attemptValue === "number" && Number.isFinite(attemptValue) ? attemptValue : 0,
				last_gate_reason,
				category,
				candidate: { candidate, original_staging_file: raw },
			});
		}
	}
	return extracted.length > 0
		? extracted
		: [{ session_id, produced_at, attempts: 0, last_gate_reason, category: "lessons", candidate: raw }];
}

export function normalizeStagingFile(raw: unknown): StagingFile | null {
	const root = asRecord(raw);
	if (root.schemaVersion !== 1) return null;
	const sessionId = requireString(root.session_id);
	const producedAt = requireTimestamp(root.produced_at);
	const projectRoot = requireString(root.project_root);
	if (!sessionId || !producedAt || !projectRoot) return null;
	const candidates = normalizeExtractionResult({ candidates: root.candidates });
	if (!candidates) return null;
	return {
		schemaVersion: 1,
		session_id: sessionId,
		produced_at: producedAt,
		project_root: projectRoot,
		candidates,
	};
}

function sameProjectRoot(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

function readProjectMemory(projectMemoryDir: string): ProjectMemory {
	return {
		lessons: parseLessonsFile(path.join(projectMemoryDir, "lessons.md")),
		preferences: parsePreferencesFile(path.join(projectMemoryDir, "preferences.md")),
		decisions: parseDecisionsFile(path.join(projectMemoryDir, "decisions.md")),
		domain: parseDomainFile(path.join(projectMemoryDir, "domain.md")),
	};
}

function projectScopeFromRoot(projectRoot: string): string {
	const basename = path.basename(projectRoot);
	return basename.startsWith(".") ? basename.slice(1) : basename;
}

function rebuildIndexOrThrow(deps: ReconciliationDeps, db: SqliteDatabase, memoryPaths: MemoryPaths): true {
	(deps.rebuildIndex ?? rebuildSqliteIndex)(db, memoryPaths);
	return true;
}

function candidateTotals(candidates: PreparedReconciliationCandidates): CategoryTotals {
	return {
		lessons: candidates.lessons.length,
		preferences: candidates.preferences.length,
		decisions: candidates.decisions.length,
		domain: candidates.domain.length,
	};
}

function exactTotals(result: MemoryPreFilterResult): CategoryTotals {
	return {
		lessons: result.lessons.bypassed.length,
		preferences: result.preferences.bypassed.length,
		decisions: result.decisions.bypassed.length,
		domain: result.domain.bypassed.length,
	};
}

function actionTotals(plan: NormalizedReconciliationPlan): ReconciliationRunCounts["actions"] {
	const totals: ReconciliationRunCounts["actions"] = {
		add: { ...EMPTY_TOTALS },
		merge: { ...EMPTY_TOTALS },
		supersede: 0,
		discard: { ...EMPTY_TOTALS },
	};
	for (const action of plan.lessons) {
		if (action.action === "supersede") totals.supersede += 1;
		else totals[action.action].lessons += 1;
	}
	for (const action of plan.preferences) totals[action.action].preferences += 1;
	for (const action of plan.decisions) totals[action.action].decisions += 1;
	for (const action of plan.domain) totals[action.action].domain += 1;
	return totals;
}

function emptyPlan(): NormalizedReconciliationPlan {
	return { lessons: [], preferences: [], decisions: [], domain: [] };
}

function mergePlans(a: NormalizedReconciliationPlan, b: NormalizedReconciliationPlan): NormalizedReconciliationPlan {
	return {
		lessons: [...a.lessons, ...b.lessons],
		preferences: [...a.preferences, ...b.preferences],
		decisions: [...a.decisions, ...b.decisions],
		domain: [...a.domain, ...b.domain],
	};
}

function mergeWrites(
	a: ReconciliationRunCounts["writes"],
	b: ReconciliationRunCounts["writes"],
): ReconciliationRunCounts["writes"] {
	return {
		lessons: a.lessons || b.lessons,
		preferences: a.preferences || b.preferences,
		decisions: a.decisions || b.decisions,
		domain: a.domain || b.domain,
	};
}

function totalCandidates(candidates: PreparedReconciliationCandidates): number {
	return candidates.lessons.length + candidates.preferences.length + candidates.decisions.length + candidates.domain.length;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (value === Number.POSITIVE_INFINITY) return value;
	if (!Number.isFinite(value) || value === undefined) return fallback;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}

function chunkCandidates(candidates: PreparedReconciliationCandidates, chunkSize: number): PreparedReconciliationCandidates[] {
	const flat = flattenCandidates(candidates);
	const chunks: PreparedReconciliationCandidates[] = [];
	for (let i = 0; i < flat.length; i += chunkSize) {
		const chunk = emptyPreparedCandidates();
		for (const candidate of flat.slice(i, i + chunkSize)) {
			chunk[candidate.category].push(candidate as never);
		}
		chunks.push(chunk);
	}
	return chunks;
}

function flattenCandidates(candidates: PreparedReconciliationCandidates): ReconciliationCandidate<LessonCandidate | PreferenceCandidate | DecisionCandidate | DomainCandidate>[] {
	const categoryOrder: Record<ReconciliationCategory, number> = { lessons: 0, preferences: 1, decisions: 2, domain: 3 };
	return [
		...candidates.lessons,
		...candidates.preferences,
		...candidates.decisions,
		...candidates.domain,
	].sort((a, b) =>
		a.produced_at.localeCompare(b.produced_at) ||
		a.session_id.localeCompare(b.session_id) ||
		categoryOrder[a.category] - categoryOrder[b.category] ||
		a.index - b.index
	);
}

function emptyPreparedCandidates(): PreparedReconciliationCandidates {
	return { lessons: [], preferences: [], decisions: [], domain: [] };
}

function preFilterForChunk(
	preFilter: MemoryPreFilterResult,
	remaining: PreparedReconciliationCandidates,
	includeBypassed: boolean,
): MemoryPreFilterResult {
	const emptyBypassed = {
		lessons: { bypassed: [], remaining: [], reinforcementBumps: [] },
		preferences: { bypassed: [], remaining: [] },
		decisions: { bypassed: [], remaining: [] },
		domain: { bypassed: [], remaining: [] },
	};
	return {
		lessons: includeBypassed ? preFilter.lessons : emptyBypassed.lessons,
		preferences: includeBypassed ? preFilter.preferences : emptyBypassed.preferences,
		decisions: includeBypassed ? preFilter.decisions : emptyBypassed.decisions,
		domain: includeBypassed ? preFilter.domain : emptyBypassed.domain,
		remaining,
		llmNeeded: totalCandidates(remaining) > 0,
	};
}

function materializeReconciliation(
	existing: ProjectMemory,
	preFilter: MemoryPreFilterResult,
	plan: NormalizedReconciliationPlan,
	projectScope: string,
	nowIso: string,
): ProjectMemory {
	const refIndex = candidateRefIndex(preFilter.remaining);
	const lessons = applyLessonActions(
		cloneLessons(applyLessonReinforcementBumps(existing.lessons, preFilter.lessons.reinforcementBumps, nowIso)),
		plan.lessons,
		refIndex,
		projectScope,
		nowIso,
	);
	const preferences = applyPreferenceActions(clonePreferences(existing.preferences), plan.preferences, refIndex, projectScope);
	const decisions = applySummaryDetailActions(cloneDecisions(existing.decisions), "dec", plan.decisions, refIndex, projectScope);
	const domain = applySummaryDetailActions(cloneDomainFacts(existing.domain), "dom", plan.domain, refIndex, projectScope);
	return { lessons, preferences, decisions, domain };
}

function applyLessonActions(
	lessons: Lesson[],
	actions: LessonAction[],
	refIndex: CandidateRefIndex,
	projectScope: string,
	nowIso: string,
): Lesson[] {
	const nextId = nextIdFactory("lsn", lessons);
	for (const action of actions) {
		if (action.action === "discard") continue;
		const contribution = contributionForRefs(action.candidate_refs, refIndex);
		if (action.action === "add") {
			lessons.push({
				id: nextId(),
				summary: action.summary,
				detail: action.detail,
				meta: {
					project_scope: projectScope,
					status: "active",
					session_level: false,
					reinforcement_count: Math.max(1, action.candidate_refs.length),
					last_seen_at: action.candidate_refs.length > 1 ? nowIso : null,
					source_session: contribution.source_session,
					created_at: contribution.created_at,
					supersedes: null,
					triggers: cloneTriggers(action.triggers),
				},
			});
			continue;
		}

		const target = lessons.find((lesson) => lesson.id === action.target_id);
		if (!target) throw new Error(`Missing lesson target ${action.target_id}`);
		if (action.action === "merge") {
			target.summary = action.summary;
			target.detail = action.detail;
			target.meta.triggers = cloneTriggers(action.triggers);
			target.meta.reinforcement_count += action.candidate_refs.length;
			target.meta.last_seen_at = nowIso;
			continue;
		}

		target.meta.status = "superseded";
		target.meta.last_seen_at = nowIso;
		lessons.push({
			id: nextId(),
			summary: action.summary,
			detail: action.detail,
			meta: {
				project_scope: projectScope,
				status: "active",
				session_level: false,
				reinforcement_count: Math.max(1, action.candidate_refs.length),
				last_seen_at: action.candidate_refs.length > 1 ? nowIso : null,
				source_session: contribution.source_session,
				created_at: contribution.created_at,
				supersedes: action.target_id,
				triggers: cloneTriggers(action.triggers),
			},
		});
	}
	return lessons;
}

function applyPreferenceActions(
	preferences: Preference[],
	actions: PreferenceAction[],
	refIndex: CandidateRefIndex,
	projectScope: string,
): Preference[] {
	const nextId = nextIdFactory("prf", preferences);
	for (const action of actions) {
		if (action.action === "discard") continue;
		if (action.action === "add") {
			const contribution = contributionForRefs(action.candidate_refs, refIndex);
			preferences.push({
				id: nextId(),
				text: action.text,
				scope: projectScope,
				source_session: contribution.source_session,
				created_at: contribution.created_at,
			});
			continue;
		}
		const target = preferences.find((preference) => preference.id === action.target_id);
		if (!target) throw new Error(`Missing preference target ${action.target_id}`);
		target.text = action.text;
	}
	return preferences;
}

function applySummaryDetailActions<T extends Decision | DomainFact>(
	records: T[],
	prefix: "dec" | "dom",
	actions: SummaryDetailAction[],
	refIndex: CandidateRefIndex,
	projectScope: string,
): T[] {
	const nextId = nextIdFactory(prefix, records);
	for (const action of actions) {
		if (action.action === "discard") continue;
		if (action.action === "add") {
			const contribution = contributionForRefs(action.candidate_refs, refIndex);
			records.push({
				id: nextId(),
				summary: action.summary,
				detail: action.detail,
				scope: projectScope,
				source_session: contribution.source_session,
				created_at: contribution.created_at,
			} as T);
			continue;
		}
		const target = records.find((record) => record.id === action.target_id);
		if (!target) throw new Error(`Missing ${prefix} target ${action.target_id}`);
		target.summary = action.summary;
		target.detail = action.detail;
	}
	return records;
}

function writeChangedProjectMemory(projectMemoryDir: string, before: ProjectMemory, after: ProjectMemory): ReconciliationRunCounts["writes"] {
	const writes = { lessons: false, preferences: false, decisions: false, domain: false };
	if (!sameJson(before.lessons, after.lessons)) {
		rewriteLessonsFile(path.join(projectMemoryDir, "lessons.md"), after.lessons);
		writes.lessons = true;
	}
	if (!sameJson(before.preferences, after.preferences)) {
		rewritePreferencesFile(path.join(projectMemoryDir, "preferences.md"), after.preferences);
		writes.preferences = true;
	}
	if (!sameJson(before.decisions, after.decisions)) {
		rewriteDecisionsFile(path.join(projectMemoryDir, "decisions.md"), after.decisions);
		writes.decisions = true;
	}
	if (!sameJson(before.domain, after.domain)) {
		rewriteDomainFile(path.join(projectMemoryDir, "domain.md"), after.domain);
		writes.domain = true;
	}
	return writes;
}

function getActionRefsCount(action: Record<string, unknown>): number {
	if (Array.isArray(action.candidate_refs)) {
		return action.candidate_refs.length;
	}
	return 1;
}

function normalizeLessonActions(
	rawActions: unknown[],
	validRefs: Set<string>,
	existingIds: Set<string>,
	seenRefs: Set<string>,
	isPartial = false,
): LessonAction[] {
	const actions: LessonAction[] = [];
	for (const rawAction of rawActions) {
		try {
			const action = asRecord(rawAction);
			const actionType = action.action;
			const rawRefs = Array.isArray(action.candidate_refs)
				? action.candidate_refs.filter((r): r is string => typeof r === "string")
				: [];
			if (actionType === "discard") {
				if (!hasOnlyKeys(action, ["action", "candidate_refs", "reason"])) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !["action", "candidate_refs", "reason"].includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`discard action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const reason = requireString(action.reason);
				if (!reason) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						"discard action missing or invalid reason string",
						refs
					);
				}
				for (const ref of refs) seenRefs.add(ref);
				actions.push({ action: "discard", candidate_refs: refs, reason });
				continue;
			}
			if (actionType === "add" || actionType === "merge" || actionType === "supersede") {
				const allowed = actionType === "add"
					? ["action", "candidate_refs", "summary", "detail", "triggers"]
					: ["action", "candidate_refs", "target_id", "summary", "detail", "triggers"];
				if (!hasOnlyKeys(action, allowed)) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !allowed.includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`${actionType} action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const summary = requireString(action.summary);
				const detail = requireString(action.detail);
				const triggers = normalizeTriggers(action.triggers, refs);
				if (!summary || !detail) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						`${actionType} action missing or invalid summary/detail`,
						refs
					);
				}
				if (actionType === "add") {
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: "add", candidate_refs: refs, summary, detail, triggers });
				} else {
					const targetId = requireString(action.target_id);
					if (!targetId || !existingIds.has(targetId)) {
						throw new ReconciliationValidationError(
							"unknown target_id",
							refs.length,
							`unknown target_id: '${targetId}' for action ${actionType}`,
							refs
						);
					}
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: actionType, candidate_refs: refs, target_id: targetId, summary, detail, triggers });
				}
				continue;
			}
			throw new ReconciliationValidationError(
				"extra keys",
				getActionRefsCount(action),
				`unknown action type: '${actionType}'`,
				rawRefs
			);
		} catch (error) {
			if (isPartial && error instanceof ReconciliationValidationError) {
				console.warn(`[persistent-memory] skipping invalid action: ${error.message}`);
				continue;
			}
			throw error;
		}
	}
	return actions;
}

function normalizePreferenceActions(
	rawActions: unknown[],
	validRefs: Set<string>,
	existingIds: Set<string>,
	seenRefs: Set<string>,
	isPartial = false,
): PreferenceAction[] {
	const actions: PreferenceAction[] = [];
	for (const rawAction of rawActions) {
		try {
			const action = asRecord(rawAction);
			const actionType = action.action;
			const rawRefs = Array.isArray(action.candidate_refs)
				? action.candidate_refs.filter((r): r is string => typeof r === "string")
				: [];
			if (actionType === "discard") {
				if (!hasOnlyKeys(action, ["action", "candidate_refs", "reason"])) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !["action", "candidate_refs", "reason"].includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`preference discard action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const reason = requireString(action.reason);
				if (!reason) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						"preference discard action missing or invalid reason string",
						refs
					);
				}
				for (const ref of refs) seenRefs.add(ref);
				actions.push({ action: "discard", candidate_refs: refs, reason });
				continue;
			}
			if (actionType === "add" || actionType === "merge") {
				const allowed = actionType === "add" ? ["action", "candidate_refs", "text"] : ["action", "candidate_refs", "target_id", "text"];
				if (!hasOnlyKeys(action, allowed)) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !allowed.includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`preference ${actionType} action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const text = requireString(action.text);
				if (!text) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						`preference ${actionType} action missing or invalid text`,
						refs
					);
				}
				if (actionType === "add") {
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: "add", candidate_refs: refs, text });
				} else {
					const targetId = requireString(action.target_id);
					if (!targetId || !existingIds.has(targetId)) {
						throw new ReconciliationValidationError(
							"unknown target_id",
							refs.length,
							`unknown target_id: '${targetId}' for action ${actionType}`,
							refs
						);
					}
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: "merge", candidate_refs: refs, target_id: targetId, text });
				}
				continue;
			}
			throw new ReconciliationValidationError(
				"extra keys",
				getActionRefsCount(action),
				`unknown preference action type: '${actionType}'`,
				rawRefs
			);
		} catch (error) {
			if (isPartial && error instanceof ReconciliationValidationError) {
				console.warn(`[persistent-memory] skipping invalid action: ${error.message}`);
				continue;
			}
			throw error;
		}
	}
	return actions;
}

function normalizeSummaryDetailActions(
	rawActions: unknown[],
	validRefs: Set<string>,
	existingIds: Set<string>,
	seenRefs: Set<string>,
	isPartial = false,
): SummaryDetailAction[] {
	const actions: SummaryDetailAction[] = [];
	for (const rawAction of rawActions) {
		try {
			const action = asRecord(rawAction);
			const actionType = action.action;
			const rawRefs = Array.isArray(action.candidate_refs)
				? action.candidate_refs.filter((r): r is string => typeof r === "string")
				: [];
			if (actionType === "discard") {
				if (!hasOnlyKeys(action, ["action", "candidate_refs", "reason"])) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !["action", "candidate_refs", "reason"].includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const reason = requireString(action.reason);
				if (!reason) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						"discard action missing or invalid reason string",
						refs
					);
				}
				for (const ref of refs) seenRefs.add(ref);
				actions.push({ action: "discard", candidate_refs: refs, reason });
				continue;
			}
			if (actionType === "add" || actionType === "merge") {
				const allowed = actionType === "add"
					? ["action", "candidate_refs", "summary", "detail"]
					: ["action", "candidate_refs", "target_id", "summary", "detail"];
				if (!hasOnlyKeys(action, allowed)) {
					const keys = Object.keys(action);
					const extra = keys.filter((k) => !allowed.includes(k));
					throw new ReconciliationValidationError(
						"extra keys",
						getActionRefsCount(action),
						`${actionType} action has extra keys: ${extra.join(", ")}`,
						rawRefs
					);
				}
				const refs = normalizeCandidateRefs(action.candidate_refs, validRefs, seenRefs);
				const summary = requireString(action.summary);
				const detail = requireString(action.detail);
				if (!summary || !detail) {
					throw new ReconciliationValidationError(
						"extra keys",
						refs.length,
						`${actionType} action missing or invalid summary/detail`,
						refs
					);
				}
				if (actionType === "add") {
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: "add", candidate_refs: refs, summary, detail });
				} else {
					const targetId = requireString(action.target_id);
					if (!targetId || !existingIds.has(targetId)) {
						throw new ReconciliationValidationError(
							"unknown target_id",
							refs.length,
							`unknown target_id: '${targetId}' for action ${actionType}`,
							refs
						);
					}
					for (const ref of refs) seenRefs.add(ref);
					actions.push({ action: "merge", candidate_refs: refs, target_id: targetId, summary, detail });
				}
				continue;
			}
			throw new ReconciliationValidationError(
				"extra keys",
				getActionRefsCount(action),
				`unknown action type: '${actionType}'`,
				rawRefs
			);
		} catch (error) {
			if (isPartial && error instanceof ReconciliationValidationError) {
				console.warn(`[persistent-memory] skipping invalid action: ${error.message}`);
				continue;
			}
			throw error;
		}
	}
	return actions;
}

function normalizeCandidateRefs(raw: unknown, validRefs: Set<string>, seenRefs: Set<string>): string[] {
	if (!Array.isArray(raw)) {
		throw new ReconciliationValidationError(
			"coverage mismatch",
			1,
			"candidate_refs must be an array",
			[]
		);
	}
	if (raw.length === 0) {
		throw new ReconciliationValidationError(
			"coverage mismatch",
			0,
			"candidate_refs cannot be empty",
			[]
		);
	}
	const refs: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") {
			throw new ReconciliationValidationError(
				"coverage mismatch",
				raw.length,
				"candidate_refs contains non-string value",
				raw.filter((r): r is string => typeof r === "string")
			);
		}
		if (!validRefs.has(value)) {
			throw new ReconciliationValidationError(
				"coverage mismatch",
				raw.length,
				`candidate_refs contains unknown/invalid ref: '${value}'`,
				[value]
			);
		}
		if (seenRefs.has(value)) {
			throw new ReconciliationValidationError(
				"coverage mismatch",
				raw.length,
				`candidate_refs contains already processed ref: '${value}'`,
				[value]
			);
		}
		if (refs.includes(value)) {
			throw new ReconciliationValidationError(
				"coverage mismatch",
				raw.length,
				`candidate_refs contains duplicate ref within same action: '${value}'`,
				[value]
			);
		}
		refs.push(value);
	}
	return refs;
}

function allCandidateRefs(candidates: PreparedReconciliationCandidates): Set<string> {
	return new Set([
		...candidates.lessons.map((candidate) => candidate.ref),
		...candidates.preferences.map((candidate) => candidate.ref),
		...candidates.decisions.map((candidate) => candidate.ref),
		...candidates.domain.map((candidate) => candidate.ref),
	]);
}

function candidateRefSet<T>(candidates: ReconciliationCandidate<T>[]): Set<string> {
	return new Set(candidates.map((candidate) => candidate.ref));
}

function candidateRefIndex(candidates: PreparedReconciliationCandidates): CandidateRefIndex {
	const index: CandidateRefIndex = new Map();
	for (const candidate of [...candidates.lessons, ...candidates.preferences, ...candidates.decisions, ...candidates.domain]) {
		index.set(candidate.ref, candidate);
	}
	return index;
}

function contributionForRefs(refs: string[], refIndex: CandidateRefIndex): { source_session: string; created_at: string } {
	const contributors = refs
		.map((ref) => refIndex.get(ref))
		.filter((candidate): candidate is ReconciliationCandidate<LessonCandidate | PreferenceCandidate | DecisionCandidate | DomainCandidate> => !!candidate)
		.sort((a, b) => normalizeTimestamp(a.produced_at).localeCompare(normalizeTimestamp(b.produced_at)) || a.session_id.localeCompare(b.session_id));
	const earliest = contributors[0];
	if (!earliest) throw new Error("Missing contributor for candidate refs.");
	return { source_session: earliest.session_id, created_at: normalizeTimestamp(earliest.produced_at) };
}

function nextIdFactory(prefix: string, records: Array<{ id: string }>): () => string {
	const used = new Set(records.map((record) => record.id));
	let max = 0;
	let width = 2;
	const regex = new RegExp(`^${prefix}_(\\d+)$`);
	for (const id of used) {
		const match = regex.exec(id);
		if (!match) continue;
		max = Math.max(max, Number(match[1]));
		width = Math.max(width, match[1]!.length);
	}
	return () => {
		let id: string;
		do {
			max += 1;
			id = `${prefix}_${String(max).padStart(width, "0")}`;
		} while (used.has(id));
		used.add(id);
		return id;
	};
}

function cloneLessons(lessons: Lesson[]): Lesson[] {
	return lessons.map((lesson) => ({ ...lesson, meta: { ...lesson.meta, triggers: cloneTriggers(lesson.meta.triggers) } }));
}

function clonePreferences(preferences: Preference[]): Preference[] {
	return preferences.map((preference) => ({ ...preference }));
}

function cloneDecisions(decisions: Decision[]): Decision[] {
	return decisions.map((decision) => ({ ...decision }));
}

function cloneDomainFacts(domainFacts: DomainFact[]): DomainFact[] {
	return domainFacts.map((domainFact) => ({ ...domainFact }));
}

function cloneTriggers(triggers: Trigger[]): Trigger[] {
	return triggers.map((trigger) => ({ ...trigger }));
}

function normalizeTriggers(raw: unknown, actionRefs: string[]): Trigger[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new ReconciliationValidationError(
			"missing trigger",
			actionRefs.length,
			"triggers must be a non-empty array",
			actionRefs
		);
	}
	const triggers: Trigger[] = [];
	for (const item of raw) {
		const trigger = normalizeTrigger(item);
		if (!trigger) {
			throw new ReconciliationValidationError(
				"missing trigger",
				actionRefs.length,
				`invalid or malformed trigger: ${JSON.stringify(item)}`,
				actionRefs
			);
		}
		triggers.push(trigger);
	}
	return triggers;
}

function normalizeTrigger(raw: unknown): Trigger | null {
	const trigger = asRecord(raw);
	if (trigger.type === "path" || trigger.type === "filename" || trigger.type === "topic") {
		const value = requireString(trigger.value);
		return value ? { type: trigger.type, value } : null;
	}
	if (trigger.type === "tool") {
		const value = requireString(trigger.value);
		if (!value) return null;
		if (trigger.pattern !== undefined && typeof trigger.pattern !== "string") return null;
		const pattern = typeof trigger.pattern === "string" ? trigger.pattern.trim() : "";
		return pattern ? { type: "tool", value, pattern } : { type: "tool", value };
	}
	if (trigger.type === "command") {
		const pattern = requireString(trigger.pattern);
		return pattern ? { type: "command", pattern } : null;
	}
	return null;
}

function requireString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function requireTimestamp(value: unknown): string | null {
	const text = requireString(value);
	if (!text) return null;
	const timestamp = Date.parse(text);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Split remaining candidates by shortlist collision detection.
 *  Candidates with an empty shortlist (no plausible collision) go to deterministic;
 *  candidates with a non-empty shortlist go to collision for model adjudication. */
export function splitByShortlist(
	remaining: PreparedReconciliationCandidates,
	existing: ProjectMemory,
	projectScope: string,
): DeterministicAddSplit {
	const deterministic = emptyPreparedCandidates();
	const collision = emptyPreparedCandidates();

	for (const candidate of remaining.lessons) {
		const sc: ShortlistCandidate = {
			type: "lesson",
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
			scope_suggestion: candidate.candidate.scope_suggestion,
			triggers: candidate.candidate.triggers,
		};
		const results = shortlist(sc, existing.lessons as ShortlistRecord[]);
		(results.length === 0 ? deterministic : collision).lessons.push(candidate);
	}

	for (const candidate of remaining.preferences) {
		const sc: ShortlistCandidate = {
			type: "preference",
			text: candidate.candidate.text,
			scope: projectScope,
		};
		const results = shortlist(sc, existing.preferences as ShortlistRecord[]);
		(results.length === 0 ? deterministic : collision).preferences.push(candidate);
	}

	for (const candidate of remaining.decisions) {
		const sc: ShortlistCandidate = {
			type: "decision",
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
			scope: projectScope,
		};
		const results = shortlist(sc, existing.decisions as ShortlistRecord[]);
		(results.length === 0 ? deterministic : collision).decisions.push(candidate);
	}

	for (const candidate of remaining.domain) {
		const sc: ShortlistCandidate = {
			type: "domain",
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
			scope: projectScope,
		};
		const results = shortlist(sc, existing.domain as ShortlistRecord[]);
		(results.length === 0 ? deterministic : collision).domain.push(candidate);
	}

	return { deterministic, collision };
}

/** Build a reconciliation plan of ADD actions for deterministic (no-collision) candidates.
 *  Every candidate gets its own ADD action with host-owned ids/timestamps/scopes/triggers. */
export function buildDeterministicPlan(candidates: PreparedReconciliationCandidates): NormalizedReconciliationPlan {
	const plan = emptyPlan();

	for (const candidate of candidates.lessons) {
		plan.lessons.push({
			action: "add",
			candidate_refs: [candidate.ref],
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
			triggers: cloneTriggers(candidate.candidate.triggers),
		});
	}

	for (const candidate of candidates.preferences) {
		plan.preferences.push({
			action: "add",
			candidate_refs: [candidate.ref],
			text: candidate.candidate.text,
		});
	}

	for (const candidate of candidates.decisions) {
		plan.decisions.push({
			action: "add",
			candidate_refs: [candidate.ref],
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
		});
	}

	for (const candidate of candidates.domain) {
		plan.domain.push({
			action: "add",
			candidate_refs: [candidate.ref],
			summary: candidate.candidate.summary,
			detail: candidate.candidate.detail,
		});
	}

	return plan;
}

/** Returns records from `next` that are either new (not in `prev`) or changed.
 *  Uses id-based matching and sameJson to detect changes across all categories. */
function recordsToUpsert<T extends { id: string }>(prev: T[], next: T[]): T[] {
	const prevMap = new Map(prev.map((r) => [r.id, r]));
	const result: T[] = [];
	for (const record of next) {
		const prevRecord = prevMap.get(record.id);
		if (!prevRecord || !sameJson(prevRecord, record)) {
			result.push(record);
		}
	}
	return result;
}

/** Returns true when the database handle exposes a .prepare method (real sqlite).
 *  Stub objects in unit tests typically lack it and should skip incremental writes. */
function isSqliteLike(db: SqliteDatabase): boolean {
	return typeof (db as { prepare?: unknown }).prepare === "function";
}

/** Write any new or changed records from `after` (vs `before`) into the sqlite index
 *  using the existing INSERT OR REPLACE helpers.  Handles all four categories. */
function upsertChangedProjectMemoryToSqlite(
	db: SqliteDatabase,
	memDir: string,
	before: ProjectMemory,
	after: ProjectMemory,
): void {
	const changedLessons = recordsToUpsert(before.lessons, after.lessons);
	const changedPreferences = recordsToUpsert(before.preferences, after.preferences);
	const changedDecisions = recordsToUpsert(before.decisions, after.decisions);
	const changedDomain = recordsToUpsert(before.domain, after.domain);

	if (changedLessons.length > 0) insertLessons(db, path.join(memDir, "lessons.md"), changedLessons);
	if (changedPreferences.length > 0) insertPreferences(db, path.join(memDir, "preferences.md"), changedPreferences);
	if (changedDecisions.length > 0) insertDecisions(db, path.join(memDir, "decisions.md"), changedDecisions);
	if (changedDomain.length > 0) insertDomainFacts(db, path.join(memDir, "domain.md"), changedDomain);
}

export function preFilterMemoryCandidates(input: MemoryPreFilterInput): MemoryPreFilterResult {
	const lessons = preFilterLessons(input.candidates.lessons, input.existing.lessons);
	const preferences = preFilterPreferences(input.candidates.preferences, input.existing.preferences, input.projectScope);
	const decisions = preFilterDecisions(input.candidates.decisions, input.existing.decisions, input.projectScope);
	const domain = preFilterDomainFacts(input.candidates.domain, input.existing.domain, input.projectScope);
	const remaining: PreparedReconciliationCandidates = {
		lessons: lessons.remaining,
		preferences: preferences.remaining,
		decisions: decisions.remaining,
		domain: domain.remaining,
	};

	return {
		lessons,
		preferences,
		decisions,
		domain,
		remaining,
		llmNeeded: hasRemainingCandidates(remaining),
	};
}

export function preFilterLessons(
	candidates: ReconciliationCandidate<LessonCandidate>[],
	existing: Lesson[],
): LessonPreFilterResult {
	const bypassed: LessonBypass[] = [];
	const remaining: ReconciliationCandidate<LessonCandidate>[] = [];
	const bumpCounts = new Map<string, number>();

	for (const candidate of candidates) {
		const match = existing.find((lesson) => isExactLessonMatch(candidate.candidate, lesson));
		if (!match) {
			remaining.push(candidate);
			continue;
		}
		bypassed.push({ candidate, matchedExisting: match });
		bumpCounts.set(match.id, (bumpCounts.get(match.id) ?? 0) + 1);
	}

	return {
		bypassed,
		remaining,
		reinforcementBumps: [...bumpCounts.entries()].map(([target_id, count]) => ({ target_id, count })),
	};
}

export function applyLessonReinforcementBumps(
	existing: Lesson[],
	bumps: LessonReinforcementBump[],
	lastSeenAt: string,
): Lesson[] {
	if (bumps.length === 0) return existing;
	const bumpCounts = new Map(bumps.map((bump) => [bump.target_id, bump.count]));
	return existing.map((lesson) => {
		const count = bumpCounts.get(lesson.id) ?? 0;
		if (count === 0) return lesson;
		return {
			...lesson,
			meta: {
				...lesson.meta,
				reinforcement_count: lesson.meta.reinforcement_count + count,
				last_seen_at: lastSeenAt,
			},
		};
	});
}

export function preFilterPreferences(
	candidates: ReconciliationCandidate<PreferenceCandidate>[],
	existing: Preference[],
	projectScope: string,
): SimplePreFilterResult<PreferenceCandidate, Preference> {
	return preFilterSimple(candidates, existing, (candidate, preference) => isExactPreferenceMatch(candidate, preference, projectScope));
}

export function preFilterDecisions(
	candidates: ReconciliationCandidate<DecisionCandidate>[],
	existing: Decision[],
	projectScope: string,
): SimplePreFilterResult<DecisionCandidate, Decision> {
	return preFilterSimple(candidates, existing, (candidate, decision) => isExactDecisionMatch(candidate, decision, projectScope));
}

export function preFilterDomainFacts(
	candidates: ReconciliationCandidate<DomainCandidate>[],
	existing: DomainFact[],
	projectScope: string,
): SimplePreFilterResult<DomainCandidate, DomainFact> {
	return preFilterSimple(candidates, existing, (candidate, domainFact) => isExactDomainMatch(candidate, domainFact, projectScope));
}

export function isExactLessonMatch(candidate: LessonCandidate, existing: Lesson): boolean {
	if (existing.meta.status !== "active") return false;
	if (normalizeText(candidate.summary) !== normalizeText(existing.summary)) return false;
	if (normalizeText(candidate.detail) !== normalizeText(existing.detail)) return false;
	if (candidate.scope_suggestion !== existing.meta.project_scope) return false;
	return triggerSetsEqual(candidate.triggers, existing.meta.triggers);
}

export function isExactPreferenceMatch(candidate: PreferenceCandidate, existing: Preference, projectScope: string): boolean {
	return existing.scope === projectScope && normalizeText(candidate.text) === normalizeText(existing.text);
}

export function isExactDecisionMatch(candidate: DecisionCandidate, existing: Decision, projectScope: string): boolean {
	return (
		existing.scope === projectScope &&
		normalizeText(candidate.summary) === normalizeText(existing.summary) &&
		normalizeText(candidate.detail) === normalizeText(existing.detail)
	);
}

export function isExactDomainMatch(candidate: DomainCandidate, existing: DomainFact, projectScope: string): boolean {
	return (
		existing.scope === projectScope &&
		normalizeText(candidate.summary) === normalizeText(existing.summary) &&
		normalizeText(candidate.detail) === normalizeText(existing.detail)
	);
}

export function normalizeText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:]+$/u, "");
}

export function triggersEqual(a: Trigger, b: Trigger): boolean {
	if (a.type !== b.type) return false;
	switch (a.type) {
		case "path":
		case "filename":
		case "topic":
			return a.value === (b as typeof a).value;
		case "command":
			return a.pattern === (b as typeof a).pattern;
		case "tool":
			return a.value === (b as typeof a).value && (a.pattern ?? null) === ((b as typeof a).pattern ?? null);
	}
	return false;
}

export function triggerSetsEqual(a: Trigger[], b: Trigger[]): boolean {
	if (a.length !== b.length) return false;
	const unmatched = [...b];
	for (const trigger of a) {
		const index = unmatched.findIndex((existingTrigger) => triggersEqual(trigger, existingTrigger));
		if (index < 0) return false;
		unmatched.splice(index, 1);
	}
	return unmatched.length === 0;
}

export function hasRemainingCandidates(candidates: PreparedReconciliationCandidates): boolean {
	return candidates.lessons.length > 0 || candidates.preferences.length > 0 || candidates.decisions.length > 0 || candidates.domain.length > 0;
}

function preFilterSimple<TCandidate, TExisting>(
	candidates: ReconciliationCandidate<TCandidate>[],
	existing: TExisting[],
	isExactMatch: (candidate: TCandidate, existing: TExisting) => boolean,
): SimplePreFilterResult<TCandidate, TExisting> {
	const bypassed: ExactDupe<TCandidate, TExisting>[] = [];
	const remaining: ReconciliationCandidate<TCandidate>[] = [];

	for (const candidate of candidates) {
		const match = existing.find((record) => isExactMatch(candidate.candidate, record));
		if (match) bypassed.push({ candidate, matchedExisting: match });
		else remaining.push(candidate);
	}

	return { bypassed, remaining };
}

function prepareCategory<T>(
	staging: StagingFile,
	category: ReconciliationCategory,
	candidates: T[],
): ReconciliationCandidate<T>[] {
	return candidates.map((candidate, index) => ({
		ref: `${staging.session_id}:${category}:${index + 1}`,
		session_id: staging.session_id,
		produced_at: staging.produced_at,
		category,
		index: index + 1,
		candidate,
	}));
}

function compareStagingFiles(a: StagingFile, b: StagingFile): number {
	const producedDelta = normalizeTimestamp(a.produced_at).localeCompare(normalizeTimestamp(b.produced_at));
	if (producedDelta !== 0) return producedDelta;
	return a.session_id.localeCompare(b.session_id);
}

function normalizeTimestamp(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

// ---------------------------------------------------------------------------
// T6 — Batched adjudication helpers
// ---------------------------------------------------------------------------

const ADJUDICATION_SYSTEM_PROMPT = `You are a lesson reconciliation adjudicator. For each new lesson candidate below, compare it against the shortlisted existing lessons and decide the relationship.

Return a JSON object with a "verdicts" array containing one verdict object per candidate in the same order as listed.

Verdict options:
- {"verdict": "distinct"}: The candidate is a new, distinct lesson not represented by any existing lesson. Create it as a new active lesson.
- {"verdict": "duplicate"}: The candidate is essentially the same as the top shortlist entry. The existing lesson's reinforcement should be bumped.
- {"verdict": "supersedes"}: The candidate represents an improved version that should replace the top shortlist entry. The old lesson becomes superseded.
- {"verdict": "merge", "merged_text": "..."}: The candidate and the top shortlist entry should be merged into a new lesson. Provide the merged summary text.`;

/**
 * Build a batched adjudication prompt for lesson candidates with their shortlists.
 * The model must return verdicts in the same order as the candidates appear.
 */
export function buildAdjudicationPrompt(
	candidates: ReconciliationCandidate<LessonCandidate>[],
	shortlists: ShortlistRecord[][],
): string {
	const lines: string[] = [];
	lines.push(ADJUDICATION_SYSTEM_PROMPT);
	lines.push("");
	lines.push("CANDIDATES:");
	lines.push("");

	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const sl = shortlists[i] ?? [];

		lines.push(`Candidate ${i + 1}:`);
		lines.push(`  Summary: "${c.candidate.summary}"`);
		lines.push(`  Detail: "${c.candidate.detail}"`);
		lines.push(`  Scope: ${c.candidate.scope_suggestion}`);
		if (c.candidate.triggers.length > 0) {
			lines.push(`  Triggers: ${c.candidate.triggers.map((t) => {
				if (t.type === "command") return `${t.type}:${t.pattern}`;
				return `${t.type}:${t.value}`;
			}).join(", ")}`);
		}
		lines.push("  Shortlist:");
		if (sl.length === 0) {
			lines.push("    (none)");
		} else {
			for (const record of sl) {
				const r = record as Lesson;
				lines.push(`    - [${r.id}] "${r.summary}" (${r.meta.status}, r:${r.meta.reinforcement_count})`);
			}
		}
		lines.push("");
	}

	lines.push("Respond with ONLY a JSON object:");
	lines.push("{");
	lines.push('  "verdicts": [');
	for (let i = 0; i < candidates.length; i++) {
		const comma = i < candidates.length - 1 ? "," : "";
		lines.push(`    {"verdict": "..."}${comma}`);
	}
	lines.push("  ]");
	lines.push("}");

	return lines.join("\n");
}

/**
 * Map parsed adjudication verdicts onto NormalizedReconciliationPlan actions.
 *
 * Returns the plan, the set of applied refs, and any parked candidate refs
 * (verdicts that could not be mapped, e.g. missing shortlist target).
 *
 * Verdict routing for lessons:
 *  - distinct → add action (new active lesson from candidate)
 *  - duplicate → merge action (reinforce target, unchanged text)
 *  - supersedes → supersede action (target superseded, new record from candidate)
 *  - merge → supersede action (target superseded, new record with merged_text)
 */
export function mapVerdictsToPlan(
	verdicts: AdjudicationVerdict[],
	candidates: ReconciliationCandidate<LessonCandidate>[],
	shortlists: ShortlistRecord[][],
	existing: ProjectMemory,
	parkedItems: Array<{ index: number }> = [],
): { plan: NormalizedReconciliationPlan; appliedRefs: Set<string>; parkedRefs: Set<string> } {
	void existing;
	const plan = emptyPlan();
	const appliedRefs = new Set<string>();
	const parkedRefs = new Set<string>();
	const parkedIndexes = new Set(parkedItems.map((item) => item.index));
	let verdictIndex = 0;

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		if (parkedIndexes.has(i)) {
			parkedRefs.add(candidate.ref);
			continue;
		}
		const verdict = verdicts[verdictIndex++];
		if (!verdict) {
			parkedRefs.add(candidate.ref);
			continue;
		}

		const sl = shortlists[i] ?? [];
		const topTarget = sl[0] as Lesson | undefined;

		if (!topTarget && verdict.verdict !== "distinct") {
			// A non-distinct verdict requires a target but none exists.
			// Park this candidate — can't apply.
			parkedRefs.add(candidate.ref);
			continue;
		}

		switch (verdict.verdict) {
			case "distinct": {
				// New active lesson — deterministic add.
				plan.lessons.push({
					action: "add",
					candidate_refs: [candidate.ref],
					summary: candidate.candidate.summary,
					detail: candidate.candidate.detail,
					triggers: cloneTriggers(candidate.candidate.triggers),
				});
				appliedRefs.add(candidate.ref);
				break;
			}
			case "duplicate": {
				// Reinforce existing target — merge action with unchanged text.
				plan.lessons.push({
					action: "merge",
					candidate_refs: [candidate.ref],
					target_id: topTarget!.id,
					summary: topTarget!.summary,
					detail: topTarget!.detail,
					triggers: cloneTriggers(topTarget!.meta.triggers),
				});
				appliedRefs.add(candidate.ref);
				break;
			}
			case "supersedes": {
				// New active supersedes target.
				plan.lessons.push({
					action: "supersede",
					candidate_refs: [candidate.ref],
					target_id: topTarget!.id,
					summary: candidate.candidate.summary,
					detail: candidate.candidate.detail,
					triggers: cloneTriggers(candidate.candidate.triggers),
				});
				appliedRefs.add(candidate.ref);
				break;
			}
			case "merge": {
				// New merged record supersedes target.
				const mergedText = verdict.merged_text ?? candidate.candidate.summary;
				plan.lessons.push({
					action: "supersede",
					candidate_refs: [candidate.ref],
					target_id: topTarget!.id,
					summary: mergedText,
					detail: candidate.candidate.detail,
					triggers: cloneTriggers(candidate.candidate.triggers),
				});
				appliedRefs.add(candidate.ref);
				break;
			}
		}
	}

	return { plan, appliedRefs, parkedRefs };
}

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return fallback;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}
