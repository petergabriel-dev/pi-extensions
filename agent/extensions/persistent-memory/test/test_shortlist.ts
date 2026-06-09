/**
 * Unit tests for consolidation/shortlist.ts
 *
 * Covers:
 *  - Exact duplicate detection (score = 1.0)
 *  - Near-paraphrase with shared nouns (score > threshold)
 *  - No-overlap (empty list)
 *  - Scope filtering (same scope, different scope, absent scope)
 *  - Multiple record types (lesson, preference, decision, domain)
 *  - Edge cases (empty text, maxResults, stemming)
 *
 * Run: npx tsx test/test_shortlist.ts
 */

import assert from "node:assert";
import { shortlist, shortlistWithScores, tokenize, stem, overlapScore } from "../consolidation/shortlist.js";
import type { ShortlistCandidate, ShortlistRecord } from "../consolidation/shortlist.js";

// ---------------------------------------------------------------------------
// Helpers: build fixture records
// ---------------------------------------------------------------------------

function makeLesson(id: string, summary: string, detail: string, scope: string): ShortlistRecord {
  return {
    id,
    summary,
    detail,
    meta: {
      project_scope: scope,
      status: "active",
      session_level: false,
      reinforcement_count: 0,
      last_seen_at: null,
      source_session: "sess-1",
      created_at: "2024-01-01T00:00:00.000Z",
      supersedes: null,
      triggers: [],
    },
  };
}

function makePreference(id: string, text: string, scope: string): ShortlistRecord {
  return {
    id,
    text,
    scope,
    source_session: "sess-1",
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

function makeDecision(id: string, summary: string, detail: string, scope: string): ShortlistRecord {
  return {
    id,
    summary,
    detail,
    scope,
    source_session: "sess-1",
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

function makeDomain(id: string, summary: string, detail: string, scope: string): ShortlistRecord {
  return {
    id,
    summary,
    detail,
    scope,
    source_session: "sess-1",
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

function lessonCandidate(summary: string, detail: string, scope?: string): ShortlistCandidate {
  return { type: "lesson", summary, detail, scope_suggestion: scope };
}

function preferenceCandidate(text: string, scope?: string): ShortlistCandidate {
  return { type: "preference", text, scope };
}

function decisionCandidate(summary: string, detail: string, scope?: string): ShortlistCandidate {
  return { type: "decision", summary, detail, scope };
}

function domainCandidate(summary: string, detail: string, scope?: string): ShortlistCandidate {
  return { type: "domain", summary, detail, scope };
}

// ---------------------------------------------------------------------------
// Test: tokenize
// ---------------------------------------------------------------------------

{
  const tokens = tokenize("Hello World! This is a test.");
  // Note: '.' is in the allowed char set, so "test." stays as one token
  assert.deepStrictEqual(tokens, ["hello", "world", "this", "is", "test."]);
}

{
  const tokens = tokenize("JWT authentication for API endpoints");
  assert.deepStrictEqual(tokens, ["jwt", "authentication", "for", "api", "endpoints"]);
}

{
  const tokens = tokenize("  a  bc def  ");
  // "a" is length 1, filtered out
  assert.deepStrictEqual(tokens, ["bc", "def"]);
}

{
  // Empty string
  const tokens = tokenize("");
  assert.deepStrictEqual(tokens, []);
}

console.log("tokenize tests passed");

// ---------------------------------------------------------------------------
// Test: stem
// ---------------------------------------------------------------------------

{
  assert.strictEqual(stem("running"), "runn");
  assert.strictEqual(stem("tests"), "test");
  assert.strictEqual(stem("authentication"), "authentic");
  assert.strictEqual(stem("endpoints"), "endpoint");
  assert.strictEqual(stem("happily"), "happi");
  // "easy" does not end with a suffix in our list (it ends with "sy", not "ly")
  assert.strictEqual(stem("easy"), "easy");
  assert.strictEqual(stem("easier"), "easi");
  assert.strictEqual(stem("easily"), "easi");
}

// Stem doesn't over-truncate short tokens
{
  assert.strictEqual(stem("go"), "go");       // "es" would leave "g" (len 1), skipped; "s" leaves "g" (len 1), skipped
  assert.strictEqual(stem("is"), "is");       // "s" would leave "i" (len 1), skipped
}

console.log("stem tests passed");

// ---------------------------------------------------------------------------
// Test: overlapScore
// ---------------------------------------------------------------------------

{
  // Identical token sets
  const score = overlapScore(["hello", "world"], ["hello", "world"]);
  assert.strictEqual(score, 1.0);
}

{
  // One subset of the other
  const score = overlapScore(["hello"], ["hello", "world", "foo"]);
  assert.strictEqual(score, 1.0); // all of shorter set in longer set
}

{
  // Partial overlap
  const score = overlapScore(["hello", "world", "foo"], ["hello", "bar", "baz"]);
  assert.strictEqual(score, 1 / 3); // only "hello" overlaps, min is 3
}

{
  // No overlap
  const score = overlapScore(["aaa"], ["bbb"]);
  assert.strictEqual(score, 0);
}

{
  // Empty sets
  const score = overlapScore([], []);
  assert.strictEqual(score, 0);
}

{
  // Stemmed overlap: "running" vs "run"
  const score = overlapScore(["running", "fast"], ["run", "quickly"]);
  // stems: {"runn", "fast"} vs {"run", "quickli"}
  // "runn" != "run" — no overlap
  assert.strictEqual(score, 0);
}

{
  // Stemmed overlap: "tests" vs "testing"
  const score = overlapScore(["tests", "suite"], ["testing", "framework"]);
  // stems: {"test", "suit"} vs {"test", "framework"}
  // intersection = {"test"}, min = 2, score = 0.5
  assert.strictEqual(score, 0.5);
}

console.log("overlapScore tests passed");

// ---------------------------------------------------------------------------
// Test: shortlist — exact duplicate (lesson)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-1", "Use JWT for API authentication", "Always use JWT tokens for securing API endpoints.", "myproject"),
  ];

  const candidate = lessonCandidate(
    "Use JWT for API authentication",
    "Always use JWT tokens for securing API endpoints.",
    "myproject",
  );

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "lsn-1");
  assert.strictEqual(results[0].score, 1.0);
}

console.log("exact duplicate (lesson) passed");

// ---------------------------------------------------------------------------
// Test: shortlist — exact duplicate (preference)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makePreference("prf-1", "Always use 2-space indentation", "myproject"),
  ];

  const candidate = preferenceCandidate("Always use 2-space indentation", "myproject");

  const records = shortlist(candidate, existing);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].id, "prf-1");

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "prf-1");
  assert.strictEqual(results[0].score, 1.0);
}

console.log("exact duplicate (preference) passed");

// ---------------------------------------------------------------------------
// Test: shortlist — exact duplicate (decision)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeDecision("dec-1", "Use PostgreSQL", "Decided to use PostgreSQL as the primary database.", "myproject"),
  ];

  const candidate = decisionCandidate(
    "Use PostgreSQL",
    "Decided to use PostgreSQL as the primary database.",
    "myproject",
  );

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "dec-1");
  assert.strictEqual(results[0].score, 1.0);
}

console.log("exact duplicate (decision) passed");

// ---------------------------------------------------------------------------
// Test: shortlist — exact duplicate (domain)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeDomain("dom-1", "API rate limit is 100 req/min", "The API gateway enforces 100 requests per minute.", "myproject"),
  ];

  const candidate = domainCandidate(
    "API rate limit is 100 req/min",
    "The API gateway enforces 100 requests per minute.",
    "myproject",
  );

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "dom-1");
  assert.strictEqual(results[0].score, 1.0);
}

console.log("exact duplicate (domain) passed");

// ---------------------------------------------------------------------------
// Test: near-paraphrase with shared nouns
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-2", "Authentication is done via JWT", "We use JWT tokens for authenticating users.", "myproject"),
  ];

  const candidate = lessonCandidate(
    "The API uses JWT tokens for authentication",
    "JWT-based authentication is employed across all endpoints.",
    "myproject",
  );

  const results = shortlistWithScores(candidate, existing);
  // Should find the near-match because shared tokens: jwt, authentic/token/...
  assert.strictEqual(results.length, 1, "Expected 1 near-match result");
  assert.strictEqual(results[0].record.id, "lsn-2");
  // Score should be > 0.15 and < 1.0
  assert.ok(results[0].score >= 0.15, `Score ${results[0].score} should be >= 0.15`);
  assert.ok(results[0].score < 1.0, `Score ${results[0].score} should be < 1.0 (not exact)`);
}

console.log("near-paraphrase (shared nouns) passed");

// ---------------------------------------------------------------------------
// Test: no overlap
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-3", "Always deploy on Fridays", "Production deployments happen on Fridays.", "myproject"),
  ];

  const candidate = lessonCandidate(
    "Use JWT for API authentication",
    "JWT tokens secure the API endpoints.",
    "myproject",
  );

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 0);
}

console.log("no overlap passed");

// ---------------------------------------------------------------------------
// Test: scope filtering — same scope matches
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-scope-1", "Use JWT", "JWT auth.", "projectA"),
    makeLesson("lsn-scope-2", "Use JWT", "JWT auth.", "projectB"),
  ];

  const candidate = lessonCandidate("Use JWT", "JWT auth.", "projectA");
  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "lsn-scope-1");
}

console.log("scope filtering (same scope) passed");

// ---------------------------------------------------------------------------
// Test: scope filtering — different scope excluded
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makePreference("prf-scope-1", "Use tabs", "projectA"),
    makePreference("prf-scope-2", "Use tabs", "projectB"),
  ];

  const candidate = preferenceCandidate("Use tabs", "projectB");
  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "prf-scope-2");
}

console.log("scope filtering (different scope excluded) passed");

// ---------------------------------------------------------------------------
// Test: scope filtering — candidate scope absent (includes all)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeDecision("dec-scope-1", "Use React", "Frontend uses React.", "projectA"),
    makeDecision("dec-scope-2", "Use React", "Frontend uses React.", "projectB"),
  ];

  // No scope provided
  const candidate = decisionCandidate("Use React", "Frontend uses React.");
  const results = shortlistWithScores(candidate, existing);
  // Both should be included since candidate scope is absent
  assert.strictEqual(results.length, 2);
  const ids = results.map((r) => r.record.id).sort();
  assert.deepStrictEqual(ids, ["dec-scope-1", "dec-scope-2"]);
}

console.log("scope filtering (candidate scope absent) passed");

// ---------------------------------------------------------------------------
// Test: maxResults limit
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-m-1", "JWT authentication setup", "Details about JWT.", "p"),
    makeLesson("lsn-m-2", "JWT token refresh flow", "Details about refresh.", "p"),
    makeLesson("lsn-m-3", "JWT best practices", "Best practices for JWT.", "p"),
  ];

  const candidate = lessonCandidate("JWT authentication and tokens", "How to use JWT securely.", "p");
  const results = shortlistWithScores(candidate, existing, { maxResults: 2 });
  assert.strictEqual(results.length, 2, "Should return at most 2 results");
}

console.log("maxResults limit passed");

// ---------------------------------------------------------------------------
// Test: custom minScore threshold
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-th-1", "JWT authentication setup", "Details about JWT tokens and auth.", "p"),
    makeLesson("lsn-th-2", "Completely unrelated topic", "Something else entirely different.", "p"),
  ];

  const candidate = lessonCandidate("JWT authentication and tokens", "How to use JWT.", "p");

  // Low threshold — both could match (but "unrelated" likely won't)
  const generous = shortlist(candidate, existing, { minScore: 0.0 });
  const matchedIds = generous.map((r) => r.id);
  // lsn-th-1 should always be included; lsn-th-2 likely excluded even at 0.0
  assert.ok(matchedIds.includes("lsn-th-1"), "lsn-th-1 should match");

  // High threshold — only exact matches pass
  const strict = shortlist(candidate, existing, { minScore: 0.9 });
  // lsn-th-1 shouldn't be an exact match
  assert.strictEqual(strict.length, 0, "No results at strict threshold");
}

console.log("custom minScore threshold passed");

// ---------------------------------------------------------------------------
// Test: mixed record types — only same type considered
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-mix", "JWT authentication", "Use JWT.", "p"),
    makePreference("prf-mix", "JWT authentication", "p"),
  ];

  const candidate = lessonCandidate("JWT authentication", "Use JWT.", "p");
  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1, "Only lesson records should match");
  assert.strictEqual(results[0].record.id, "lsn-mix");
}

console.log("mixed types — only same type passed");

// ---------------------------------------------------------------------------
// Test: empty candidate text
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-empty", "Something", "Else", "p"),
  ];

  // Candidate with very short tokens (filtered out)
  const candidate = lessonCandidate("a", "b", "p"); // tokens: none (length < 2)
  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 0);
}

console.log("empty candidate text passed");

// ---------------------------------------------------------------------------
// Test: deterministic ordering (by score, then id)
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-z", "JWT setup", "Details.", "p"),
    makeLesson("lsn-a", "JWT auth tokens", "More about JWT.", "p"),
  ];

  const candidate = lessonCandidate("JWT authentication", "Using JWT.", "p");

  // Run twice, expect same order
  const r1 = shortlist(candidate, existing);
  const r2 = shortlist(candidate, existing);
  assert.deepStrictEqual(
    r1.map((r) => r.id),
    r2.map((r) => r.id),
    "Results should be deterministic",
  );
}

console.log("deterministic ordering passed");

// ---------------------------------------------------------------------------
// Test: stem overlap prevents missing near-match
// ---------------------------------------------------------------------------

{
  // "initialize" vs "initialization" — should stem to same root
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-stem", "Database initialization process", "How to initialize the database.", "p"),
  ];

  const candidate = lessonCandidate(
    "Initialize the database",
    "Steps to initialize the database properly.",
    "p",
  );

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1, "Stemming should connect initialize/initialization");
  assert.ok(results[0].score >= 0.15, `Score ${results[0].score} >= 0.15`);
}

console.log("stem overlap prevents missing near-match passed");

// ---------------------------------------------------------------------------
// Test: preference exact match with different casing/whitespace
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makePreference("prf-case", "  Always Use  2-Space Indentation!!!  ", "p"),
  ];

  const candidate = preferenceCandidate("always use 2-space indentation", "p");

  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].record.id, "prf-case");
  // Should be high score since tokenization + stemming handles this
  assert.ok(results[0].score >= 0.5, `Score ${results[0].score} >= 0.5`);
}

console.log("casing/whitespace normalization passed");

// ---------------------------------------------------------------------------
// Test: record with global scope
// ---------------------------------------------------------------------------

{
  const existing: ShortlistRecord[] = [
    makeLesson("lsn-global", "Always write tests", "Tests are important.", "_global"),
    makeLesson("lsn-project", "Always write tests", "Tests are important.", "myproject"),
  ];

  // Candidate with myproject scope
  const candidate = lessonCandidate("Always write tests", "Tests are important.", "myproject");
  const results = shortlistWithScores(candidate, existing);
  assert.strictEqual(results.length, 1, "Only same-scope record should match");
  assert.strictEqual(results[0].record.id, "lsn-project");
}

console.log("global scope vs project scope passed");

// ---------------------------------------------------------------------------

console.log("\n✅ All shortlist tests passed!");
