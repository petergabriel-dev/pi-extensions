/**
 * T11 — Sweep archival unit tests.
 *
 * Covers:
 *  - superseded lessons in complete chains are archived
 *  - orphaned superseded lessons remain untouched
 *  - active lessons remain untouched
 *  - archived lessons remain archived
 *  - expired session-scoped lessons are archived
 *  - fresh session-scoped lessons remain active
 *  - non-session-scoped active lessons never archived by expiry
 *  - reversibility: unarchive restores status to "active"
 *  - deterministic: same inputs → same outputs
 *  - sweep does NOT mutate input
 *  - markdown round-trip: archived lessons survive serialize→parse
 *
 * Run: npx tsx test/test_t11_sweep.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepLessons, unarchiveLessons } from "../consolidation/sweep.js";
import {
	parseLessonsFile,
	rewriteLessonsFile,
} from "../storage/markdown.js";
import type { Lesson, LessonMeta, Trigger } from "../types.js";

console.log("Running test_t11_sweep...\n");

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
}): Lesson {
	return {
		id: overrides.id,
		summary: overrides.summary ?? `Summary for ${overrides.id}`,
		detail: overrides.detail ?? `Detail for ${overrides.id}.`,
		meta: {
			project_scope: "testproj",
			status: overrides.status ?? "active",
			session_level: overrides.session_level ?? false,
			reinforcement_count: 1,
			last_seen_at: overrides.last_seen_at ?? null,
			source_session: "s0",
			created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
			supersedes: overrides.supersedes ?? null,
			triggers: overrides.triggers ?? [],
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
// T11.1 — Superseded lessons in complete chains are archived
// ---------------------------------------------------------------------------
{
	console.log("T11.1 — complete superseded chain → archived...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "active", supersedes: "lsn_02,lsn_03" }),
		makeLesson({ id: "lsn_02", status: "superseded", supersedes: null }),
		makeLesson({ id: "lsn_03", status: "superseded", supersedes: null }),
		makeLesson({ id: "lsn_04", status: "archived" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept.length, 4, "length unchanged");
	assert.strictEqual(swept[0].meta.status, "active", "active stays active");
	assert.strictEqual(swept[1].meta.status, "archived", "superseded → archived");
	assert.strictEqual(swept[2].meta.status, "archived", "superseded → archived");
	assert.strictEqual(swept[3].meta.status, "archived", "already archived stays archived");
	assert.strictEqual(result.archivedLessonIds.length, 2);
	assert.deepStrictEqual(result.archivedLessonIds, ["lsn_02", "lsn_03"]);
	assert.strictEqual(result.changed, true);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.2 — Active lessons untouched
// ---------------------------------------------------------------------------
{
	console.log("T11.2 — active lessons untouched...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "active" }),
		makeLesson({ id: "lsn_02", status: "active", session_level: false }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept[0].meta.status, "active");
	assert.strictEqual(swept[1].meta.status, "active");
	assert.strictEqual(result.archivedLessonIds.length, 0);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.3 — Expired session-scoped lessons are archived
// ---------------------------------------------------------------------------
{
	console.log("T11.3 — expired session-scoped → archived...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	// last_seen_at is 2 days old → should expire (threshold 24h)
	const oldSession = makeLesson({
		id: "lsn_s1",
		status: "active",
		session_level: true,
		last_seen_at: "2026-06-08T12:00:00.000Z",
		created_at: "2026-06-01T00:00:00.000Z",
	});

	// last_seen_at is 1 hour ago → should NOT expire
	const recentSession = makeLesson({
		id: "lsn_s2",
		status: "active",
		session_level: true,
		last_seen_at: "2026-06-10T11:00:00.000Z",
		created_at: "2026-06-10T10:00:00.000Z",
	});

	// session_level=false active lesson → should NOT be affected by expiry
	const nonSessionActive = makeLesson({
		id: "lsn_01",
		status: "active",
		session_level: false,
		last_seen_at: "2026-01-01T00:00:00.000Z", // very old but not session-scoped
	});

	const { lessons: swept, result } = sweepLessons([oldSession, recentSession, nonSessionActive], {
		nowMs,
		sessionExpiryMs: 24 * 60 * 60 * 1000,
	});

	assert.strictEqual(swept.length, 3);
	assert.strictEqual(swept[0].meta.status, "archived", "old session lesson archived");
	assert.strictEqual(swept[1].meta.status, "active", "recent session lesson stays active");
	assert.strictEqual(swept[2].meta.status, "active", "non-session active stays active");
	assert.strictEqual(result.archivedLessonIds.length, 1);
	assert.deepStrictEqual(result.archivedLessonIds, ["lsn_s1"]);
	assert.strictEqual(result.changed, true);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.4 — Session-scoped uses created_at when last_seen_at is null
// ---------------------------------------------------------------------------
{
	console.log("T11.4 — fallback to created_at for session expiry...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	// last_seen_at is null; created_at is 30 days old → should expire
	const oldNoLastSeen = makeLesson({
		id: "lsn_s1",
		status: "active",
		session_level: true,
		last_seen_at: null,
		created_at: "2026-05-10T00:00:00.000Z",
	});

	const { lessons: swept, result } = sweepLessons([oldNoLastSeen], {
		nowMs,
		sessionExpiryMs: 24 * 60 * 60 * 1000,
	});

	assert.strictEqual(swept[0].meta.status, "archived");
	assert.strictEqual(result.changed, true);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.5 — Already-archived lessons are not double-counted
// ---------------------------------------------------------------------------
{
	console.log("T11.5 — archived lessons remain archived, not double-counted...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "archived" }),
		makeLesson({ id: "lsn_02", status: "superseded" }),
		makeLesson({ id: "lsn_03", status: "active", supersedes: "lsn_02" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept[0].meta.status, "archived", "already archived stays archived");
	assert.strictEqual(swept[1].meta.status, "archived", "superseded becomes archived");
	// Only lsn_02 was newly archived; lsn_01 was already archived.
	assert.strictEqual(result.archivedLessonIds.length, 1);
	assert.deepStrictEqual(result.archivedLessonIds, ["lsn_02"]);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.6 — Sweep does NOT mutate input
// ---------------------------------------------------------------------------
{
	console.log("T11.6 — immutability...");

	const original = cloneLessons([
		makeLesson({ id: "lsn_01", status: "active", supersedes: "lsn_02" }),
		makeLesson({ id: "lsn_02", status: "superseded" }),
		makeLesson({ id: "lsn_03", status: "active", session_level: true, last_seen_at: "2024-01-01T00:00:00.000Z" }),
	]);

	const snapshot = JSON.stringify(original);

	const { lessons: swept } = sweepLessons(original, {
		nowMs: new Date("2026-06-10T12:00:00.000Z").getTime(),
	});

	// Verify swept is different
	assert.strictEqual(swept[1].meta.status, "archived");
	assert.strictEqual(swept[2].meta.status, "archived");

	// Verify original is unchanged
	const afterSnapshot = JSON.stringify(original);
	assert.strictEqual(afterSnapshot, snapshot, "original array unchanged after sweep");

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.7 — Determinism: same inputs → same outputs
// ---------------------------------------------------------------------------
{
	console.log("T11.7 — determinism...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "superseded" }),
		makeLesson({ id: "lsn_02", status: "active", session_level: true, last_seen_at: "2024-01-01T00:00:00.000Z", supersedes: "lsn_01" }),
	];

	const config = {
		nowMs: new Date("2026-06-10T12:00:00.000Z").getTime(),
		sessionExpiryMs: 24 * 60 * 60 * 1000,
	};

	const a = sweepLessons(lessons, config);
	const b = sweepLessons(lessons, config);

	assert.deepStrictEqual(a, b, "same inputs → same outputs");

	// 100x run
	const first = sweepLessons(lessons, config);
	for (let i = 0; i < 100; i++) {
		assert.deepStrictEqual(sweepLessons(lessons, config), first);
	}

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.8 — Empty lesson list
// ---------------------------------------------------------------------------
{
	console.log("T11.8 — empty list...");

	const { lessons: swept, result } = sweepLessons([]);

	assert.strictEqual(swept.length, 0);
	assert.strictEqual(result.archivedLessonIds.length, 0);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.9 — No eligible lessons (all active, non-session)
// ---------------------------------------------------------------------------
{
	console.log("T11.9 — no eligible lessons...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "active" }),
		makeLesson({ id: "lsn_02", status: "active" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept.length, 2);
	assert.strictEqual(swept[0].meta.status, "active");
	assert.strictEqual(swept[1].meta.status, "active");
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.10 — Custom expiry threshold
// ---------------------------------------------------------------------------
{
	console.log("T11.10 — custom expiry threshold...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	// 1-hour-old session lesson
	const recentSession = makeLesson({
		id: "lsn_s1",
		status: "active",
		session_level: true,
		last_seen_at: "2026-06-10T11:30:00.000Z",
	});

	// With 29-minute threshold → 30-min-old lesson should expire
	const { lessons: swept1, result: r1 } = sweepLessons([recentSession], {
		nowMs,
		sessionExpiryMs: 29 * 60 * 1000, // 29 min
	});
	assert.strictEqual(swept1[0].meta.status, "archived", "with short threshold, recent becomes expired");
	assert.strictEqual(r1.changed, true);

	// With 24-hour threshold → should NOT expire
	const { lessons: swept2, result: r2 } = sweepLessons([recentSession], {
		nowMs,
		sessionExpiryMs: 24 * 60 * 60 * 1000, // 24h
	});
	assert.strictEqual(swept2[0].meta.status, "active", "with long threshold, recent stays active");
	assert.strictEqual(r2.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.11 — Unarchive reversibility
// ---------------------------------------------------------------------------
{
	console.log("T11.11 — unarchive reversibility...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "archived", summary: "Restorable A", detail: "Detail A." }),
		makeLesson({ id: "lsn_02", status: "active", summary: "Active B" }),
		makeLesson({ id: "lsn_03", status: "archived", summary: "Restorable C" }),
		makeLesson({ id: "lsn_04", status: "superseded" }),
	];

	const { lessons: restored, restoredCount } = unarchiveLessons(
		lessons,
		new Set(["lsn_01", "lsn_03"]),
	);

	assert.strictEqual(restored.length, 4);
	assert.strictEqual(restored[0].meta.status, "active", "archived → active");
	assert.strictEqual(restored[0].summary, "Restorable A", "summary preserved");
	assert.strictEqual(restored[0].detail, "Detail A.", "detail preserved");
	assert.strictEqual(restored[1].meta.status, "active", "already active stays active");
	assert.strictEqual(restored[2].meta.status, "active", "archived → active");
	assert.strictEqual(restored[3].meta.status, "superseded", "superseded not changed by unarchive");
	assert.strictEqual(restoredCount, 2);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.12 — Unarchive with empty set is no-op
// ---------------------------------------------------------------------------
{
	console.log("T11.12 — unarchive empty set...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "archived" }),
	];

	const { lessons: restored, restoredCount } = unarchiveLessons(lessons, new Set());

	assert.strictEqual(restored[0].meta.status, "archived", "stays archived");
	assert.strictEqual(restoredCount, 0);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.13 — Superseded with active superseder is archived
// ---------------------------------------------------------------------------
{
	console.log("T11.13 — superseded in active chain archived...");

	// Chain: lsn_01 (superseded) ← lsn_02 (active, supersedes lsn_01)
	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "superseded" }),
		makeLesson({ id: "lsn_02", status: "active", supersedes: "lsn_01" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept.length, 2);
	assert.strictEqual(swept[0].meta.status, "archived", "superseded archived even with active superseder");
	assert.strictEqual(swept[1].meta.status, "active", "active stays active");
	assert.strictEqual(result.archivedLessonIds.length, 1);
	assert.deepStrictEqual(result.archivedLessonIds, ["lsn_01"]);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.14 — Orphaned superseded lessons are not archived
// ---------------------------------------------------------------------------
{
	console.log("T11.14 — orphaned superseded lesson untouched...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_orphan", status: "superseded" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept[0].meta.status, "superseded", "orphaned superseded record is not proven fully superseded");
	assert.deepStrictEqual(result.archivedLessonIds, []);
	assert.strictEqual(result.changed, false);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.15 — Deep chain: all superseded members archived, active head stays
// ---------------------------------------------------------------------------
{
	console.log("T11.15 — deep supersedes chain...");

	// Chain: A (superseded) ← B (superseded) ← C (active)
	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_01", status: "superseded" }),
		makeLesson({ id: "lsn_02", status: "superseded", supersedes: "lsn_01" }),
		makeLesson({ id: "lsn_03", status: "active", supersedes: "lsn_02" }),
	];

	const { lessons: swept, result } = sweepLessons(lessons);

	assert.strictEqual(swept.length, 3);
	assert.strictEqual(swept[0].meta.status, "archived");
	assert.strictEqual(swept[1].meta.status, "archived");
	assert.strictEqual(swept[2].meta.status, "active", "head stays active");
	assert.strictEqual(result.archivedLessonIds.length, 2);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.16 — Markdown round-trip: archived lesson survives serialize→parse
// ---------------------------------------------------------------------------
{
	console.log("T11.16 — markdown round-trip after archival...");

	const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t11-"));
	const filePath = path.join(tmpdir, "lessons.md");

	try {
		const lessons: Lesson[] = [
			makeLesson({
				id: "lsn_01",
				status: "active",
				summary: "Will be archived",
				detail: "This lesson will be swept.",
				triggers: [{ type: "topic", value: "sweep" }],
			}),
			makeLesson({
				id: "lsn_02",
				status: "active",
				summary: "Session-scoped old",
				detail: "Old session lesson.",
				session_level: true,
				last_seen_at: "2024-01-01T00:00:00.000Z",
				triggers: [{ type: "topic", value: "session" }],
			}),
		];

		// Sweep with now far in the future → session lesson expires
		const { lessons: swept } = sweepLessons(lessons, {
			nowMs: new Date("2026-06-10T12:00:00.000Z").getTime(),
			sessionExpiryMs: 24 * 60 * 60 * 1000,
		});

		// Both should be... wait, only lsn_02 is session_level. lsn_01 is active not superseded.
		// Actually we need a complete superseded chain too.
		const supersededLesson = makeLesson({
			id: "lsn_03",
			status: "superseded",
			summary: "Superseded old",
			detail: "Already superseded.",
			triggers: [{ type: "topic", value: "old" }],
		});
		const activeHead = makeLesson({
			id: "lsn_04",
			status: "active",
			supersedes: "lsn_03",
			summary: "Active head",
			detail: "Replacement remains active.",
			triggers: [{ type: "topic", value: "head" }],
		});

		const allLessons = [...swept, supersededLesson, activeHead];
		const { lessons: finalSwept } = sweepLessons(allLessons, {
			nowMs: new Date("2026-06-10T12:00:00.000Z").getTime(),
		});

		// Write to markdown
		rewriteLessonsFile(filePath, finalSwept);

		// Read back
		const parsed = parseLessonsFile(filePath);
		assert.strictEqual(parsed.length, 4, "all 4 lessons survive round-trip");

		// lsn_01: active → active (not superseded, not session)
		const l1 = parsed.find((l) => l.id === "lsn_01")!;
		assert.ok(l1);
		assert.strictEqual(l1.meta.status, "active");
		assert.strictEqual(l1.summary, "Will be archived"); // but it wasn't archived because it's not superseded

		// lsn_02: session-scoped old → archived
		const l2 = parsed.find((l) => l.id === "lsn_02")!;
		assert.ok(l2);
		assert.strictEqual(l2.meta.status, "archived");
		assert.strictEqual(l2.summary, "Session-scoped old");
		assert.strictEqual(l2.meta.session_level, true);
		assert.strictEqual(l2.meta.triggers.length, 1);
		const t2 = l2.meta.triggers[0];
		assert.ok(t2.type !== "command" && t2.value === "session");

		// lsn_03: superseded → archived
		const l3 = parsed.find((l) => l.id === "lsn_03")!;
		assert.ok(l3);
		assert.strictEqual(l3.meta.status, "archived");
		assert.strictEqual(l3.summary, "Superseded old");
		assert.strictEqual(l3.meta.triggers.length, 1);

		// Verify raw markdown contains "archived" status
		const raw = fs.readFileSync(filePath, "utf-8");
		assert.ok(raw.includes("status: archived"), "archived status appears in markdown");
		assert.ok(raw.includes("## lsn_02 — Session-scoped old"));
		assert.ok(raw.includes("## lsn_03 — Superseded old"));
		assert.ok(raw.includes("## lsn_04 — Active head"));
	} finally {
		fs.rmSync(tmpdir, { recursive: true, force: true });
	}

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.17 — Session-scoped but superseded → archived by superseded rule, not expiry
// ---------------------------------------------------------------------------
{
	console.log("T11.17 — session-scoped superseded...");

	const nowMs = new Date("2026-06-10T12:00:00.000Z").getTime();

	// Session-scoped lesson that is fresh but superseded
	const lesson = makeLesson({
		id: "lsn_s1",
		status: "superseded",
		session_level: true,
		last_seen_at: "2026-06-10T11:00:00.000Z", // fresh
	});

	const head = makeLesson({ id: "lsn_head", status: "active", supersedes: "lsn_s1" });
	const { lessons: swept, result } = sweepLessons([lesson, head], {
		nowMs,
		sessionExpiryMs: 24 * 60 * 60 * 1000,
	});

	assert.strictEqual(swept[0].meta.status, "archived", "superseded archived regardless of freshness");
	assert.strictEqual(swept[1].meta.status, "active", "replacement head stays active");
	assert.strictEqual(result.archivedLessonIds.length, 1);

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------
// T11.18 — Sweep handles mixed statuses correctly
// ---------------------------------------------------------------------------
{
	console.log("T11.18 — mixed statuses...");

	const lessons: Lesson[] = [
		makeLesson({ id: "lsn_active", status: "active", supersedes: "lsn_superseded" }),
		makeLesson({ id: "lsn_superseded", status: "superseded" }),
		makeLesson({ id: "lsn_archived", status: "archived" }),
		makeLesson({
			id: "lsn_session_old",
			status: "active",
			session_level: true,
			last_seen_at: "2024-01-01T00:00:00.000Z",
		}),
		makeLesson({
			id: "lsn_session_fresh",
			status: "active",
			session_level: true,
			last_seen_at: "2026-06-10T11:00:00.000Z",
		}),
	];

	const { lessons: swept, result } = sweepLessons(lessons, {
		nowMs: new Date("2026-06-10T12:00:00.000Z").getTime(),
		sessionExpiryMs: 24 * 60 * 60 * 1000,
	});

	assert.strictEqual(swept.length, 5);

	// Verify each status
	const byId = new Map(swept.map((l) => [l.id, l.meta.status]));
	assert.strictEqual(byId.get("lsn_active"), "active");
	assert.strictEqual(byId.get("lsn_superseded"), "archived");
	assert.strictEqual(byId.get("lsn_archived"), "archived");
	assert.strictEqual(byId.get("lsn_session_old"), "archived");
	assert.strictEqual(byId.get("lsn_session_fresh"), "active");

	// Only lsn_superseded and lsn_session_old should be newly archived
	assert.strictEqual(result.archivedLessonIds.length, 2);
	assert.deepStrictEqual(result.archivedLessonIds.sort(), ["lsn_session_old", "lsn_superseded"].sort());

	console.log("  ✓ passed\n");
}

// ---------------------------------------------------------------------------

console.log("✅ All T11 sweep tests passed!\n");
