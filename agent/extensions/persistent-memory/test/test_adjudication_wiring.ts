/**
 * T6 — Adjudication call wiring (batched) tests.
 *
 * Covers:
 *  - Batched adjudication: duplicate/supersedes/merge routing for lessons
 *    asserting old targets remain on disk and statuses/pointers/reinforcement.
 *  - Injected call failure after deterministic add: deterministic add stays
 *    committed, colliding/adjudication batch stays staged, run completes
 *    without throw, no rollback.
 *  - Verdict routing correctness for all four verdict types.
 *  - Model call is NOT made when callAdjudicationModel is absent.
 *
 * Run: npx tsx test/test_adjudication_wiring.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  runReconciliation,
  buildAdjudicationPrompt,
  mapVerdictsToPlan,
  splitByShortlist,
} from "../consolidation/reconcile.js";
import { writeStaging, listStagingFiles, readStaging } from "../consolidation/staging.js";
import { parseLessonsFile, serializeLessonsFile } from "../storage/markdown.js";
import { openIndex, getIndexCounts } from "../storage/sqlite.js";
import type { AdjudicationVerdict } from "../consolidation/adjudication.js";
import type { ShortlistRecord } from "../consolidation/shortlist.js";
import type { StagingFile, Lesson, LessonCandidate, Trigger } from "../types.js";

console.log("Running test_adjudication_wiring...\n");

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

function setupProject(existingLessons?: Lesson[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-adj-"));
  const mem = path.join(root, ".pi", "memory");
  fs.mkdirSync(path.join(mem, "staging"), { recursive: true });

  // Write initial markdown files
  for (const name of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) {
    fs.writeFileSync(path.join(mem, name), "", "utf8");
  }

  // If existing lessons provided, serialize them to lessons.md
  if (existingLessons && existingLessons.length > 0) {
    fs.writeFileSync(
      path.join(mem, "lessons.md"),
      serializeLessonsFile(existingLessons),
      "utf8",
    );
  }

  const dbPath = path.join(mem, "index.db");
  const db = openIndex(dbPath);

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

function stagingCount(mem: string): number {
  return listStagingFiles(mem).length;
}

function readStagedLessons(mem: string): LessonC[] {
  return listStagingFiles(mem).flatMap(
    (file) => readStaging(file)?.candidates.lessons ?? [],
  );
}

// ---------------------------------------------------------------------------
// Unit test: buildAdjudicationPrompt
// ---------------------------------------------------------------------------

{
  console.log("buildAdjudicationPrompt unit test...");

  const candidates = [
    {
      ref: "s1:lessons:1",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 1,
      candidate: lessonCandidate("Test lesson A", "Detail A.", "testproj"),
    },
  ];

  const shortlists: ShortlistRecord[][] = [
    [
      existingLesson("lsn_01", "Existing lesson", "Existing detail."),
    ],
  ];

  const prompt = buildAdjudicationPrompt(candidates, shortlists);

  assert.ok(prompt.includes("Candidate 1:"), "prompt includes candidate label");
  assert.ok(prompt.includes('"Test lesson A"'), "prompt includes summary");
  assert.ok(prompt.includes('"Detail A."'), "prompt includes detail");
  assert.ok(prompt.includes("testproj"), "prompt includes scope");
  assert.ok(prompt.includes("lsn_01"), "prompt includes shortlist record id");
  assert.ok(prompt.includes("Existing lesson"), "prompt includes shortlist summary");
  assert.ok(prompt.includes("verdicts"), "prompt includes verdicts key");

  console.log("  ✓ buildAdjudicationPrompt passed\n");
}

// ---------------------------------------------------------------------------
// Unit test: mapVerdictsToPlan — distinct, duplicate, supersedes, merge
// ---------------------------------------------------------------------------

{
  console.log("mapVerdictsToPlan unit test...");

  const target = existingLesson("lsn_01", "Existing", "Existing detail.");
  const target2 = existingLesson("lsn_02", "Existing B", "Existing detail B.");

  const candidates = [
    {
      ref: "s1:lessons:1",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 1,
      candidate: lessonCandidate("New distinct", "New detail.", "testproj"),
    },
    {
      ref: "s1:lessons:2",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 2,
      candidate: lessonCandidate("Duplicate of existing", "Same detail.", "testproj"),
    },
    {
      ref: "s1:lessons:3",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 3,
      candidate: lessonCandidate("Supersedes existing", "Better detail.", "testproj"),
    },
    {
      ref: "s1:lessons:4",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 4,
      candidate: lessonCandidate("Merge candidate", "Merge detail.", "testproj"),
    },
  ];

  const shortlists: ShortlistRecord[][] = [
    [target],   // candidate 0 shortlist
    [target],   // candidate 1 shortlist
    [target2],  // candidate 2 shortlist
    [target2],  // candidate 3 shortlist
  ];

  const existing = {
    lessons: [target, target2],
    preferences: [],
    decisions: [],
    domain: [],
  };

  const verdicts: AdjudicationVerdict[] = [
    { verdict: "distinct" },
    { verdict: "duplicate" },
    { verdict: "supersedes" },
    { verdict: "merge", merged_text: "Merged summary text." },
  ];

  const result = mapVerdictsToPlan(verdicts, candidates, shortlists, existing);

  assert.strictEqual(result.appliedRefs.size, 4, "all 4 applied");
  assert.strictEqual(result.parkedRefs.size, 0, "none parked");
  assert.strictEqual(result.plan.lessons.length, 4);

  // distinct → add
  assert.strictEqual(result.plan.lessons[0].action, "add");
  assert.strictEqual(result.plan.lessons[0].summary, "New distinct");
  assert.strictEqual((result.plan.lessons[0] as any).target_id, undefined);

  // duplicate → merge (reinforce)
  assert.strictEqual(result.plan.lessons[1].action, "merge");
  assert.strictEqual((result.plan.lessons[1] as any).target_id, "lsn_01");
  assert.strictEqual(result.plan.lessons[1].summary, "Existing"); // unchanged

  // supersedes → supersede
  assert.strictEqual(result.plan.lessons[2].action, "supersede");
  assert.strictEqual((result.plan.lessons[2] as any).target_id, "lsn_02");
  assert.strictEqual(result.plan.lessons[2].summary, "Supersedes existing");

  // merge → supersede (with merged_text)
  assert.strictEqual(result.plan.lessons[3].action, "supersede");
  assert.strictEqual((result.plan.lessons[3] as any).target_id, "lsn_02");
  assert.strictEqual(result.plan.lessons[3].summary, "Merged summary text.");

  console.log("  ✓ mapVerdictsToPlan routing passed\n");
}

// ---------------------------------------------------------------------------
// Unit test: mapVerdictsToPlan — partial batch (fewer/parked verdicts than candidates)
// ---------------------------------------------------------------------------

{
  console.log("mapVerdictsToPlan partial batch test...");

  const target = existingLesson("lsn_01", "Existing", "Detail.");

  const candidates = [
    {
      ref: "s1:lessons:1",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 1,
      candidate: lessonCandidate("First", "Detail 1.", "testproj"),
    },
    {
      ref: "s1:lessons:2",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 2,
      candidate: lessonCandidate("Second", "Detail 2.", "testproj"),
    },
    {
      ref: "s1:lessons:3",
      session_id: "s1",
      produced_at: "2026-06-10T00:00:00.000Z",
      category: "lessons" as const,
      index: 3,
      candidate: lessonCandidate("Third", "Detail 3.", "testproj"),
    },
  ];

  const shortlists: ShortlistRecord[][] = [[target], [target], [target]];

  const verdicts: AdjudicationVerdict[] = [
    { verdict: "distinct" },
    { verdict: "supersedes" },
  ];

  const existing = {
    lessons: [target],
    preferences: [],
    decisions: [],
    domain: [],
  };

  const result = mapVerdictsToPlan(verdicts, candidates, shortlists, existing, [{ index: 1 }]);

  assert.strictEqual(result.appliedRefs.size, 2, "first and third applied");
  assert.ok(result.appliedRefs.has("s1:lessons:1"));
  assert.ok(result.appliedRefs.has("s1:lessons:3"));
  assert.strictEqual(result.parkedRefs.size, 1, "second parked by parser index");
  assert.ok(result.parkedRefs.has("s1:lessons:2"));
  assert.strictEqual(result.plan.lessons[1].action, "supersede");
  assert.deepStrictEqual(result.plan.lessons[1].candidate_refs, ["s1:lessons:3"]);

  console.log("  ✓ partial batch parking passed\n");
}

// ---------------------------------------------------------------------------
// Integration test: batched adjudication with duplicate/supersedes/merge
// ---------------------------------------------------------------------------

async function testBatchedAdjudicationRouting() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
    existingLesson("lsn_02", "Database indexing", "Add indexes for performance."),
    existingLesson("lsn_03", "Error handling pattern", "Centralized error handler."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    // Staging: 3 collision candidates (will shortlist-match existing lessons)
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "JWT authentication update", // near-duplicate of lsn_01 (not exact so not prefilter-bypassed)
          "Use JWT for API auth with refresh tokens.",
          "testproj",
        ),
        lessonCandidate(
          "Better database indexing", // supersedes lsn_02
          "Add composite indexes for query performance.",
          "testproj",
        ),
        lessonCandidate(
          "Error handling and logging", // merge with lsn_03
          "Centralized error handler with structured logging.",
          "testproj",
        ),
      ],
    });

    const adjudicationResponses: string[] = [];
    let callCount = 0;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async (_prompt: string) => {
        callCount += 1;
        const response = JSON.stringify({
          verdicts: [
            { verdict: "duplicate" },
            { verdict: "supersedes" },
            { verdict: "merge", merged_text: "Centralized error handling with structured logging and alerting." },
          ],
        });
        adjudicationResponses.push(response);
        return response;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(callCount, 1, "one adjudication call");
    assert.strictEqual(result.status, "completed");

    // Read back lessons
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));

    // lsn_01 should still be active, reinforcement bumped
    const lsn01 = lessons.find((l) => l.id === "lsn_01");
    assert.ok(lsn01, "lsn_01 still on disk");
    assert.strictEqual(lsn01.meta.status, "active", "lsn_01 remains active (duplicate)");
    assert.strictEqual(lsn01.meta.reinforcement_count, 2, "lsn_01 reinforcement bumped");
    assert.strictEqual(lsn01.summary, "JWT authentication", "lsn_01 summary unchanged");

    // lsn_02 should be superseded
    const lsn02 = lessons.find((l) => l.id === "lsn_02");
    assert.ok(lsn02, "lsn_02 still on disk");
    assert.strictEqual(lsn02.meta.status, "superseded", "lsn_02 superseded");

    // A new active record should supersede lsn_02
    const supersedingRecord = lessons.find(
      (l) => l.meta.status === "active" && l.meta.supersedes === "lsn_02",
    );
    assert.ok(supersedingRecord, "new record supersedes lsn_02");
    assert.strictEqual(supersedingRecord.summary, "Better database indexing");

    // lsn_03 should be superseded (merge → supersede action)
    const lsn03 = lessons.find((l) => l.id === "lsn_03");
    assert.ok(lsn03, "lsn_03 still on disk");
    assert.strictEqual(lsn03.meta.status, "superseded", "lsn_03 superseded by merge");

    // A new active record should supersede lsn_03 with merged_text
    const mergedRecord = lessons.find(
      (l) => l.meta.status === "active" && l.meta.supersedes === "lsn_03",
    );
    assert.ok(mergedRecord, "new merged record supersedes lsn_03");
    assert.strictEqual(
      mergedRecord.summary,
      "Centralized error handling with structured logging and alerting.",
      "merged_text used as summary",
    );

    // Total lessons: 3 original + 2 new = 5
    assert.strictEqual(lessons.length, 5, "5 total lessons (3 originals + 2 new)");

    // Staging should be consumed
    assert.strictEqual(stagingCount(mem), 0, "staging consumed");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: distinct verdict creates new lesson
// ---------------------------------------------------------------------------

async function testDistinctVerdict() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "Completely different topic", // distinct from lsn_01
          "Different detail entirely.",
          "testproj",
        ),
      ],
    });

    // This candidate will still shortlist-match due to lexical overlap, so we
    // adjudicate it. The model says "distinct".
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async () =>
        JSON.stringify({ verdicts: [{ verdict: "distinct" }] }),
    });

    assert.strictEqual(result.status, "completed");

    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 2, "2 lessons: original + new distinct");
    const newLesson = lessons.find((l) => l.id !== "lsn_01");
    assert.ok(newLesson, "new distinct lesson exists");
    assert.strictEqual(newLesson.meta.status, "active");
    assert.strictEqual(newLesson.summary, "Completely different topic");
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: injected call failure parks batch, deterministic add stays
// ---------------------------------------------------------------------------

async function testAdjudicationFailureAfterDeterministicAdd() {
  // Existing lesson so the "Collision lesson" will shortlist-match
  const existing = [
    existingLesson("lsn_01", "Existing collision anchor", "Anchor for collision testing."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    // Staging has two candidates:
    // 1. No-collision (deterministic add — completely different topic)
    // 2. Collision (will match lsn_01, requires adjudication)
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "Banana pancake recipe", // deterministic: no shortlist match
          "Mix flour, eggs, and banana.",
          "testproj",
          [{ type: "topic" as const, value: "cooking" }],
        ),
        lessonCandidate(
          "Existing collision anchor", // collision: matches lsn_01
          "Better anchor for collision testing.",
          "testproj",
        ),
      ],
    });

    let adjudicationCalled = false;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async () => {
        adjudicationCalled = true;
        throw new Error("Simulated adjudication model failure");
      },
    });

    assert.ok(adjudicationCalled, "adjudication was attempted");

    // Deterministic add should be committed
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    const deterministicLesson = lessons.find(
      (l) => l.summary === "Banana pancake recipe",
    );
    assert.ok(deterministicLesson, "deterministic add committed to disk");
    assert.strictEqual(deterministicLesson.meta.status, "active");
    assert.strictEqual(deterministicLesson.meta.reinforcement_count, 1);

    // Original lesson should still exist
    const original = lessons.find((l) => l.id === "lsn_01");
    assert.ok(original, "original lesson still on disk");

    // Collision candidate should remain staged
    assert.strictEqual(stagingCount(mem), 1, "staging preserved for collision candidate");
    const staged = readStagedLessons(mem);
    assert.strictEqual(staged.length, 1, "one staged lesson");
    assert.strictEqual(staged[0].summary, "Existing collision anchor",
      "collision candidate still staged");
    // reconcile_attempts should be incremented
    assert.strictEqual(staged[0].reconcile_attempts, 1,
      "reconcile_attempts incremented");

    // The run should complete while parking only the failed batch.
    assert.strictEqual(result.status, "completed");
    // Deterministic work was NOT rolled back
    assert.strictEqual(lessons.length, 2, "only 2 lessons on disk (original + deterministic)");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: adjudication NOT called when callAdjudicationModel absent
// ---------------------------------------------------------------------------

async function testNoAdjudicationWithoutModel() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    // Near-duplicate (not exact, so not prefilter-bypassed) that
    // shortlist-matches lsn_01 but can't be resolved without a model.
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate("JWT authentication update", "Use JWT for API auth with refresh.", "testproj"),
      ],
    });

    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      // callAdjudicationModel NOT provided
    });

    // Should complete (collision candidate stays staged — no model to resolve)
    assert.strictEqual(result.llmCalled, false);
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "only original lesson");
    assert.strictEqual(stagingCount(mem), 1, "collision candidate stays staged");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: deterministic-only candidate NOT adjudicated
// ---------------------------------------------------------------------------

async function testDeterministicNotAdjudicated() {
  const existing = [
    existingLesson("lsn_01", "JWT authentication", "Use JWT for API auth."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    // This candidate has no shortlist match, so it goes deterministic.
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate(
          "Banana pancake recipe",
          "Mix flour and banana.",
          "testproj",
          [{ type: "topic" as const, value: "cooking" }],
        ),
      ],
    });

    let adjudicationCalled = false;
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async () => {
        adjudicationCalled = true;
        return JSON.stringify({ verdicts: [] });
      },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(adjudicationCalled, false,
      "adjudication NOT called for deterministic candidate");
    assert.strictEqual(result.llmCalled, false);

    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 2, "original + deterministic");
    const newLesson = lessons.find((l) => l.summary === "Banana pancake recipe");
    assert.ok(newLesson, "deterministic add on disk");
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: adjudication batch size splits batches
// ---------------------------------------------------------------------------

async function testAdjudicationBatchSplitting() {
  const existing = [
    existingLesson("lsn_01", "Anchor A", "Anchor detail A."),
    existingLesson("lsn_02", "Anchor B", "Anchor detail B."),
    existingLesson("lsn_03", "Anchor C", "Anchor detail C."),
    existingLesson("lsn_04", "Anchor D", "Anchor detail D."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate("Anchor A improved", "Better detail A.", "testproj"),
        lessonCandidate("Anchor B improved", "Better detail B.", "testproj"),
        lessonCandidate("Anchor C improved", "Better detail C.", "testproj"),
        lessonCandidate("Anchor D improved", "Better detail D.", "testproj"),
      ],
    });

    const batchSizes: number[] = [];
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async (prompt: string) => {
        // Count how many candidates are in this prompt
        const count = (prompt.match(/Candidate \d+:/g) ?? []).length;
        batchSizes.push(count);
        // Return supersedes for all
        return JSON.stringify({
          verdicts: Array.from({ length: count }, () => ({ verdict: "supersedes" })),
        });
      },
      adjudicationBatchSize: 2,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(batchSizes.length, 2, "2 batches with batchSize=2 for 4 candidates");
    assert.deepStrictEqual(batchSizes, [2, 2], "each batch has 2 candidates");

    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    // 4 original + 4 new superseding = 8
    assert.strictEqual(lessons.length, 8);
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Integration test: merge verdict includes merged_text as summary
// ---------------------------------------------------------------------------

async function testMergeVerdictTextRouting() {
  const existing = [
    existingLesson("lsn_01", "Old error handling", "Basic error handling."),
  ];

  const { root, mem, db } = setupProject(existing);

  try {
    writeStagingFile(mem, root, "s1", {
      lessons: [
        lessonCandidate("Error handling with logging", "Detailed error handling with logs.", "testproj"),
      ],
    });

    const mergedText = "Comprehensive error handling with structured logging and alerting";
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      callAdjudicationModel: async () =>
        JSON.stringify({
          verdicts: [{ verdict: "merge", merged_text: mergedText }],
        }),
    });

    assert.strictEqual(result.status, "completed");

    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 2, "original + new merged");

    // Old is superseded
    const oldLesson = lessons.find((l) => l.id === "lsn_01");
    assert.ok(oldLesson);
    assert.strictEqual(oldLesson.meta.status, "superseded");

    // New merged record has merged_text as summary
    const newLesson = lessons.find((l) => l.id !== "lsn_01");
    assert.ok(newLesson);
    assert.strictEqual(newLesson.summary, mergedText);
    assert.strictEqual(newLesson.detail, "Detailed error handling with logs.");
    assert.strictEqual(newLesson.meta.status, "active");
    assert.strictEqual(newLesson.meta.supersedes, "lsn_01");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await testBatchedAdjudicationRouting();
  console.log("  ✓ batched adjudication routing (duplicate/supersedes/merge)");
  await testDistinctVerdict();
  console.log("  ✓ distinct verdict creates new lesson");
  await testAdjudicationFailureAfterDeterministicAdd();
  console.log("  ✓ adjudication failure parks batch, deterministic add stays");
  await testNoAdjudicationWithoutModel();
  console.log("  ✓ no adjudication without callAdjudicationModel");
  await testDeterministicNotAdjudicated();
  console.log("  ✓ deterministic candidate not adjudicated");
  await testAdjudicationBatchSplitting();
  console.log("  ✓ adjudication batch splitting");
  await testMergeVerdictTextRouting();
  console.log("  ✓ merge verdict text routing");

  console.log("\n✅ All adjudication wiring tests passed!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
