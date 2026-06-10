/**
 * T5 — Verdict-apply primitives unit tests.
 *
 * Covers:
 *  - applyDuplicateLesson: reinforcement bump, last_seen_at, no mutation
 *  - applySupersedesLesson: old record superseded, new active created, pointer
 *  - applyMergeLessons: parents superseded, new active, comma-joined pointer
 *  - Determinism boundary: no Date.now / random, same inputs -> same outputs
 *  - Markdown serialize → parse round-trip proving parents remain on disk
 *
 * Run: npx tsx test/test_verdict_apply.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyDuplicateLesson,
  applySupersedesLesson,
  applyMergeLessons,
  cloneLesson,
  cloneLessons,
  cloneTriggers,
  SUPERSEDES_SEPARATOR,
} from "../consolidation/verdict-apply.js";
import {
  parseLessonsFile,
  serializeLessonsFile,
  rewriteLessonsFile,
} from "../storage/markdown.js";
import type { Lesson, LessonMeta, Trigger } from "../types.js";

console.log("Running test_verdict_apply...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLesson(overrides: { id: string } & Partial<Omit<Lesson, "meta">> & { meta?: Partial<LessonMeta> }): Lesson {
  const baseMeta: LessonMeta = {
    project_scope: "testproj",
    status: "active",
    session_level: false,
    reinforcement_count: 1,
    last_seen_at: null,
    source_session: "s0",
    created_at: "2026-01-01T00:00:00.000Z",
    supersedes: null,
    triggers: [],
  };
  const mergedMeta: LessonMeta = { ...baseMeta, ...(overrides.meta ?? {}) };
  return {
    id: overrides.id,
    summary: overrides.summary ?? "Default summary",
    detail: overrides.detail ?? "Default detail.",
    meta: mergedMeta,
  };
}

function newRecordFields(
  id: string,
  overrides?: Partial<Omit<Lesson, "meta"> & { meta: Partial<Omit<LessonMeta, "status" | "last_seen_at" | "supersedes">> }>,
) {
  const defaults = {
    id,
    summary: "New lesson",
    detail: "New detail.",
    meta: {
      project_scope: "testproj",
      session_level: false,
      reinforcement_count: 1,
      source_session: "s1",
      created_at: "2026-06-10T00:00:00.000Z",
      triggers: [] as Trigger[],
    },
  };
  if (!overrides) return defaults;
  return {
    ...defaults,
    ...overrides,
    meta: {
      ...defaults.meta,
      ...(overrides.meta ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// applyDuplicateLesson
// ---------------------------------------------------------------------------

{
  console.log("applyDuplicateLesson tests...");

  const original: Lesson[] = [
    makeLesson({ id: "lsn_01", summary: "A" }),
    makeLesson({ id: "lsn_02", summary: "B" }),
  ];

  // --- basic duplicate bump ---
  {
    const result = applyDuplicateLesson(original, {
      target: original[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
    });

    assert.strictEqual(result.length, 2, "duplicate should not change array length");
    assert.strictEqual(result[0].id, "lsn_01");
    assert.strictEqual(result[0].meta.reinforcement_count, 2, "reinforcement_count bumped by 1");
    assert.strictEqual(result[0].meta.last_seen_at, "2026-06-10T12:00:00.000Z");
    assert.strictEqual(result[0].meta.status, "active", "status unchanged");
    // Unrelated lesson unchanged
    assert.strictEqual(result[1].id, "lsn_02");
    assert.strictEqual(result[1].meta.reinforcement_count, 1);
    assert.strictEqual(result[1].meta.last_seen_at, null);
  }

  // --- bumpBy parameter ---
  {
    const result = applyDuplicateLesson(original, {
      target: original[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      bumpBy: 3,
    });
    assert.strictEqual(result[0].meta.reinforcement_count, 4, "bumped by 3");
  }

  // --- bumpBy 0 (no change to count) ---
  {
    const result = applyDuplicateLesson(original, {
      target: original[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      bumpBy: 0,
    });
    assert.strictEqual(result[0].meta.reinforcement_count, 1, "count unchanged with bumpBy=0");
    assert.strictEqual(result[0].meta.last_seen_at, "2026-06-10T12:00:00.000Z", "last_seen_at still updated");
  }

  // --- negative bumpBy throws ---
  {
    assert.throws(() => {
      applyDuplicateLesson(original, {
        target: original[0],
        lastSeenAt: "2026-06-10T12:00:00.000Z",
        bumpBy: -1,
      });
    }, /bumpBy must be non-negative/);
  }

  // --- target not found returns unchanged array (new array, same content) ---
  {
    const ghost = makeLesson({ id: "lsn_99", summary: "Ghost" });
    const result = applyDuplicateLesson(original, {
      target: ghost,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
    });
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result, original);
    // But not same reference
    assert.notStrictEqual(result, original);
  }

  // --- does NOT mutate input ---
  {
    const input = cloneLessons(original);
    const result = applyDuplicateLesson(input, {
      target: input[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
    });
    assert.notStrictEqual(result, input, "result is a new array");
    assert.notStrictEqual(result[0], input[0], "updated lesson is a new object");
    assert.strictEqual(input[0].meta.reinforcement_count, 1, "original unchanged");
    assert.strictEqual(input[0].meta.last_seen_at, null, "original last_seen_at unchanged");
  }

  console.log("  ✓ duplicate tests passed\n");
}

// ---------------------------------------------------------------------------
// applySupersedesLesson
// ---------------------------------------------------------------------------

{
  console.log("applySupersedesLesson tests...");

  const original: Lesson[] = [
    makeLesson({ id: "lsn_01", summary: "Old lesson", meta: { reinforcement_count: 3 } }),
    makeLesson({ id: "lsn_02", summary: "Unrelated" }),
  ];

  const newRec = newRecordFields("lsn_03", {
    summary: "New superseding lesson",
    detail: "Better version.",
    meta: {
      project_scope: "testproj",
      reinforcement_count: 1,
      source_session: "s1",
      created_at: "2026-06-10T00:00:00.000Z",
      triggers: [{ type: "topic" as const, value: "testing" }],
    },
  });

  // --- basic supersede ---
  {
    const result = applySupersedesLesson(original, {
      target: original[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });

    assert.strictEqual(result.length, 3, "supersede adds one record (old + new + unrelated)");
    // Old record is now superseded
    const old = result.find((l) => l.id === "lsn_01")!;
    assert.ok(old, "old record still present");
    assert.strictEqual(old.meta.status, "superseded");
    assert.strictEqual(old.meta.last_seen_at, "2026-06-10T12:00:00.000Z");
    assert.strictEqual(old.meta.reinforcement_count, 3, "other fields preserved");
    // New active record
    const neu = result.find((l) => l.id === "lsn_03")!;
    assert.ok(neu, "new record present");
    assert.strictEqual(neu.meta.status, "active");
    assert.strictEqual(neu.meta.supersedes, "lsn_01", "supersedes points to old id");
    assert.strictEqual(neu.meta.last_seen_at, null);
    assert.strictEqual(neu.summary, "New superseding lesson");
    assert.strictEqual(neu.meta.triggers.length, 1);
    // Unrelated unchanged
    const unrelated = result.find((l) => l.id === "lsn_02")!;
    assert.strictEqual(unrelated.meta.status, "active");
  }

  // --- does NOT mutate input ---
  {
    const input = cloneLessons(original);
    applySupersedesLesson(input, {
      target: input[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });
    assert.strictEqual(input[0].meta.status, "active", "original target unchanged");
    assert.strictEqual(input[0].meta.last_seen_at, null);
    assert.strictEqual(input.length, 2, "input length unchanged");
  }

  // --- supersede with non-existent target: silently appends new record ---
  {
    const ghost = makeLesson({ id: "lsn_99", summary: "Ghost" });
    const result = applySupersedesLesson(cloneLessons(original), {
      target: ghost,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });
    assert.strictEqual(result.length, 3, "new record appended even if target not found");
    // All originals still active
    assert.strictEqual(result[0].meta.status, "active");
    assert.strictEqual(result[1].meta.status, "active");
  }

  console.log("  ✓ supersedes tests passed\n");
}

// ---------------------------------------------------------------------------
// applyMergeLessons
// ---------------------------------------------------------------------------

{
  console.log("applyMergeLessons tests...");

  const original: Lesson[] = [
    makeLesson({ id: "lsn_01", summary: "Parent A", meta: { reinforcement_count: 2 } }),
    makeLesson({ id: "lsn_02", summary: "Parent B", meta: { reinforcement_count: 1 } }),
    makeLesson({ id: "lsn_03", summary: "Unrelated C" }),
  ];

  const newRec = newRecordFields("lsn_04", {
    summary: "Merged lesson",
    detail: "Combined from parents.",
    meta: {
      project_scope: "testproj",
      reinforcement_count: 1,
      source_session: "s1",
      created_at: "2026-06-10T00:00:00.000Z",
      triggers: [{ type: "path" as const, value: "src/index.ts" }],
    },
  });

  // --- basic merge ---
  {
    const parents = [original[0], original[1]];
    const result = applyMergeLessons(original, {
      parents,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });

    assert.strictEqual(result.length, 4, "merge: 2 parents + 1 unrelated + 1 new = 4");
    // Both parents superseded
    const pA = result.find((l) => l.id === "lsn_01")!;
    assert.ok(pA);
    assert.strictEqual(pA.meta.status, "superseded");
    assert.strictEqual(pA.meta.last_seen_at, "2026-06-10T12:00:00.000Z");
    assert.strictEqual(pA.meta.reinforcement_count, 2, "other fields preserved");

    const pB = result.find((l) => l.id === "lsn_02")!;
    assert.ok(pB);
    assert.strictEqual(pB.meta.status, "superseded");

    // Unrelated unchanged
    const unrel = result.find((l) => l.id === "lsn_03")!;
    assert.strictEqual(unrel.meta.status, "active");

    // New active record
    const neu = result.find((l) => l.id === "lsn_04")!;
    assert.ok(neu);
    assert.strictEqual(neu.meta.status, "active");
    assert.strictEqual(neu.meta.last_seen_at, null);
    assert.strictEqual(neu.summary, "Merged lesson");
    // supersedes contains sorted comma-joined parent ids
    assert.strictEqual(neu.meta.supersedes, "lsn_01,lsn_02");
  }

  // --- merge with a single parent (degenerate) ---
  {
    const result = applyMergeLessons(original, {
      parents: [original[0]],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRecordFields("lsn_05"),
    });
    assert.strictEqual(result.length, 4, "single-parent merge still creates new record");
    const neu = result.find((l) => l.id === "lsn_05")!;
    assert.strictEqual(neu.meta.supersedes, "lsn_01", "single parent id, no trailing comma");
    const pA = result.find((l) => l.id === "lsn_01")!;
    assert.strictEqual(pA.meta.status, "superseded");
  }

  // --- merge with empty parents array (edge) ---
  {
    const result = applyMergeLessons(original, {
      parents: [],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRecordFields("lsn_06"),
    });
    assert.strictEqual(result.length, 4, "empty parents: just appends new record");
    const neu = result.find((l) => l.id === "lsn_06")!;
    assert.strictEqual(neu.meta.supersedes, "", "empty supersedes string");
    // All originals unchanged
    for (const l of result.filter((x) => x.id !== "lsn_06")) {
      assert.strictEqual(l.meta.status, "active");
    }
  }

  // --- merge with parents not in the array ---
  {
    const ghost = makeLesson({ id: "lsn_99", summary: "Ghost" });
    const result = applyMergeLessons(original, {
      parents: [ghost],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRecordFields("lsn_07"),
    });
    assert.strictEqual(result.length, 4, "ghost parent: just appends new record");
    const neu = result.find((l) => l.id === "lsn_07")!;
    assert.strictEqual(neu.meta.supersedes, "lsn_99", "ghost id still recorded in supersedes");
  }

  // --- does NOT mutate input ---
  {
    const input = cloneLessons(original);
    applyMergeLessons(input, {
      parents: [input[0]],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });
    assert.strictEqual(input[0].meta.status, "active", "original parent unchanged");
    assert.strictEqual(input[0].meta.last_seen_at, null);
    assert.strictEqual(input.length, 3, "input length unchanged");
  }

  // --- deterministic id ordering in supersedes ---
  {
    // Reverse order of parents should still produce sorted ids
    const parents = [original[1], original[0]]; // lsn_02, lsn_01
    const result = applyMergeLessons(original, {
      parents,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });
    const neu = result.find((l) => l.id === "lsn_04")!;
    assert.strictEqual(neu.meta.supersedes, "lsn_01,lsn_02", "supersedes sorted regardless of parent order");
  }

  console.log("  ✓ merge tests passed\n");
}

// ---------------------------------------------------------------------------
// Determinism boundary
// ---------------------------------------------------------------------------

{
  console.log("Determinism boundary tests...");

  const lessons: Lesson[] = [
    makeLesson({ id: "lsn_01" }),
    makeLesson({ id: "lsn_02" }),
  ];

  // --- duplicate: same inputs, same outputs ---
  {
    const a = applyDuplicateLesson(lessons, {
      target: lessons[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      bumpBy: 2,
    });
    const b = applyDuplicateLesson(lessons, {
      target: lessons[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      bumpBy: 2,
    });
    assert.deepStrictEqual(a, b, "duplicate is deterministic");
  }

  // --- supersedes: same inputs, same outputs ---
  {
    const nr = newRecordFields("lsn_03");
    const a = applySupersedesLesson(lessons, {
      target: lessons[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: nr,
    });
    const b = applySupersedesLesson(lessons, {
      target: lessons[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: nr,
    });
    assert.deepStrictEqual(a, b, "supersedes is deterministic");
  }

  // --- merge: same inputs, same outputs ---
  {
    const nr = newRecordFields("lsn_04");
    const parents = [lessons[0], lessons[1]];
    const a = applyMergeLessons(lessons, {
      parents,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: nr,
    });
    const b = applyMergeLessons(lessons, {
      parents,
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: nr,
    });
    assert.deepStrictEqual(a, b, "merge is deterministic");
  }

  // --- verify no hidden non-determinism: call 100x with same params ---
  {
    const nr = newRecordFields("lsn_10", {
      meta: { triggers: [{ type: "topic" as const, value: "test" }] },
    });
    const first = applySupersedesLesson(lessons, {
      target: lessons[0],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: nr,
    });
    for (let i = 0; i < 100; i++) {
      const again = applySupersedesLesson(lessons, {
        target: lessons[0],
        lastSeenAt: "2026-06-10T12:00:00.000Z",
        newRecord: nr,
      });
      assert.deepStrictEqual(again, first, `run ${i} should match first run`);
    }
  }

  console.log("  ✓ determinism tests passed\n");
}

// ---------------------------------------------------------------------------
// Markdown serialize → parse round-trip: parents remain on disk
// ---------------------------------------------------------------------------

{
  console.log("Markdown round-trip test...");

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-va-"));
  const filePath = path.join(tmpdir, "lessons.md");

  try {
    // Create three lessons: two will be parents, one unrelated
    const parent1 = makeLesson({ id: "lsn_01", summary: "Parent One", detail: "First parent.", meta: { reinforcement_count: 2 } });
    const parent2 = makeLesson({ id: "lsn_02", summary: "Parent Two", detail: "Second parent." });
    const unrelated = makeLesson({ id: "lsn_03", summary: "Unrelated" });

    let lessons: Lesson[] = cloneLessons([parent1, parent2, unrelated]);

    // --- Apply merge ---
    const newRec = newRecordFields("lsn_04", {
      summary: "Merged",
      detail: "Combined from parents.",
      meta: {
        project_scope: "testproj",
        reinforcement_count: 1,
        source_session: "s1",
        created_at: "2026-06-10T00:00:00.000Z",
        triggers: [{ type: "topic" as const, value: "testing" }],
      },
    });

    const merged = applyMergeLessons(lessons, {
      parents: [lessons[0], lessons[1]],
      lastSeenAt: "2026-06-10T12:00:00.000Z",
      newRecord: newRec,
    });

    // Write to markdown
    rewriteLessonsFile(filePath, merged);

    // Read back
    const parsed = parseLessonsFile(filePath);
    assert.strictEqual(parsed.length, 4, "all 4 lessons survived round-trip");

    // Parents should be superseded
    const p1 = parsed.find((l) => l.id === "lsn_01")!;
    assert.ok(p1, "parent 1 on disk");
    assert.strictEqual(p1.meta.status, "superseded");
    assert.strictEqual(p1.meta.last_seen_at, "2026-06-10T12:00:00.000Z");
    assert.strictEqual(p1.meta.reinforcement_count, 2);
    assert.strictEqual(p1.summary, "Parent One");
    assert.strictEqual(p1.detail, "First parent.");

    const p2 = parsed.find((l) => l.id === "lsn_02")!;
    assert.ok(p2, "parent 2 on disk");
    assert.strictEqual(p2.meta.status, "superseded");
    assert.strictEqual(p2.summary, "Parent Two");

    // Unrelated unchanged
    const ur = parsed.find((l) => l.id === "lsn_03")!;
    assert.ok(ur, "unrelated on disk");
    assert.strictEqual(ur.meta.status, "active");

    // New merged record active with correct supersedes
    const neu = parsed.find((l) => l.id === "lsn_04")!;
    assert.ok(neu, "merged record on disk");
    assert.strictEqual(neu.meta.status, "active");
    assert.strictEqual(neu.meta.supersedes, "lsn_01,lsn_02");
    assert.strictEqual(neu.summary, "Merged");
    assert.strictEqual(neu.detail, "Combined from parents.");
    assert.strictEqual(neu.meta.triggers.length, 1);

    // Verify the raw markdown file contains "superseded" for parents
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.ok(raw.includes("## lsn_01 — Parent One"), "parent1 heading in markdown");
    assert.ok(raw.includes("status: superseded"), "superseded status in markdown");
    assert.ok(raw.includes("## lsn_02 — Parent Two"), "parent2 heading in markdown");
    assert.ok(raw.includes("## lsn_04 — Merged"), "merged heading in markdown");
    // Comma triggers JSON quoting in YAML scalar, so the raw markdown
    // contains `supersedes: "lsn_01,lsn_02"`.
    assert.ok(
      raw.includes('supersedes: "lsn_01,lsn_02"') || raw.includes("supersedes: lsn_01,lsn_02"),
      "supersedes pointer in markdown",
    );

    console.log("  ✓ markdown round-trip tests passed\n");
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Chain multiple verdicts
// ---------------------------------------------------------------------------

{
  console.log("Chained verdicts test...");

  let lessons: Lesson[] = [
    makeLesson({ id: "lsn_01", summary: "Original", meta: { reinforcement_count: 1 } }),
  ];

  // 1. Duplicate bump
  lessons = applyDuplicateLesson(lessons, {
    target: lessons[0],
    lastSeenAt: "2026-06-10T10:00:00.000Z",
    bumpBy: 2,
  });
  assert.strictEqual(lessons[0].meta.reinforcement_count, 3);
  assert.strictEqual(lessons[0].meta.last_seen_at, "2026-06-10T10:00:00.000Z");
  assert.strictEqual(lessons[0].meta.status, "active");

  // 2. Supersede
  lessons = applySupersedesLesson(lessons, {
    target: lessons[0],
    lastSeenAt: "2026-06-10T11:00:00.000Z",
    newRecord: newRecordFields("lsn_02", {
      summary: "Superseding v2",
      meta: { triggers: [{ type: "topic" as const, value: "v2" }] },
    }),
  });
  assert.strictEqual(lessons.length, 2);
  const old = lessons.find((l) => l.id === "lsn_01")!;
  assert.strictEqual(old.meta.status, "superseded");
  assert.strictEqual(old.meta.last_seen_at, "2026-06-10T11:00:00.000Z");
  const v2 = lessons.find((l) => l.id === "lsn_02")!;
  assert.strictEqual(v2.meta.status, "active");
  assert.strictEqual(v2.meta.supersedes, "lsn_01");
  const v2Trig = v2.meta.triggers[0];
  assert.ok(v2Trig.type === "topic" || v2Trig.type === "path" || v2Trig.type === "filename" || v2Trig.type === "tool");
  assert.strictEqual((v2Trig as { value: string }).value, "v2");

  // 3. Merge v2 with a new parent (single)
  const parent3 = makeLesson({ id: "lsn_03", summary: "Parent3", meta: { reinforcement_count: 1 } });
  lessons = [...lessons, parent3];
  lessons = applyMergeLessons(lessons, {
    parents: [v2, parent3],
    lastSeenAt: "2026-06-10T12:00:00.000Z",
    newRecord: newRecordFields("lsn_04", {
      summary: "Final merged",
      meta: { triggers: [{ type: "path" as const, value: "src/main.ts" }] },
    }),
  });
  assert.strictEqual(lessons.length, 4, "chained: lsn_01, lsn_02, lsn_03, lsn_04");
  const pv2 = lessons.find((l) => l.id === "lsn_02")!;
  assert.strictEqual(pv2.meta.status, "superseded", "v2 now superseded by merge");
  const p3 = lessons.find((l) => l.id === "lsn_03")!;
  assert.strictEqual(p3.meta.status, "superseded", "p3 now superseded");
  const final = lessons.find((l) => l.id === "lsn_04")!;
  assert.strictEqual(final.meta.status, "active");
  assert.strictEqual(final.meta.supersedes, "lsn_02,lsn_03");

  console.log("  ✓ chained verdicts test passed\n");
}

// ---------------------------------------------------------------------------
// Helper exports are correct
// ---------------------------------------------------------------------------

{
  console.log("Helper export tests...");

  const lesson = makeLesson({ id: "lsn_01", meta: { triggers: [{ type: "topic" as const, value: "test" }] } });
  const cloned = cloneLesson(lesson);
  assert.notStrictEqual(cloned, lesson, "cloneLesson returns new object");
  assert.notStrictEqual(cloned.meta, lesson.meta, "cloneLesson clones meta");
  assert.notStrictEqual(cloned.meta.triggers, lesson.meta.triggers, "cloneLesson clones triggers");
  // Modify clone shouldn't affect original
  cloned.meta.triggers[0] = { type: "path", value: "changed" };
  assert.strictEqual((lesson.meta.triggers[0] as { type: string; value: string }).type, "topic");

  const arr = [lesson];
  const clonedArr = cloneLessons(arr);
  assert.notStrictEqual(clonedArr, arr);
  assert.notStrictEqual(clonedArr[0], arr[0]);
  arr[0].meta.status = "archived";
  assert.notStrictEqual(clonedArr[0].meta.status, "archived", "clone was deep");

  console.log("  ✓ helpers export test passed\n");
}

// ---------------------------------------------------------------------------

console.log("✅ All verdict-apply tests passed!\n");
