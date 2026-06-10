/**
 * T12 — Low-signal flagging + contradiction detection unit tests.
 *
 * Covers:
 *  - Low-signal: old + low reinforcement + never fired → flagged
 *  - Low-signal: recent lesson not flagged
 *  - Low-signal: high reinforcement not flagged even if old
 *  - Low-signal: fired lesson not flagged even if old + low reinforcement
 *  - Low-signal: already-flagged lessons not double-counted
 *  - Low-signal: superseded/archived lessons are skipped
 *  - Low-signal: flagging does NOT mutate input
 *  - Low-signal: determinism
 *  - Low-signal: reversibility (unflag)
 *  - Contradictions: shared trigger → grouped
 *  - Contradictions: no shared triggers → no groups
 *  - Contradictions: already-grouped lessons skipped
 *  - Contradictions: superseded/archived lessons skipped
 *  - Contradictions: does NOT mutate input
 *  - Contradictions: determinism
 *  - Contradictions: reversibility (clear groups)
 *  - Sweep integration: all three phases run together
 *  - Markdown round-trip: low_signal + contradiction_group survive
 *
 * Run: npx tsx test/test_t12_low_signal_contradictions.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	flagLowSignalLessons,
	unflagLowSignalLessons,
	detectContradictions,
	clearContradictionGroups,
} from "../consolidation/sweep.js";
import {
	parseLessonsFile,
	rewriteLessonsFile,
} from "../storage/markdown.js";
import type { Lesson, Trigger } from "../types.js";

console.log("Running test_t12_low_signal_contradictions...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLesson(overrides: {
	id: string;
	status?: "active" | "superseded" | "archived";
	session_level?: boolean;
	last_seen_at?: string | null;
	created_at?: string;
	supersedes?: string | null;
	summary?: string;
	detail?: string;
	triggers?: Trigger[];
	reinforcement_count?: number;
	low_signal?: boolean;
	contradiction_group?: string | null;
}): Lesson {
	return {
		id: overrides.id,
		summary: overrides.summary ?? `Summary for ${overrides.id}`,
		detail: overrides.detail ?? `Detail for ${overrides.id}.`,
		meta: {
			project_scope: "testproj",
			status: overrides.status ?? "active",
			session_level: overrides.session_level ?? false,
			reinforcement_count: overrides.reinforcement_count ?? 0,
			last_seen_at: overrides.last_seen_at ?? null,
			source_session: "s0",
			created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
			supersedes: overrides.supersedes ?? null,
			triggers: overrides.triggers ?? [],
			low_signal: overrides.low_signal ?? false,
			contradiction_group: overrides.contradiction_group ?? null,
		},
	};
}

function cloneLessons(lessons: readonly Lesson[]): Lesson[] {
	return lessons.map((l) => ({
		...l,
		meta: { ...l.meta, triggers: l.meta.triggers.map((t) => ({ ...t })) },
	}));
}

// ---------------------------------------------------------------------------
// T12.1 — Low-signal: old + low reinforcement + never fired → flagged
// ---------------------------------------------------------------------------
{
	console.log("T12.1 — old + low reinforcement + never fired → flagged...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();
	const emptyFired = new Set<string>();

	const oldUnused = makeLesson({
		id: "lsn_01",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z", // 18+ months old
		created_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { lessons: flagged, result } = flagLowSignalLessons([oldUnused], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
		lowSignalMaxReinforcement: 1, // flag if < 1
		firedLessonIds: emptyFired,
	});

	assert.strictEqual(flagged.length, 1);
	assert.strictEqual(flagged[0].meta.low_signal, true, "low-signal flag set");
	assert.strictEqual(flagged[0].meta.status, "active", "status unchanged — flag, not delete");
	assert.strictEqual(result.flaggedIds.length, 1);
	assert.deepStrictEqual(result.flaggedIds, ["lsn_01"]);
	assert.strictEqual(result.changed, true);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.2 — Recent lesson not flagged
// ---------------------------------------------------------------------------
{
	console.log("T12.2 — recent lesson not flagged...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const recentLesson = makeLesson({
		id: "lsn_02",
		status: "active",
		last_seen_at: "2026-06-09T00:00:00.000Z", // 1.5 days ago
		created_at: "2026-06-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { result } = flagLowSignalLessons([recentLesson], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(result.flaggedIds.length, 0);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.3 — High reinforcement not flagged even if old
// ---------------------------------------------------------------------------
{
	console.log("T12.3 — high reinforcement not flagged...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const oldButReinforced = makeLesson({
		id: "lsn_03",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		created_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 5, // well-reinforced
	});

	const { result } = flagLowSignalLessons([oldButReinforced], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(result.flaggedIds.length, 0);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.4 — Fired lesson not flagged even if old + low reinforcement
// ---------------------------------------------------------------------------
{
	console.log("T12.4 — fired lesson not flagged...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const oldButFired = makeLesson({
		id: "lsn_04",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { result } = flagLowSignalLessons([oldButFired], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(["lsn_04"]), // has been fired
	});

	assert.strictEqual(result.flaggedIds.length, 0, "fired lesson not flagged");
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.5 — Already-flagged lessons not double-counted
// ---------------------------------------------------------------------------
{
	console.log("T12.5 — already-flagged not double-counted...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const alreadyFlagged = makeLesson({
		id: "lsn_05",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
		low_signal: true, // already flagged
	});

	const notYetFlagged = makeLesson({
		id: "lsn_06",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { lessons: flagged, result } = flagLowSignalLessons([alreadyFlagged, notYetFlagged], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(flagged.length, 2);
	assert.strictEqual(flagged[0].meta.low_signal, true, "already flagged stays flagged");
	assert.strictEqual(flagged[1].meta.low_signal, true, "newly flagged");
	assert.strictEqual(result.flaggedIds.length, 1, "only one new flag");
	assert.deepStrictEqual(result.flaggedIds, ["lsn_06"]);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.6 — Superseded/archived lessons are skipped
// ---------------------------------------------------------------------------
{
	console.log("T12.6 — superseded/archived skipped for low-signal...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const superseded = makeLesson({
		id: "lsn_07",
		status: "superseded",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const archived = makeLesson({
		id: "lsn_08",
		status: "archived",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { result } = flagLowSignalLessons([superseded, archived], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(result.flaggedIds.length, 0, "superseded/archived not flagged");
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.7 — Flagging does NOT mutate input
// ---------------------------------------------------------------------------
{
	console.log("T12.7 — low-signal immutability...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();
	const original = cloneLessons([
		makeLesson({
			id: "lsn_01",
			status: "active",
			last_seen_at: "2025-01-01T00:00:00.000Z",
			reinforcement_count: 0,
		}),
	]);

	const snapshot = JSON.stringify(original);

	const { lessons: flagged } = flagLowSignalLessons(original, {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(flagged[0].meta.low_signal, true, "new array has flag");

	const afterSnapshot = JSON.stringify(original);
	assert.strictEqual(afterSnapshot, snapshot, "original unchanged");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.8 — Low-signal determinism
// ---------------------------------------------------------------------------
{
	console.log("T12.8 — low-signal determinism...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const lessons = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			last_seen_at: "2025-01-01T00:00:00.000Z",
			reinforcement_count: 0,
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			last_seen_at: "2026-06-09T00:00:00.000Z",
			reinforcement_count: 0,
		}),
	];

	const config = {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set<string>(),
	};

	const a = flagLowSignalLessons(lessons, config);
	const b = flagLowSignalLessons(lessons, config);
	assert.deepStrictEqual(a, b, "same inputs → same outputs");

	const first = flagLowSignalLessons(lessons, config);
	for (let i = 0; i < 100; i++) {
		assert.deepStrictEqual(flagLowSignalLessons(lessons, config), first);
	}

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.9 — Low-signal reversibility (unflag)
// ---------------------------------------------------------------------------
{
	console.log("T12.9 — low-signal unflag reversibility...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "active", summary: "Flagged A", low_signal: true }),
		makeLesson({ id: "lsn_02", status: "active", summary: "Not flagged", low_signal: false }),
		makeLesson({ id: "lsn_03", status: "active", summary: "Flagged B", low_signal: true }),
	];

	const { lessons: restored, clearedCount } = unflagLowSignalLessons(lessons, new Set(["lsn_01", "lsn_03"]));

	assert.strictEqual(restored.length, 3);
	assert.strictEqual(restored[0].meta.low_signal, false, "flag cleared");
	assert.strictEqual(restored[0].summary, "Flagged A", "summary preserved");
	assert.strictEqual(restored[1].meta.low_signal, false, "already unflagged");
	assert.strictEqual(restored[2].meta.low_signal, false, "flag cleared");
	assert.strictEqual(clearedCount, 2);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.10 — Contradictions: shared trigger → grouped
// ---------------------------------------------------------------------------
{
	console.log("T12.10 — shared trigger creates contradiction group...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			summary: "Use TypeScript",
			triggers: [{ type: "topic", value: "typescript" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			summary: "Avoid TypeScript",
			triggers: [{ type: "topic", value: "typescript" }],
		}),
	];

	const { lessons: result, result: { pairs, groups, changed } } = detectContradictions(lessons);

	assert.strictEqual(pairs.length, 1);
	assert.strictEqual(pairs[0].sharedTrigger, "topic:typescript");
	assert.strictEqual(groups.size, 1);
	assert.strictEqual(changed, true);

	// Both lessons should be assigned the same group
	const g1 = result[0].meta.contradiction_group;
	const g2 = result[1].meta.contradiction_group;
	assert.ok(g1, "lesson 1 has group");
	assert.ok(g2, "lesson 2 has group");
	assert.strictEqual(g1, g2, "same group");
	assert.ok(g1!.startsWith("cgrp_"), "group id format");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.11 — No shared triggers → no groups
// ---------------------------------------------------------------------------
{
	console.log("T12.11 — no shared triggers → no groups...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "topic", value: "typescript" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "topic", value: "python" }],
		}),
	];

	const { result } = detectContradictions(lessons);

	assert.strictEqual(result.pairs.length, 0);
	assert.strictEqual(result.groups.size, 0);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.12 — Tool triggers with patterns create distinct keys
// ---------------------------------------------------------------------------
{
	console.log("T12.12 — tool trigger pattern distinguishes keys...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "tool", value: "bash", pattern: "npm" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "tool", value: "bash", pattern: "yarn" }],
		}),
	];

	const { result } = detectContradictions(lessons);
	assert.strictEqual(result.pairs.length, 0, "different patterns → different keys");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.13 — Already-grouped lessons skipped
// ---------------------------------------------------------------------------
{
	console.log("T12.13 — already-grouped skipped...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			summary: "Already in group",
			triggers: [{ type: "topic", value: "testing" }],
			contradiction_group: "cgrp_001",
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			summary: "New lesson",
			triggers: [{ type: "topic", value: "testing" }],
		}),
	];

	const { lessons: result, result: { pairs } } = detectContradictions(lessons);

	// lsn_01 is already grouped, so it shouldn't generate new pairs
	assert.strictEqual(pairs.length, 0, "already-grouped lesson excluded from new pairs");
	assert.strictEqual(result[0].meta.contradiction_group, "cgrp_001", "existing group preserved");
	assert.strictEqual(result[1].meta.contradiction_group ?? null, null, "new lesson not grouped (no partner)");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.14 — Superseded/archived lessons skipped in contradiction detection
// ---------------------------------------------------------------------------
{
	console.log("T12.14 — superseded/archived skipped for contradictions...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "superseded",
			triggers: [{ type: "topic", value: "shared" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "archived",
			triggers: [{ type: "topic", value: "shared" }],
		}),
		makeLesson({
			id: "lsn_03",
			status: "active",
			triggers: [{ type: "topic", value: "shared" }],
		}),
	];

	const { result } = detectContradictions(lessons);

	// Only active lessons are considered; lsn_03 has no other active partner
	assert.strictEqual(result.pairs.length, 0);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.15 — Contradiction detection does NOT mutate input
// ---------------------------------------------------------------------------
{
	console.log("T12.15 — contradiction immutability...");

	const original = cloneLessons([
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "topic", value: "immutability" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "topic", value: "immutability" }],
		}),
	]);

	const snapshot = JSON.stringify(original);

	const { lessons: result } = detectContradictions(original);

	assert.ok(result[0].meta.contradiction_group, "new array has group");

	const afterSnapshot = JSON.stringify(original);
	assert.strictEqual(afterSnapshot, snapshot, "original unchanged");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.16 — Contradiction determinism
// ---------------------------------------------------------------------------
{
	console.log("T12.16 — contradiction determinism...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "topic", value: "determinism" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "topic", value: "determinism" }],
		}),
		makeLesson({
			id: "lsn_03",
			status: "active",
			triggers: [{ type: "topic", value: "determinism" }],
		}),
	];

	const a = detectContradictions(lessons);
	const b = detectContradictions(lessons);
	assert.deepStrictEqual(a, b, "same inputs → same outputs");

	const first = detectContradictions(lessons);
	for (let i = 0; i < 100; i++) {
		assert.deepStrictEqual(detectContradictions(lessons), first);
	}

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.17 — Contradiction reversibility (clear groups)
// ---------------------------------------------------------------------------
{
	console.log("T12.17 — contradiction clear groups...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "active", summary: "In group A", contradiction_group: "cgrp_001" }),
		makeLesson({ id: "lsn_02", status: "active", summary: "In group A", contradiction_group: "cgrp_001" }),
		makeLesson({ id: "lsn_03", status: "active", summary: "Not grouped", contradiction_group: null }),
	];

	const { lessons: restored, clearedCount } = clearContradictionGroups(lessons, new Set(["lsn_01", "lsn_02"]));

	assert.strictEqual(restored.length, 3);
	assert.strictEqual(restored[0].meta.contradiction_group ?? null, null, "group cleared");
	assert.strictEqual(restored[1].meta.contradiction_group ?? null, null, "group cleared");
	assert.strictEqual(restored[2].meta.contradiction_group ?? null, null, "already null");
	assert.strictEqual(clearedCount, 2);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.18 — Multi-trigger lessons: only the shared trigger creates group
// ---------------------------------------------------------------------------
{
	console.log("T12.18 — multi-trigger lessons with shared trigger...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			summary: "Lesson A",
			triggers: [
				{ type: "topic", value: "shared" },
				{ type: "topic", value: "unique-a" },
			],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			summary: "Lesson B",
			triggers: [
				{ type: "topic", value: "shared" },
				{ type: "topic", value: "unique-b" },
			],
		}),
	];

	const { result: { pairs, groups, changed } } = detectContradictions(lessons);

	assert.strictEqual(pairs.length, 1);
	assert.strictEqual(pairs[0].sharedTrigger, "topic:shared");
	assert.strictEqual(groups.size, 1);
	assert.strictEqual(changed, true);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.19 — Command triggers create correct keys
// ---------------------------------------------------------------------------
{
	console.log("T12.19 — command trigger keys...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "command", pattern: "npm test" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "command", pattern: "npm test" }],
		}),
	];

	const { result: { pairs } } = detectContradictions(lessons);
	assert.strictEqual(pairs.length, 1);
	assert.strictEqual(pairs[0].sharedTrigger, "cmd:npm test");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.20 — Three or more lessons with same trigger form single group
// ---------------------------------------------------------------------------
{
	console.log("T12.20 — three+ lessons in one group...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "topic", value: "group-test" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "topic", value: "group-test" }],
		}),
		makeLesson({
			id: "lsn_03",
			status: "active",
			triggers: [{ type: "topic", value: "group-test" }],
		}),
	];

	const { lessons: result, result: { pairs, groups } } = detectContradictions(lessons);

	// 3 lessons = 3 pairs (1-2, 1-3, 2-3) all in 1 group
	assert.strictEqual(pairs.length, 3);
	assert.strictEqual(groups.size, 1);

	// All three should have the same group
	const g1 = result[0].meta.contradiction_group;
	const g2 = result[1].meta.contradiction_group;
	const g3 = result[2].meta.contradiction_group;
	assert.strictEqual(g1, g2);
	assert.strictEqual(g2, g3);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.21 — Empty lesson list
// ---------------------------------------------------------------------------
{
	console.log("T12.21 — empty list for both functions...");

	// Low-signal
	const { lessons: lsLessons, result: lsResult } = flagLowSignalLessons([], {
		nowMs: Date.now(),
		firedLessonIds: new Set(),
	});
	assert.strictEqual(lsLessons.length, 0);
	assert.strictEqual(lsResult.flaggedIds.length, 0);
	assert.strictEqual(lsResult.changed, false);

	// Contradictions
	const { lessons: cdLessons, result: cdResult } = detectContradictions([]);
	assert.strictEqual(cdLessons.length, 0);
	assert.strictEqual(cdResult.pairs.length, 0);
	assert.strictEqual(cdResult.groups.size, 0);
	assert.strictEqual(cdResult.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.22 — Custom thresholds for low-signal
// ---------------------------------------------------------------------------
{
	console.log("T12.22 — custom low-signal thresholds...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	// Lesson is 40 days old with reinforcement_count=2
	const lesson = makeLesson({
		id: "lsn_cfg",
		status: "active",
		last_seen_at: "2026-05-01T00:00:00.000Z", // 40 days ago
		reinforcement_count: 2,
	});

	// Default: age > 30 days AND reinforcement < 1 → not flagged (reinforcement 2 >= 1)
	const { result: r1 } = flagLowSignalLessons([lesson], {
		nowMs,
		firedLessonIds: new Set(),
	});
	assert.strictEqual(r1.flaggedIds.length, 0, "default thresholds: reinforcement too high");

	// Custom: age > 30 days AND reinforcement < 3 → flagged
	const { result: r2 } = flagLowSignalLessons([lesson], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 3,
		firedLessonIds: new Set(),
	});
	assert.strictEqual(r2.flaggedIds.length, 1, "custom threshold: flagged");

	// Custom: age > 60 days AND reinforcement < 1 → not flagged (not old enough)
	const { result: r3 } = flagLowSignalLessons([lesson], {
		nowMs,
		lowSignalAgeMs: 60 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});
	assert.strictEqual(r3.flaggedIds.length, 0, "not old enough for 60-day threshold");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.23 — Markdown round-trip: low_signal + contradiction_group survive
// ---------------------------------------------------------------------------
{
	console.log("T12.23 — markdown round-trip with T12 fields...");

	const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t12-"));
	const filePath = path.join(tmpdir, "lessons.md");

	try {
		const lessons: Lesson[] = [
			makeLesson({
				id: "lsn_01",
				status: "active",
				summary: "Low signal lesson",
				detail: "This lesson is flagged as low-signal.",
				low_signal: true,
				triggers: [{ type: "topic", value: "example" }],
			}),
			makeLesson({
				id: "lsn_02",
				status: "active",
				summary: "Contradictory lesson A",
				detail: "Part of a contradiction group.",
				contradiction_group: "cgrp_001",
				triggers: [{ type: "topic", value: "example" }],
			}),
			makeLesson({
				id: "lsn_03",
				status: "active",
				summary: "Contradictory lesson B",
				detail: "Same group.",
				contradiction_group: "cgrp_001",
				triggers: [{ type: "topic", value: "example" }],
			}),
		];

		// Write to markdown
		rewriteLessonsFile(filePath, lessons);

		// Read back
		const parsed = parseLessonsFile(filePath);
		assert.strictEqual(parsed.length, 3, "all 3 lessons survive round-trip");

		// lsn_01: low_signal
		const l1 = parsed.find((l) => l.id === "lsn_01")!;
		assert.ok(l1);
		assert.strictEqual(l1.meta.low_signal, true);
		assert.strictEqual(l1.summary, "Low signal lesson");

		// lsn_02: contradiction_group
		const l2 = parsed.find((l) => l.id === "lsn_02")!;
		assert.ok(l2);
		assert.strictEqual(l2.meta.contradiction_group, "cgrp_001");
		assert.strictEqual(l2.summary, "Contradictory lesson A");

		// lsn_03: contradiction_group
		const l3 = parsed.find((l) => l.id === "lsn_03")!;
		assert.ok(l3);
		assert.strictEqual(l3.meta.contradiction_group, "cgrp_001");
		assert.strictEqual(l3.summary, "Contradictory lesson B");

		// lsn_04 (nonexistent) should not have default values leak
		assert.strictEqual(parsed.find((l) => l.id === "lsn_04"), undefined);

		// Verify raw markdown contains the new fields
		const raw = fs.readFileSync(filePath, "utf-8");
		assert.ok(raw.includes("low_signal: true"), "low_signal appears in markdown");
		assert.ok(raw.includes("contradiction_group: cgrp_001"), "contradiction_group appears in markdown");

		// Verify backward compatibility: a lesson without the new fields parses correctly
		const rawLegacy = `## lsn_099 — Legacy lesson

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

Legacy detail.`;

		const legacyPath = path.join(tmpdir, "legacy-lessons.md");
		fs.writeFileSync(legacyPath, rawLegacy);
		const legacyParsed = parseLessonsFile(legacyPath);
		assert.strictEqual(legacyParsed.length, 1);
		assert.strictEqual(legacyParsed[0].id, "lsn_099");
		assert.strictEqual(legacyParsed[0].meta.low_signal, false, "legacy defaults to false");
		assert.strictEqual(legacyParsed[0].meta.contradiction_group ?? null, null, "legacy defaults to null");

	} finally {
		fs.rmSync(tmpdir, { recursive: true, force: true });
	}

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.24 — Flag-not-delete: low-signal status is still "active"
// ---------------------------------------------------------------------------
{
	console.log("T12.24 — flag-not-delete: status remains active...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	const lesson = makeLesson({
		id: "lsn_flag",
		status: "active",
		last_seen_at: "2025-01-01T00:00:00.000Z",
		reinforcement_count: 0,
	});

	const { lessons: flagged } = flagLowSignalLessons([lesson], {
		nowMs,
		lowSignalAgeMs: 30 * 24 * 60 * 60 * 1000,
		lowSignalMaxReinforcement: 1,
		firedLessonIds: new Set(),
	});

	assert.strictEqual(flagged[0].meta.status, "active", "low-signal flagged lesson is still active, not archived or deleted");
	assert.strictEqual(flagged[0].meta.low_signal, true, "low_signal flag is set");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T12.25 — Path triggers create correct keys
// ---------------------------------------------------------------------------
{
	console.log("T12.25 — path trigger keys...");

	const lessons: Lesson[] = [
		makeLesson({
			id: "lsn_01",
			status: "active",
			triggers: [{ type: "path", value: "src/index.ts" }],
		}),
		makeLesson({
			id: "lsn_02",
			status: "active",
			triggers: [{ type: "path", value: "src/index.ts" }],
		}),
	];

	const { result: { pairs } } = detectContradictions(lessons);
	assert.strictEqual(pairs.length, 1);
	assert.strictEqual(pairs[0].sharedTrigger, "path:src/index.ts");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------

console.log("✅ All T12 low-signal + contradiction tests passed!\n");
