/**
 * T8 — Incremental index writes (replace rebuild-and-swap) tests.
 *
 * Covers:
 *  1. Deterministic add writes markdown and sqlite incrementally;
 *     rebuildIndex stub throws if called; indexRebuilt === false.
 *  2. Adjudication supersede updates sqlite for old (superseded) AND
 *     new (active) lesson without full rebuild.
 *  3. Generation guard / shouldContinue stops between candidates;
 *     first committed/indexed, later staged; no closed-connection errors.
 *
 * Run: npx tsx test/test_incremental_index_writes.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  runReconciliation,
  buildDeterministicPlan,
  splitByShortlist,
} from "../consolidation/reconcile.js";
import { writeStaging, listStagingFiles, readStaging, listDeadLetterFiles } from "../consolidation/staging.js";
import { parseLessonsFile, serializeLessonsFile } from "../storage/markdown.js";
import { openIndex, getIndexCounts, rebuildIndex, type RebuildCounts } from "../storage/sqlite.js";
import type { StagingFile, Lesson, Trigger } from "../types.js";

console.log("Running test_incremental_index_writes...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LessonC = StagingFile["candidates"]["lessons"][number];

function lessonCandidate(
  summary: string,
  detail: string,
  scope = "testproj",
  triggers?: Trigger[],
): LessonC {
  return {
    summary,
    detail,
    scope_suggestion: scope,
    triggers: triggers ?? [{ type: "topic" as const, value: "testing" }],
    source_evidence: { discussion_note_ids: [1] },
  };
}

function makeMemoryPaths(root: string, mem: string) {
  return { projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem };
}

function existingLesson(
  id: string,
  summary: string,
  detail: string,
  overrides?: Partial<Lesson["meta"]>,
): Lesson {
  return {
    id,
    summary,
    detail,
    meta: {
      project_scope: "testproj",
      status: "active",
      session_level: false,
      reinforcement_count: 1,
      last_seen_at: null,
      source_session: "s0",
      created_at: "2026-01-01T00:00:00.000Z",
      supersedes: null,
      triggers: [{ type: "topic" as const, value: "testing" }],
      ...overrides,
    },
  };
}

function setupProject(existingLessons?: Lesson[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-incr-"));
  const mem = path.join(root, ".pi", "memory");
  fs.mkdirSync(path.join(mem, "staging"), { recursive: true });

  for (const name of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) {
    fs.writeFileSync(path.join(mem, name), "", "utf8");
  }

  if (existingLessons && existingLessons.length > 0) {
    fs.writeFileSync(
      path.join(mem, "lessons.md"),
      serializeLessonsFile(existingLessons),
      "utf8",
    );
  }

  const dbPath = path.join(mem, "index.db");
  const db = openIndex(dbPath);

  // Pre-populate sqlite index from markdown so existing records are there
  rebuildIndex(db, makeMemoryPaths(root, mem));

  return { root, mem, db };
}

function writeStagingFile(
  mem: string,
  root: string,
  sessionId: string,
  candidates: { lessons?: LessonC[]; preferences?: any[]; decisions?: any[]; domain?: any[] },
) {
  writeStaging(path.join(mem, "staging", `${sessionId}.json`), {
    schemaVersion: 1,
    session_id: sessionId,
    produced_at: "2026-06-10T00:00:00.000Z",
    project_root: root,
    candidates: {
      lessons: candidates.lessons ?? [],
      preferences: candidates.preferences ?? [],
      decisions: candidates.decisions ?? [],
      domain: candidates.domain ?? [],
    },
  });
}

function stagingCount(mem: string): number {
  return listStagingFiles(mem).length;
}

function readStagedLessons(mem: string): LessonC[] {
  return listStagingFiles(mem).flatMap(
    (file) => readStaging(file)?.candidates.lessons ?? [],
  );
}

/** Return a row from sqlite lessons table by id. */
function sqliteLesson(db: ReturnType<typeof Database>, id: string): Record<string, unknown> | undefined {
  try {
    return db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Deterministic add writes markdown + sqlite incrementally;
//         rebuildIndex stub throws if called; indexRebuilt === false.
// ---------------------------------------------------------------------------

async function testDeterministicAddIncrementalWrites() {
  const { root, mem, db } = setupProject();

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [lessonCandidate("Always write tests first", "Follow TDD.", "testproj")],
    });

    // rebuildIndex stub: throw if called (proves full rebuild was skipped)
    let rebuildCalled = false;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => {
        rebuildCalled = true;
        throw new Error("rebuildIndex should NOT be called for incremental writes");
      },
      callCarefulModel: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(rebuildCalled, false, "rebuildIndex was NOT called");
    assert.strictEqual(result.indexRebuilt, false, "indexRebuilt is false for incremental writes");

    // Markdown has the new lesson
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1);
    assert.strictEqual(lessons[0].summary, "Always write tests first");

    // Sqlite has the new lesson (incremental insert, not rebuild)
    const counts = getIndexCounts(db);
    assert.strictEqual(counts.lessons, 1, "Sqlite has 1 lesson from incremental write");

    // Staging consumed
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 2: Adjudication supersede updates sqlite for old superseded lesson
//         AND new active lesson without full rebuild.
// ---------------------------------------------------------------------------

async function testAdjudicationSupersedeIncrementalWrites() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
  ];

  const { root, mem, db } = setupProject(existing);

  // Verify pre-populated sqlite
  const countsBefore = getIndexCounts(db);
  assert.strictEqual(countsBefore.lessons, 1, "Sqlite pre-populated with existing lesson");

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "JWT authentication with refresh", // collision → adjudicated as supersede
          "Use JWT with refresh tokens for API auth.",
          "testproj",
        ),
      ],
    });

    let rebuildCalled = false;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => {
        rebuildCalled = true;
        throw new Error("rebuildIndex should NOT be called for incremental writes");
      },
      callCarefulModel: undefined,
      callAdjudicationModel: async () =>
        JSON.stringify({ verdicts: [{ verdict: "supersedes" }] }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(rebuildCalled, false, "rebuildIndex was NOT called");
    assert.strictEqual(result.indexRebuilt, false, "indexRebuilt is false for incremental writes");

    // Markdown: old lesson superseded, new lesson active
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 2, "Two lessons: old superseded + new active");

    const oldLesson = lessons.find((l) => l.id === "lsn_01");
    assert.ok(oldLesson, "Old lesson still on disk");
    assert.strictEqual(oldLesson.meta.status, "superseded", "Old lesson status is superseded");

    const newLesson = lessons.find((l) => l.id !== "lsn_01");
    assert.ok(newLesson, "New superseding lesson on disk");
    assert.strictEqual(newLesson.meta.status, "active");
    assert.strictEqual(newLesson.meta.supersedes, "lsn_01");
    assert.strictEqual(newLesson.summary, "JWT authentication with refresh");

    // Sqlite: both old and new lessons are present and correct
    const countsAfter = getIndexCounts(db);
    assert.strictEqual(countsAfter.lessons, 2, "Sqlite has 2 lessons");

    const oldRow = sqliteLesson(db, "lsn_01");
    assert.ok(oldRow, "Old lesson row exists in sqlite");
    assert.strictEqual(oldRow.status, "superseded", "Old lesson sqlite status is superseded");

    const newRow = sqliteLesson(db, newLesson.id);
    assert.ok(newRow, "New lesson row exists in sqlite");
    assert.strictEqual(newRow.status, "active");
    assert.strictEqual(newRow.supersedes, "lsn_01");

    // Staging consumed
    assert.strictEqual(stagingCount(mem), 0);

    console.log("  ✓ old sqlite status =", oldRow.status);
    console.log("  ✓ new sqlite status =", newRow.status, "supersedes =", newRow.supersedes);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 3: Generation guard / shouldContinue stops between candidates;
//         first committed/indexed, later staged; no closed-connection errors.
// ---------------------------------------------------------------------------

async function testGenerationGuardStopsBetweenCandidates() {
  const { root, mem, db } = setupProject();

  try {
    // Two deterministic lesson candidates (no existing lessons → no collision)
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate("Lesson Alpha", "First deterministic add.", "testproj"),
        lessonCandidate("Lesson Beta", "Second deterministic add.", "testproj"),
      ],
    });

    let continueCalls = 0;
    let rebuildCalled = false;

    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => {
        rebuildCalled = true;
        throw new Error("rebuildIndex should NOT be called");
      },
      callCarefulModel: undefined,
      shouldContinue: () => {
        continueCalls += 1;
        // Allow first candidate, then simulate generation change
        return continueCalls <= 1;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(rebuildCalled, false, "rebuildIndex was NOT called");
    assert.strictEqual(result.indexRebuilt, false);

    // First candidate committed to markdown
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "Only first lesson committed to markdown");
    assert.strictEqual(lessons[0].summary, "Lesson Alpha");

    // First candidate in sqlite
    const counts = getIndexCounts(db);
    assert.strictEqual(counts.lessons, 1, "Sqlite has first lesson only");

    // T9: second candidate dead-lettered (generation stopped, terminal).
    assert.strictEqual(stagingCount(mem), 0, "Staging empty (T9 terminal)");
    assert.strictEqual(listDeadLetterFiles(mem).length, 1, "Second candidate dead-lettered");
    const staged = readStagedLessons(mem);
    assert.strictEqual(staged.length, 0);

    // No closed-connection: db is still usable
    const lessonsAfter = db.prepare("SELECT id FROM lessons").all() as { id: string }[];
    assert.strictEqual(lessonsAfter.length, 1, "Sqlite still queryable after generation guard stop");

    console.log("  ✓ continueCalls =", continueCalls);
    console.log("  ✓ committed 1 lesson, 1 dead-lettered (T9 terminal)");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 4: Generation guard stops before adjudication batch (no writes, no close)
// ---------------------------------------------------------------------------

async function testGenerationGuardStopsBeforeAdjudicationBatch() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "JWT authentication with refresh",
          "Use JWT with refresh tokens for API auth.",
          "testproj",
        ),
      ],
    });

    let continueCalls = 0;
    let adjudicationCalled = false;
    let rebuildCalled = false;

    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => {
        rebuildCalled = true;
        throw new Error("rebuildIndex should NOT be called");
      },
      callCarefulModel: undefined,
      callAdjudicationModel: async () => {
        adjudicationCalled = true;
        return JSON.stringify({ verdicts: [{ verdict: "supersedes" }] });
      },
      shouldContinue: () => {
        continueCalls += 1;
        // Stop after the first check (before adjudication batch)
        return false;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(adjudicationCalled, false, "Adjudication NOT called (generation guard stopped it)");
    assert.strictEqual(rebuildCalled, false);

    // No changes to markdown (no candidate committed)
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "Only original lesson");

    // T9: collision candidate dead-lettered (generation guard stopped before adjudication).
    assert.strictEqual(stagingCount(mem), 0, "Staging empty (T9 terminal)");
    assert.strictEqual(listDeadLetterFiles(mem).length, 1, "Collision candidate dead-lettered");

    // Sqlite still queryable
    const sqliteCounts = getIndexCounts(db);
    assert.strictEqual(sqliteCounts.lessons, 1, "Sqlite unchanged");

    console.log("  ✓ adjudicationCalled =", adjudicationCalled);
    console.log("  ✓ candidate dead-lettered, sqlite unchanged (T9 terminal)");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 5: Exact duplicate reinforcement bump is reflected in sqlite
//         (proves changed-record detection, not just new-record insert)
// ---------------------------------------------------------------------------

async function testExactDuplicateBumpIncrementalWrite() {
  const existing = [
    existingLesson("lsn_01", "Use JWT for auth", "Always use JWT.", undefined),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    // Exact duplicate candidate (same summary/detail/scope/triggers as existing)
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate("Use JWT for auth", "Always use JWT.", "testproj"),
      ],
    });

    let rebuildCalled = false;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => {
        rebuildCalled = true;
        throw new Error("rebuildIndex should NOT be called");
      },
      callCarefulModel: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(rebuildCalled, false);
    assert.strictEqual(result.indexRebuilt, false);

    // Markdown: reinforcement_count bumped, last_seen_at updated
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "Still one lesson (exact dup bypassed)");
    assert.strictEqual(lessons[0].meta.reinforcement_count, 2, "Reinforcement bumped to 2");
    assert.ok(lessons[0].meta.last_seen_at, "last_seen_at set");

    // Sqlite: reinforcement_count also bumped (proves changed-record upsert)
    const row = sqliteLesson(db, "lsn_01");
    assert.ok(row, "Lesson row exists in sqlite");
    assert.strictEqual(row.reinforcement_count, 2, "Sqlite reinforcement_count bumped to 2");
    assert.ok(row.last_seen_at, "Sqlite last_seen_at set");

    // Staging consumed
    assert.strictEqual(stagingCount(mem), 0);

    console.log("  ✓ sqlite reinforcement_count =", row.reinforcement_count);
    console.log("  ✓ sqlite last_seen_at =", row.last_seen_at);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await testDeterministicAddIncrementalWrites();
  console.log("  ✓ deterministic add incremental writes (no rebuild, indexRebuilt=false)");

  await testAdjudicationSupersedeIncrementalWrites();
  console.log("  ✓ adjudication supersede incremental writes (old+new sqlite, no rebuild)");

  await testGenerationGuardStopsBetweenCandidates();
  console.log("  ✓ generation guard stops between deterministic candidates");

  await testGenerationGuardStopsBeforeAdjudicationBatch();
  console.log("  ✓ generation guard stops before adjudication batch");

  await testExactDuplicateBumpIncrementalWrite();
  console.log("  ✓ exact duplicate reinforcement bump reflected in sqlite incrementally");

  console.log("\n✅ All incremental index write tests passed!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
