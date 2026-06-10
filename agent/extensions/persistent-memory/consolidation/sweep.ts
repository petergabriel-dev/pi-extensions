/**
 * T11 — Offline archival sweep for persistent-memory.
 *
 * Pure, deterministic sweep over project memory that archives:
 *  1. Fully-superseded chains — superseded lessons that are reachable through
 *     one or more `supersedes` pointers from an active/archived chain head.
 *  2. Expired session-scoped lessons — lessons with session_level=true
 *     whose last_seen_at (or created_at) is older than a configurable
 *     threshold.
 *
 * Archival is reversible: only the `status` field changes ("superseded"
 * or "active" → "archived"). No records are ever deleted.
 */

import type { Lesson } from "../types.js";

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
