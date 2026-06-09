/**
 * T4 — Deterministic ADD path (zero-model happy path) tests.
 *
 * Covers:
 *  - No-collision lesson added with code-filled id/timestamps, no model call
 *  - No-collision preference / decision / domain deterministic add
 *  - Shortlist collision candidate NOT deterministically added (stays staged)
 *  - Crash between candidates: first committed, second stays staged
 *  - Multiple no-collision candidates: all committed atomically per-candidate
 *  - Sqlite observable after each deterministic add
 *
 * Run: npx tsx test/test_deterministic_add.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runReconciliation, splitByShortlist, buildDeterministicPlan } from "../consolidation/reconcile.js";
import { writeStaging, listStagingFiles, readStaging } from "../consolidation/staging.js";
import { parseLessonsFile, parsePreferencesFile, parseDecisionsFile, parseDomainFile } from "../storage/markdown.js";
import { openIndex, getIndexCounts } from "../storage/sqlite.js";
import { shortlist } from "../consolidation/shortlist.js";
import type { ShortlistCandidate, ShortlistRecord } from "../consolidation/shortlist.js";
import type { StagingFile, Lesson, Preference, Decision, DomainFact } from "../types.js";

console.log("Running test_deterministic_add...");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LessonC = StagingFile["candidates"]["lessons"][number];
type PreferenceC = StagingFile["candidates"]["preferences"][number];
type DecisionC = StagingFile["candidates"]["decisions"][number];
type DomainC = StagingFile["candidates"]["domain"][number];

function lessonCandidate(summary: string, detail: string, scope = "testproj", triggers?: any[]): LessonC {
  return {
    summary,
    detail,
    scope_suggestion: scope,
    triggers: triggers ?? [{ type: "topic" as const, value: "testing" }],
    source_evidence: { discussion_note_ids: [1] },
  };
}

function preferenceCandidate(text: string): PreferenceC {
  return { text, source_evidence: { discussion_note_ids: [1] } };
}

function decisionCandidate(summary: string, detail: string): DecisionC {
  return { summary, detail, source_evidence: { discussion_note_ids: [1] } };
}

function domainCandidate(summary: string, detail: string): DomainC {
  return { summary, detail, source_evidence: { discussion_note_ids: [1] } };
}

function setupStaging(root: string, mem: string, sessionId: string, candidates: {
  lessons?: LessonC[];
  preferences?: PreferenceC[];
  decisions?: DecisionC[];
  domain?: DomainC[];
}) {
  fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
  for (const name of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) {
    if (!fs.existsSync(path.join(mem, name))) {
      fs.writeFileSync(path.join(mem, name), "", "utf8");
    }
  }
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

function makeMemoryPaths(root: string, mem: string) {
  return { projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem };
}

function localProjectScope(projectRoot: string): string {
  const basename = path.basename(projectRoot);
  return basename.startsWith('.') ? basename.slice(1) : basename;
}

function stagingCount(mem: string): number {
  return listStagingFiles(mem).length;
}

// ---------------------------------------------------------------------------
// Test: unit — splitByShortlist correctly separates empty/full shortlist
// ---------------------------------------------------------------------------

{
  // Existing memory has a lesson about JWT
  const existing = {
    lessons: [{
      id: "lsn_01", summary: "Use JWT for auth", detail: "Always use JWT.",
      meta: { project_scope: "testproj", status: "active" as const, session_level: false,
        reinforcement_count: 1, last_seen_at: null, source_session: "s0",
        created_at: "2026-01-01T00:00:00.000Z", supersedes: null, triggers: [] },
    }],
    preferences: [] as Preference[],
    decisions: [] as Decision[],
    domain: [] as DomainFact[],
  };

  const remaining = {
    lessons: [{
      ref: "s1:lessons:1", session_id: "s1", produced_at: "2026-06-01T00:00:00.000Z",
      category: "lessons" as const, index: 1,
      candidate: lessonCandidate("Use JWT for auth", "Always use JWT.", "testproj"),
    }, {
      ref: "s1:lessons:2", session_id: "s1", produced_at: "2026-06-01T00:00:00.000Z",
      category: "lessons" as const, index: 2,
      candidate: lessonCandidate("Banana pancakes recipe", "Mix flour eggs and banana.", "testproj"),
    }],
    preferences: [],
    decisions: [],
    domain: [],
  };

  const split = splitByShortlist(remaining, existing, "testproj");
  assert.strictEqual(split.deterministic.lessons.length, 1, "different-topic lesson should be deterministic");
  assert.strictEqual(split.deterministic.lessons[0].ref, "s1:lessons:2");
  assert.strictEqual(split.collision.lessons.length, 1, "JWT-similar lesson should be collision");
  assert.strictEqual(split.collision.lessons[0].ref, "s1:lessons:1");
}

console.log("splitByShortlist unit test passed");

// ---------------------------------------------------------------------------
// Test: buildDeterministicPlan produces correct add actions
// ---------------------------------------------------------------------------

{
  const candidates = {
    lessons: [{
      ref: "s1:lessons:1", session_id: "s1", produced_at: "2026-01-01T00:00:00.000Z",
      category: "lessons" as const, index: 1,
      candidate: lessonCandidate("Test lesson", "Test detail.", "p", [{ type: "topic", value: "test" }]),
    }],
    preferences: [{
      ref: "s1:preferences:1", session_id: "s1", produced_at: "2026-01-01T00:00:00.000Z",
      category: "preferences" as const, index: 1,
      candidate: preferenceCandidate("Use tabs"),
    }],
    decisions: [],
    domain: [],
  };

  const plan = buildDeterministicPlan(candidates);
  assert.strictEqual(plan.lessons.length, 1);
  assert.strictEqual(plan.lessons[0].action, "add");
  assert.strictEqual(plan.lessons[0].candidate_refs[0], "s1:lessons:1");
  assert.strictEqual(plan.lessons[0].summary, "Test lesson");
  assert.strictEqual(plan.lessons[0].triggers.length, 1);

  assert.strictEqual(plan.preferences.length, 1);
  assert.strictEqual(plan.preferences[0].action, "add");
  assert.strictEqual(plan.preferences[0].text, "Use tabs");
}

console.log("buildDeterministicPlan unit test passed");

// ---------------------------------------------------------------------------
// Test: no-collision lesson — deterministic add, zero model calls
// ---------------------------------------------------------------------------

async function testNoCollisionLessonDeterministicAdd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    lessons: [lessonCandidate("Always write tests first", "Follow TDD principles.", "testproj")],
  });

  const db = openIndex(dbPath);
  let modelCalled = false;

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined, // we'll check incremental sqlite
      callCarefulModel: undefined,   // ZERO model
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Should complete successfully
    assert.strictEqual(result.status, "completed", `Expected completed, got ${result.status}`);
    assert.strictEqual(result.llmCalled, false, "Model should NOT be called");

    // Markdown should have the new lesson
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "One lesson should be added");
    assert.strictEqual(lessons[0].summary, "Always write tests first");
    assert.strictEqual(lessons[0].detail, "Follow TDD principles.");
    assert.strictEqual(lessons[0].meta.project_scope, "testproj");
    assert.strictEqual(lessons[0].meta.status, "active");
    assert.strictEqual(lessons[0].meta.session_level, false);
    assert.strictEqual(lessons[0].meta.reinforcement_count, 1);
    assert.strictEqual(lessons[0].meta.last_seen_at, null);
    assert.strictEqual(lessons[0].meta.source_session, "s1");
    assert.strictEqual(lessons[0].meta.supersedes, null);
    assert.ok(lessons[0].meta.triggers.length >= 1);
    assert.ok(lessons[0].id.startsWith("lsn_"));

    // Sqlite should have the lesson (incremental insert)
    const counts = getIndexCounts(db);
    assert.strictEqual(counts.lessons, 1, "Sqlite should have 1 lesson");

    // Staging should be consumed
    assert.strictEqual(stagingCount(mem), 0, "Staging should be empty after consumption");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: no-collision preference — deterministic add
// ---------------------------------------------------------------------------

async function testNoCollisionPreferenceDeterministicAdd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    preferences: [preferenceCandidate("Use 2-space indentation")],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.llmCalled, false);

    const prefs = parsePreferencesFile(path.join(mem, "preferences.md"));
    assert.strictEqual(prefs.length, 1);
    assert.strictEqual(prefs[0].text, "Use 2-space indentation");
    assert.strictEqual(prefs[0].scope, localProjectScope(root));
    assert.strictEqual(prefs[0].source_session, "s1");
    assert.ok(prefs[0].id.startsWith("prf_"));

    const counts = getIndexCounts(db);
    assert.strictEqual(counts.preferences, 1);
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: no-collision decision — deterministic add
// ---------------------------------------------------------------------------

async function testNoCollisionDecisionDeterministicAdd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    decisions: [decisionCandidate("Use PostgreSQL", "Primary database is PostgreSQL.")],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.llmCalled, false);

    const decs = parseDecisionsFile(path.join(mem, "decisions.md"));
    assert.strictEqual(decs.length, 1);
    assert.strictEqual(decs[0].summary, "Use PostgreSQL");
    assert.strictEqual(decs[0].scope, localProjectScope(root));
    assert.ok(decs[0].id.startsWith("dec_"));

    const counts = getIndexCounts(db);
    assert.strictEqual(counts.decisions, 1);
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: no-collision domain — deterministic add
// ---------------------------------------------------------------------------

async function testNoCollisionDomainDeterministicAdd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    domain: [domainCandidate("API rate limit", "100 req/min enforced by gateway.")],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.llmCalled, false);

    const doms = parseDomainFile(path.join(mem, "domain.md"));
    assert.strictEqual(doms.length, 1);
    assert.strictEqual(doms[0].summary, "API rate limit");
    assert.ok(doms[0].id.startsWith("dom_"));

    const counts = getIndexCounts(db);
    assert.strictEqual(counts.domainFacts, 1);
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: shortlist collision candidate NOT deterministically added (stays staged, zero-model)
// ---------------------------------------------------------------------------

async function testCollisionCandidateStaysStagedWhenNoModel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  // Pre-populate with an existing lesson so the candidate will shortlist-match
  const existingLesson = `## lsn_01 — Use JWT for authentication

<!-- meta:
project_scope: testproj
status: active
session_level: false
reinforcement_count: 1
last_seen_at: null
source_session: s0
created_at: 2026-01-01T00:00:00.000Z
supersedes: null
triggers: []
-->

Always use JWT tokens for API endpoints.
`;
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "lessons.md"), existingLesson, "utf8");
  fs.writeFileSync(path.join(mem, "preferences.md"), "", "utf8");
  fs.writeFileSync(path.join(mem, "decisions.md"), "", "utf8");
  fs.writeFileSync(path.join(mem, "domain.md"), "", "utf8");

  setupStaging(root, mem, "s1", {
    lessons: [lessonCandidate("Use JWT for authentication", "JWT tokens secure API.", "testproj")],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined, // no model available
    });

    // Should complete (or skip) — collision candidate stays staged
    // No new lesson added because shortlist is non-empty and no model to adjudicate
    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1, "Only the original lesson should exist");
    assert.strictEqual(lessons[0].id, "lsn_01");

    // Staging should still have the candidate
    assert.strictEqual(stagingCount(mem), 1, "Collision candidate should remain staged");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: crash between candidates — first committed, second staged
// ---------------------------------------------------------------------------

async function testCrashBetweenCandidatesPreservesFirst() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    lessons: [
      lessonCandidate("Lesson Alpha", "First deterministic add.", "testproj"),
      lessonCandidate("Lesson Beta", "Second deterministic add.", "testproj"),
    ],
  });

  const db = openIndex(dbPath);
  let addCount = 0;

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
      afterDeterministicAddForTest: (ref) => {
        addCount += 1;
        if (addCount >= 1) {
          // Simulate crash after first commit
          throw new Error("simulated crash after first deterministic add");
        }
      },
    });

    // Should have failed
    assert.strictEqual(result.status, "failed");
  } catch {
    // The throw from the hook propagates through runReconciliation
  }

  // First lesson should be in markdown
  const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
  assert.strictEqual(lessons.length, 1, "First lesson should be committed");
  assert.strictEqual(lessons[0].summary, "Lesson Alpha");

  // Sqlite should have first lesson
  const counts = getIndexCounts(db);
  assert.strictEqual(counts.lessons, 1, "Sqlite should have first lesson only");

  // Both candidates remain staged (cleanup didn't run due to early failure)
  // First candidate is duplicated in both markdown and staging — next reconciliation
  // will detect it as exact duplicate and bypass.
  const stagingFiles = listStagingFiles(mem);
  assert.strictEqual(stagingFiles.length, 1, "Staging should still have the session file");
  const stagingData = readStaging(stagingFiles[0]);
  assert.ok(stagingData, "Staging file should be readable");
  // Both candidates remain staged (staging cleanup was bypassed)
  const stagedLessons = stagingData!.candidates.lessons;
  assert.strictEqual(stagedLessons.length, 2, "Both lessons should remain staged (no cleanup on failure)");
  // Verify Lesson Beta is still staged as the second candidate
  assert.strictEqual(stagedLessons[1].summary, "Lesson Beta",
    "Second lesson should remain staged");

  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test: multiple no-collision candidates across categories — all committed
// ---------------------------------------------------------------------------

async function testMultipleNoCollisionAllCategories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    lessons: [lessonCandidate("Lesson One", "Detail one.", "testproj")],
    preferences: [preferenceCandidate("Use 2-space indentation")],
    decisions: [decisionCandidate("Use PostgreSQL", "Primary database.")],
    domain: [domainCandidate("API rate limit", "100 req/min.")],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.llmCalled, false);

    // All categories should have one record
    assert.strictEqual(parseLessonsFile(path.join(mem, "lessons.md")).length, 1);
    assert.strictEqual(parsePreferencesFile(path.join(mem, "preferences.md")).length, 1);
    assert.strictEqual(parseDecisionsFile(path.join(mem, "decisions.md")).length, 1);
    assert.strictEqual(parseDomainFile(path.join(mem, "domain.md")).length, 1);

    const counts = getIndexCounts(db);
    assert.strictEqual(counts.lessons, 1);
    assert.strictEqual(counts.preferences, 1);
    assert.strictEqual(counts.decisions, 1);
    assert.strictEqual(counts.domainFacts, 1);

    assert.strictEqual(stagingCount(mem), 0, "All staging consumed");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: deterministic add with model available still bypasses model for no-collision candidate
// ---------------------------------------------------------------------------

async function testModelAvailableStillBypassesModelForNoCollision() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    domain: [domainCandidate("Use Redis", "For caching.")],
  });

  const db = openIndex(dbPath);
  let modelCalled = false;

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: async (_system, _user) => {
        modelCalled = true;
        return JSON.stringify({
          lessons: [],
          preferences: [],
          decisions: [],
          domain: [{ action: "add", candidate_refs: ["s1:domain:1"], summary: "Use Redis (model)", detail: "For caching model." }],
        });
      },
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.llmCalled, false);
    assert.strictEqual(modelCalled, false, "Model should not be called for no-collision deterministic add");

    const doms = parseDomainFile(path.join(mem, "domain.md"));
    assert.strictEqual(doms.length, 1);
    assert.strictEqual(doms[0].summary, "Use Redis");
    assert.strictEqual(stagingCount(mem), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: lesson metadata is correctly filled (scope_suggestion, triggers)
// ---------------------------------------------------------------------------

async function testLessonMetadataDeterministicFill() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-det-"));
  const mem = path.join(root, ".pi", "memory");
  const dbPath = path.join(mem, "index.db");

  setupStaging(root, mem, "s1", {
    lessons: [lessonCandidate("Custom scope lesson", "Detail.", "customscope", [
      { type: "path", value: "src/auth.ts" },
      { type: "tool", value: "edit", pattern: "*.ts" },
    ])],
  });

  const db = openIndex(dbPath);

  try {
    const result = await runReconciliation(makeMemoryPaths(root, mem), db, {
      rebuildIndex: () => undefined,
      callCarefulModel: undefined,
    });

    assert.strictEqual(result.status, "completed");

    const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
    assert.strictEqual(lessons.length, 1);
    const meta = lessons[0].meta;
    assert.strictEqual(meta.project_scope, "customscope");
    assert.strictEqual(meta.reinforcement_count, 1);
    assert.strictEqual(meta.last_seen_at, null);
    assert.strictEqual(meta.session_level, false);
    assert.strictEqual(meta.source_session, "s1");
    assert.ok(meta.created_at.startsWith("2026-06-10"));
    assert.strictEqual(meta.triggers.length, 2);
    assert.strictEqual(meta.triggers[0].type, "path");
    assert.strictEqual(meta.triggers[1].type, "tool");
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await testNoCollisionLessonDeterministicAdd();
  console.log("  ✓ no-collision lesson deterministic add");
  await testNoCollisionPreferenceDeterministicAdd();
  console.log("  ✓ no-collision preference deterministic add");
  await testNoCollisionDecisionDeterministicAdd();
  console.log("  ✓ no-collision decision deterministic add");
  await testNoCollisionDomainDeterministicAdd();
  console.log("  ✓ no-collision domain deterministic add");
  await testCollisionCandidateStaysStagedWhenNoModel();
  console.log("  ✓ collision candidate stays staged (no model)");
  await testCrashBetweenCandidatesPreservesFirst();
  console.log("  ✓ crash between candidates preserves first");
  await testMultipleNoCollisionAllCategories();
  console.log("  ✓ multiple no-collision across categories");
  await testModelAvailableStillBypassesModelForNoCollision();
  console.log("  ✓ model available bypassed for no-collision deterministic add");
  await testLessonMetadataDeterministicFill();
  console.log("  ✓ lesson metadata deterministic fill");
  console.log("\n✅ All deterministic add tests passed!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
