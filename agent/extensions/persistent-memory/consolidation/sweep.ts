/**
 * T11/T12 — Offline archival sweep + low-signal flagging + contradiction
 * detection for persistent-memory.
 *
 * T11 — archival sweep:
 *  1. Fully-superseded chains — superseded lessons that are reachable through
 *     one or more `supersedes` pointers from an active/archived chain head.
 *  2. Expired session-scoped lessons — lessons with session_level=true
 *     whose last_seen_at (or created_at) is older than a configurable
 *     threshold.
 *
 * Archival is reversible: only the `status` field changes ("superseded"
 * or "active" → "archived"). No records are ever deleted.
 *
 * T12 — low-signal flagging (flag, never delete):
 *  3. Active lessons with old last_seen_at, low reinforcement_count, and
 *     no presence in the firing log are flagged as `low_signal: true`.
 *  4. Flagged records are surfaced for human review; they are never
 *     archived or deleted.
 *
 * T12 — contradiction detection (queue, never auto-resolve):
 *  5. Pairs of active lessons sharing at least one trigger (same type +
 *     value + pattern) are identified as suspected contradictions and
 *     assigned a `contradiction_group` id for adjudication.
 *  6. Contradictions are surfaced for human review; they are never
 *     auto-resolved.
 */

import type { Lesson, Trigger } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepConfig {
	/**
	 * Age threshold in milliseconds for a session-scoped lesson to be
	 * considered expired. Defaults to 24 hours.
	 */
	sessionExpiryMs?: number;
	/**
	 * Reference timestamp for "now" (injectable for deterministic tests).
	 * Defaults to Date.now().
	 */
	nowMs?: number;
}

export interface SweepResult {
	/** IDs of lessons whose status was changed to "archived". */
	archivedLessonIds: string[];
	/** True when at least one lesson status was changed. */
	changed: boolean;
}

export interface ProjectMemorySweepInput {
	lessons: Lesson[];
}

// ---------------------------------------------------------------------------
// T12 — Low-signal flagging types
// ---------------------------------------------------------------------------

export interface FlagLowSignalConfig {
	/**
	 * Age threshold in milliseconds for last_seen_at (or created_at).
	 * Lessons whose last activity is older than this are candidates.
	 * Defaults to 30 days.
	 */
	lowSignalAgeMs?: number;
	/**
	 * Maximum reinforcement_count for a lesson to be flagged as low-signal.
	 * Lessons with count below this threshold are candidates.
	 * Defaults to 1 (meaning only lessons with 0 reinforcement are flagged).
	 */
	lowSignalMaxReinforcement?: number;
	/**
	 * Set of lesson IDs that have appeared in the firing log.
	 * Lessons absent from this set are deemed "never fired."
	 */
	firedLessonIds?: Set<string>;
	/**
	 * Reference timestamp for "now" (injectable for deterministic tests).
	 * Defaults to Date.now().
	 */
	nowMs?: number;
}

export interface FlagLowSignalResult {
	/** IDs of lessons newly flagged as low-signal (not already flagged). */
	flaggedIds: string[];
	/** True when at least one lesson was flagged. */
	changed: boolean;
}

// ---------------------------------------------------------------------------
// T12 — Contradiction detection types
// ---------------------------------------------------------------------------

/** A pair of lesson IDs suspected to be contradictory. */
export interface ContradictionPair {
	lessonA: string;
	lessonB: string;
	/** Shared trigger that caused the suspicion. */
	sharedTrigger: string;
}

export interface ContradictionResult {
	/** Groups assigned: key=group id, value=set of lesson IDs in the group. */
	groups: Map<string, Set<string>>;
	/** Pairs that were grouped together. */
	pairs: ContradictionPair[];
	/** True when at least one contradiction was detected. */
	changed: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Apply archival sweep to an array of lessons.
 *
 * Does NOT mutate the input; returns a new array.
 *
 * Archival rules:
 *  1. Superseded lessons reachable from a non-superseded chain head → archived.
 *     Orphaned superseded records are left untouched because the replacement
 *     chain cannot be proven complete.
 *  2. Any lesson with session_level=true AND status="active" AND
 *     age > sessionExpiryMs → "archived".
 */
export function sweepLessons(
	lessons: readonly Lesson[],
	config: SweepConfig = {},
): { lessons: Lesson[]; result: SweepResult } {
	const nowMs = config.nowMs ?? Date.now();
	const sessionExpiryMs = config.sessionExpiryMs ?? DEFAULT_SESSION_EXPIRY_MS;
	const supersededInCompleteChains = findSupersededLessonsInCompleteChains(lessons);

	const archivedIds: string[] = [];

	const swept = lessons.map((lesson) => {
		// Rule 1: archive only superseded records with a provable replacement head.
		if (lesson.meta.status === "superseded" && supersededInCompleteChains.has(lesson.id)) {
			archivedIds.push(lesson.id);
			return archiveLesson(lesson);
		}

		// Rule 2: expired session-scoped active → archived
		if (lesson.meta.session_level && lesson.meta.status === "active") {
			const lastSeenRaw = lesson.meta.last_seen_at ?? lesson.meta.created_at;
			const lastSeenMs = Date.parse(lastSeenRaw);
			if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > sessionExpiryMs) {
				archivedIds.push(lesson.id);
				return archiveLesson(lesson);
			}
		}

		return lesson;
	});

	return {
		lessons: swept,
		result: {
			archivedLessonIds: archivedIds,
			changed: archivedIds.length > 0,
		},
	};
}

/**
 * Un-archive lessons by id: changes status from "archived" back to "active".
 * This is the reversibility mechanism — no data is lost, only status flags
 * are toggled.
 *
 * Does NOT mutate the input.
 */
export function unarchiveLessons(
	lessons: readonly Lesson[],
	ids: Set<string>,
): { lessons: Lesson[]; restoredCount: number } {
	let count = 0;
	const restored = lessons.map((lesson) => {
		if (lesson.meta.status === "archived" && ids.has(lesson.id)) {
			count++;
			return {
				...lesson,
				meta: {
					...lesson.meta,
					status: "active" as const,
				},
			};
		}
		return lesson;
	});
	return { lessons: restored, restoredCount: count };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function archiveLesson(lesson: Lesson): Lesson {
	return {
		...lesson,
		meta: {
			...lesson.meta,
			status: "archived",
		},
	};
}

function findSupersededLessonsInCompleteChains(lessons: readonly Lesson[]): Set<string> {
	const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
	const archiveable = new Set<string>();

	for (const head of lessons) {
		if (head.meta.status === "superseded") continue;
		for (const parentId of parseSupersedes(head.meta.supersedes)) {
			collectSupersededAncestors(parentId, byId, archiveable, new Set<string>());
		}
	}

	return archiveable;
}

function collectSupersededAncestors(
	id: string,
	byId: Map<string, Lesson>,
	archiveable: Set<string>,
	seen: Set<string>,
): void {
	if (seen.has(id)) return;
	seen.add(id);
	const lesson = byId.get(id);
	if (!lesson || lesson.meta.status !== "superseded") return;
	archiveable.add(id);
	for (const parentId of parseSupersedes(lesson.meta.supersedes)) {
		collectSupersededAncestors(parentId, byId, archiveable, seen);
	}
}

function parseSupersedes(raw: string | null): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.sort();
}

// ---------------------------------------------------------------------------
// T12 — Low-signal flagging
// ---------------------------------------------------------------------------

const DEFAULT_LOW_SIGNAL_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_LOW_SIGNAL_MAX_REINFORCEMENT = 1; // flag when count < 1 (i.e., 0)

/**
 * Flag low-signal lessons for review.
 *
 * A lesson is flagged as low-signal when ALL of:
 *  1. Its last_seen_at (or created_at) is older than lowSignalAgeMs.
 *  2. Its reinforcement_count is less than lowSignalMaxReinforcement.
 *  3. It is not present in the firedLessonIds set.
 *
 * Only active lessons are considered. Already-flagged lessons are not
 * double-counted. Superseded and archived lessons are skipped.
 *
 * Does NOT mutate the input; returns a new array with `low_signal: true`
 * set on flagged records.
 */
export function flagLowSignalLessons(
	lessons: readonly Lesson[],
	config: FlagLowSignalConfig = {},
): { lessons: Lesson[]; result: FlagLowSignalResult } {
	const nowMs = config.nowMs ?? Date.now();
	const ageThresholdMs = config.lowSignalAgeMs ?? DEFAULT_LOW_SIGNAL_AGE_MS;
	const maxReinforcement = config.lowSignalMaxReinforcement ?? DEFAULT_LOW_SIGNAL_MAX_REINFORCEMENT;
	const firedIds = config.firedLessonIds ?? new Set<string>();

	const flaggedIds: string[] = [];

	const flagged = lessons.map((lesson) => {
		// Only consider active, non-archived, non-superseded lessons.
		if (lesson.meta.status !== "active") return lesson;
		// Skip already flagged.
		if (lesson.meta.low_signal) return lesson;

		const lastSeenRaw = lesson.meta.last_seen_at ?? lesson.meta.created_at;
		const lastSeenMs = Date.parse(lastSeenRaw);
		const isOld = Number.isFinite(lastSeenMs) && (nowMs - lastSeenMs) > ageThresholdMs;
		const isLowReinforcement = lesson.meta.reinforcement_count < maxReinforcement;
		const neverFired = !firedIds.has(lesson.id);

		if (isOld && isLowReinforcement && neverFired) {
			flaggedIds.push(lesson.id);
			return {
				...lesson,
				meta: {
					...lesson.meta,
					low_signal: true,
				},
			};
		}

		return lesson;
	});

	return {
		lessons: flagged,
		result: {
			flaggedIds,
			changed: flaggedIds.length > 0,
		},
	};
}

/**
 * Clear low-signal flags from specified lessons.
 * Reversible — only the `low_signal` flag is reset to false.
 * Does NOT mutate the input.
 */
export function unflagLowSignalLessons(
	lessons: readonly Lesson[],
	ids: Set<string>,
): { lessons: Lesson[]; clearedCount: number } {
	let count = 0;
	const restored = lessons.map((lesson) => {
		if (lesson.meta.low_signal && ids.has(lesson.id)) {
			count++;
			return {
				...lesson,
				meta: {
					...lesson.meta,
					low_signal: false,
				},
			};
		}
		return lesson;
	});
	return { lessons: restored, clearedCount: count };
}

// ---------------------------------------------------------------------------
// T12 — Contradiction detection
// ---------------------------------------------------------------------------

/**
 * Detect suspected contradictions between active lessons.
 *
 * Heuristic: two active lessons sharing at least one trigger (same type,
 * value, and pattern) are flagged as potentially contradictory. They are
 * assigned a shared `contradiction_group` id.
 *
 * Only active, non-archived, non-superseded lessons are considered.
 * Lessons already in a contradiction group are skipped.
 *
 * Does NOT mutate the input; returns a new array with `contradiction_group`
 * set on grouped records.
 */
export function detectContradictions(
	lessons: readonly Lesson[],
): { lessons: Lesson[]; result: ContradictionResult } {
	// Build a trigger→lessons index for active lessons not yet grouped.
	const triggerIndex = new Map<string, string[]>();

	for (const lesson of lessons) {
		if (lesson.meta.status !== "active") continue;
		if (lesson.meta.contradiction_group) continue; // already grouped
		for (const trigger of lesson.meta.triggers) {
			const key = serializeTriggerKey(trigger);
			const ids = triggerIndex.get(key) ?? [];
			ids.push(lesson.id);
			triggerIndex.set(key, ids);
		}
	}

	// Find triggers shared by 2+ lessons.
	const pairs: ContradictionPair[] = [];
	const seenPairs = new Set<string>();

	for (const [triggerKey, lessonIds] of triggerIndex) {
		if (lessonIds.length < 2) continue;
		// Generate all unique pairs for this trigger.
		for (let i = 0; i < lessonIds.length; i++) {
			for (let j = i + 1; j < lessonIds.length; j++) {
				const a = lessonIds[i]!;
				const b = lessonIds[j]!;
				const pairKey = [a, b].sort().join("||");
				if (seenPairs.has(pairKey)) continue;
				seenPairs.add(pairKey);
				pairs.push({ lessonA: a, lessonB: b, sharedTrigger: triggerKey });
			}
		}
	}

	if (pairs.length === 0) {
		return {
			lessons: lessons.map((l) => ({ ...l, meta: { ...l.meta } })),
			result: { groups: new Map(), pairs: [], changed: false },
		};
	}

	// Assign contradiction groups using union-find over pairs.
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		const p = parent.get(id);
		if (p === undefined || p === id) {
			parent.set(id, id);
			return id;
		}
		const root = find(p);
		parent.set(id, root);
		return root;
	};
	const union = (a: string, b: string): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(rb, ra);
	};

	for (const pair of pairs) {
		union(pair.lessonA, pair.lessonB);
	}

	// Build groups.
	const groups = new Map<string, Set<string>>();
	for (const pair of pairs) {
		const root = find(pair.lessonA);
		const group = groups.get(root) ?? new Set<string>();
		group.add(pair.lessonA);
		group.add(pair.lessonB);
		groups.set(root, group);
	}

	// Assign group IDs to lessons.
	const rootToGroupId = new Map<string, string>();
	let groupCounter = 0;
	const getGroupId = (root: string): string => {
		const existing = rootToGroupId.get(root);
		if (existing) return existing;
		const id = `cgrp_${String(++groupCounter).padStart(3, "0")}`;
		rootToGroupId.set(root, id);
		return id;
	};

	const groupedIds = new Set<string>();
	for (const pair of pairs) {
		groupedIds.add(pair.lessonA);
		groupedIds.add(pair.lessonB);
	}

	const resultLessons = lessons.map((lesson) => {
		if (!groupedIds.has(lesson.id)) return lesson;
		const root = find(lesson.id);
		const groupId = getGroupId(root);
		return {
			...lesson,
			meta: {
				...lesson.meta,
				contradiction_group: groupId,
			},
		};
	});

	// Rebuild groups with the assigned IDs.
	const finalGroups = new Map<string, Set<string>>();
	for (const [root, members] of groups) {
		finalGroups.set(getGroupId(root), members);
	}

	return {
		lessons: resultLessons,
		result: { groups: finalGroups, pairs, changed: true },
	};
}

/** Clear contradiction_group assignments for specified lessons. */
export function clearContradictionGroups(
	lessons: readonly Lesson[],
	ids: Set<string>,
): { lessons: Lesson[]; clearedCount: number } {
	let count = 0;
	const restored = lessons.map((lesson) => {
		if (lesson.meta.contradiction_group && ids.has(lesson.id)) {
			count++;
			return {
				...lesson,
				meta: {
					...lesson.meta,
					contradiction_group: null,
				},
			};
		}
		return lesson;
	});
	return { lessons: restored, clearedCount: count };
}

function serializeTriggerKey(trigger: Trigger): string {
	if (trigger.type === "command") return `cmd:${trigger.pattern}`;
	if (trigger.type === "tool") {
		return `tool:${trigger.value}${trigger.pattern ? `/${trigger.pattern}` : ""}`;
	}
	return `${trigger.type}:${trigger.value}`;
}
