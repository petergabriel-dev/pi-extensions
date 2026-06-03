import * as path from "node:path";
import { normalizeExtractionResult, parseModelJson } from "./extract.js";
import { buildReconciliationUserPrompt, RECONCILIATION_SYSTEM_PROMPT } from "./prompts.js";
import { deleteStaging, listStagingFiles, readStaging, writeStaging, writeDeadLetter, type DeadLetteredCandidate } from "./staging.js";
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
import { rebuildIndex as rebuildSqliteIndex, type SqliteDatabase } from "../storage/sqlite.js";
import type { Decision, DomainFact, Lesson, LessonCandidate, Preference, StagingFile, Trigger } from "../types.js";

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

		const loaded = loadValidSameProjectStaging(stagingFiles, memoryPaths.projectRoot);
		counts.stagingFiles.valid = loaded.valid.length;
		counts.stagingFiles.malformed = loaded.malformed.length;
		counts.stagingFiles.wrongProject = loaded.wrongProject.length;
		counts.stagingFiles.preserved = loaded.malformed.length + loaded.wrongProject.length;

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

		let plan = emptyPlan();
		let appliedRefs = new Set<string>();
		let attemptedRefs = new Set<string>();
		let bypassedRefsApplied = false;
		let bestError: ReconciliationValidationError | undefined = undefined;
		let terminalFailure: { reason: "model_error" | "parse_error" | "invalid_model_response"; error?: unknown } | undefined = undefined;
		if (preFilter.llmNeeded) {
			const chunkSize = normalizePositiveInteger(deps.chunkSize, totalCandidates(preFilter.remaining));
			const budgetMs = normalizePositiveInteger(deps.wallClockBudgetMs, Number.POSITIVE_INFINITY);
			const startedAtMs = deps.nowMs?.() ?? Date.now();
			let isFirstApply = true;
			const chunks = chunkCandidates(preFilter.remaining, chunkSize);

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
				} catch (error) {
					return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
				}

				if (isFirstApply) bypassedRefsApplied = true;
				projectMemory = readProjectMemory(memoryPaths.projectMemoryDir);
				plan = mergePlans(plan, reconcileResult.plan);
				for (const ref of reconcileResult.appliedRefs) appliedRefs.add(ref);
				isFirstApply = false;

				const elapsedMs = (deps.nowMs?.() ?? Date.now()) - startedAtMs;
				if (elapsedMs >= budgetMs || deps.shouldContinue?.() === false) break;
			}
		} else {
			// No LLM called, so all remaining candidates are considered applied/duplicate.
			const nowIso = (deps.now?.() ?? new Date()).toISOString();
			const nextMemory = materializeReconciliation(projectMemory, preFilter, plan, projectScope, nowIso);
			try {
				counts.writes = writeChangedProjectMemory(memoryPaths.projectMemoryDir, projectMemory, nextMemory);
				bypassedRefsApplied = true;
			} catch (error) {
				return { status: "failed", reason: "write_error", counts, llmCalled, indexRebuilt, error };
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

		try {
			indexRebuilt = rebuildIndexOrThrow(deps, db, memoryPaths);
		} catch (error) {
			return { status: "failed", reason: "index_error", counts, llmCalled, indexRebuilt, error };
		}

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
		stagingFiles: { total: 0, valid: 0, malformed: 0, wrongProject: 0, consumed: 0, preserved: 0 },
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

function loadValidSameProjectStaging(filePaths: string[], projectRoot: string): {
	valid: LoadedStagingFile[];
	malformed: string[];
	wrongProject: string[];
} {
	const valid: LoadedStagingFile[] = [];
	const malformed: string[] = [];
	const wrongProject: string[] = [];

	for (const filePath of filePaths) {
		const raw = readStaging(filePath);
		const data = normalizeStagingFile(raw);
		if (!data) {
			malformed.push(filePath);
			continue;
		}
		if (!sameProjectRoot(data.project_root, projectRoot)) {
			wrongProject.push(filePath);
			continue;
		}
		valid.push({ filePath, data });
	}

	return { valid, malformed, wrongProject };
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

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return fallback;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}
