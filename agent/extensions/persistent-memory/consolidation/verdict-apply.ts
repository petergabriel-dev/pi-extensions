/**
 * T5 — Deterministic verdict-apply primitives for persistent-memory.
 *
 * Pure functions over memory state for `duplicate` (reinforce),
 * `supersedes` (set `status` flag + pointer), and `merge`
 * (new active record superseding parents). All are reversible;
 * none delete records.
 *
 * Determinism boundary: caller supplies all structural fields
 * needed for new records (id, timestamps, source_session, etc.).
 * Functions do not call Date.now or Math.random.
 */

import type { Lesson, LessonMeta, Trigger } from "../types.js";

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

/** Parameters for applying a duplicate (reinforcement) verdict. */
export interface DuplicateApplyParams {
  /** The existing lesson that is an exact duplicate of a candidate. */
  target: Lesson;
  /** ISO timestamp for last_seen_at (caller-supplied for determinism). */
  lastSeenAt: string;
  /** How many times to bump reinforcement_count (default 1). */
  bumpBy?: number;
}

/** Parameters for applying a supersedes verdict (one new record replaces one old). */
export interface SupersedesApplyParams {
  /** The old lesson being superseded. */
  target: Lesson;
  /** ISO timestamp for last_seen_at on the old (superseded) record. */
  lastSeenAt: string;
  /** Fields to construct the new active record that supersedes the target. */
  newRecord: Omit<Lesson, "meta"> & {
    meta: Omit<LessonMeta, "status" | "last_seen_at" | "supersedes">;
  };
}

/** Parameters for applying a merge verdict (one new active record supersedes
 *  multiple parent records). */
export interface MergeApplyParams {
  /** Parent lessons that contributed to the merged record (become superseded). */
  parents: Lesson[];
  /** ISO timestamp for last_seen_at on each parent record. */
  lastSeenAt: string;
  /** Fields to construct the new active record that supersedes the parents. */
  newRecord: Omit<Lesson, "meta"> & {
    meta: Omit<LessonMeta, "status" | "last_seen_at" | "supersedes">;
  };
}

/**
 * Separator used in the `supersedes` field when a merge supersedes
 * multiple parents. The field is a deterministic comma-joined list
 * sorted by parent id for determinism.
 */
export const SUPERSEDES_SEPARATOR = ",";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * applyDuplicateLesson — bump reinforcement count on a duplicate record.
 *
 * Does NOT create a new record. The existing target's `reinforcement_count`
 * is increased by `bumpBy` (default 1) and `last_seen_at` is set.
 *
 * Returns a new array; input is not mutated.
 */
export function applyDuplicateLesson(
  lessons: readonly Lesson[],
  params: DuplicateApplyParams,
): Lesson[] {
  const { target, lastSeenAt, bumpBy = 1 } = params;

  if (bumpBy < 0) {
    throw new Error("bumpBy must be non-negative");
  }

  return lessons.map((lesson) => {
    if (lesson.id !== target.id) return lesson;
    return {
      ...lesson,
      meta: {
        ...lesson.meta,
        reinforcement_count: lesson.meta.reinforcement_count + bumpBy,
        last_seen_at: lastSeenAt,
      },
    };
  });
}

/**
 * applySupersedesLesson — mark an old lesson superseded and create a new
 * active lesson that supersedes it.
 *
 * The old lesson gets `status: "superseded"`, `last_seen_at` set, and
 * remains in the returned array. The new active lesson has `supersedes`
 * pointing to the old lesson's id.
 *
 * Returns a new array; input is not mutated.
 */
export function applySupersedesLesson(
  lessons: readonly Lesson[],
  params: SupersedesApplyParams,
): Lesson[] {
  const { target, lastSeenAt, newRecord } = params;

  const supersededOld: Lesson = {
    ...target,
    meta: {
      ...target.meta,
      status: "superseded",
      last_seen_at: lastSeenAt,
    },
  };

  const newActive: Lesson = {
    id: newRecord.id,
    summary: newRecord.summary,
    detail: newRecord.detail,
    meta: {
      ...newRecord.meta,
      status: "active",
      last_seen_at: null,
      supersedes: target.id,
    },
  };

  return [
    ...lessons.map((lesson) => (lesson.id === target.id ? supersededOld : lesson)),
    newActive,
  ];
}

/**
 * applyMergeLessons — mark parent lessons superseded and create a new
 * active lesson that supersedes all of them.
 *
 * Each parent gets `status: "superseded"`, `last_seen_at` set, and
 * remains in the returned array. The new active lesson has `supersedes`
 * set to a deterministic comma-joined string of parent ids (sorted by id).
 *
 * Returns a new array; input is not mutated.
 */
export function applyMergeLessons(
  lessons: readonly Lesson[],
  params: MergeApplyParams,
): Lesson[] {
  const { parents, lastSeenAt, newRecord } = params;

  const parentIds = parents.map((p) => p.id);
  const parentIdSet = new Set(parentIds);

  // Replace parents with superseded versions; keep non-parents as-is.
  const supersededParents = lessons
    .filter((lesson) => parentIdSet.has(lesson.id))
    .map((lesson) => ({
      ...lesson,
      meta: {
        ...lesson.meta,
        status: "superseded" as const,
        last_seen_at: lastSeenAt,
      },
    }));

  const newActive: Lesson = {
    id: newRecord.id,
    summary: newRecord.summary,
    detail: newRecord.detail,
    meta: {
      ...newRecord.meta,
      status: "active",
      last_seen_at: null,
      supersedes: [...parentIds].sort().join(SUPERSEDES_SEPARATOR),
    },
  };

  return [
    ...lessons.filter((lesson) => !parentIdSet.has(lesson.id)),
    ...supersededParents,
    newActive,
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone an array of Triggers (shallow per trigger is safe — they are flat). */
export function cloneTriggers(triggers: readonly Trigger[]): Trigger[] {
  return triggers.map((t) => ({ ...t }));
}

/** Deep-clone a Lesson. */
export function cloneLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    meta: {
      ...lesson.meta,
      triggers: cloneTriggers(lesson.meta.triggers),
    },
  };
}

/** Deep-clone an array of Lessons (used by caller for defensive copy). */
export function cloneLessons(lessons: readonly Lesson[]): Lesson[] {
  return lessons.map(cloneLesson);
}
