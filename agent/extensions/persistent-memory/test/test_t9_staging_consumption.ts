import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReconciliation } from "../consolidation/reconcile.js";
import { listDeadLetterFiles, listStagingFiles, readDeadLetter, readStaging, writeStaging } from "../consolidation/staging.js";
import { parseLessonsFile, parsePreferencesFile, parseDomainFile, serializeLessonsFile, serializePreferencesFile } from "../storage/markdown.js";
import { openIndex } from "../storage/sqlite.js";
import type { Lesson, StagingFile, Trigger } from "../types.js";

console.log("Running test_t9_staging_consumption...");

type LessonCandidate = StagingFile["candidates"]["lessons"][number];
type PreferenceCandidate = StagingFile["candidates"]["preferences"][number];
type DomainCandidate = StagingFile["candidates"]["domain"][number];

function existingLesson(id: string, summary: string, detail: string): Lesson {
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
			triggers: [{ type: "topic", value: "testing" }],
		},
	};
}

function lessonCandidate(summary: string, detail: string, attempts?: number, triggers: Trigger[] = [{ type: "topic", value: "testing" }]): LessonCandidate {
	return {
		summary,
		detail,
		scope_suggestion: "testproj",
		triggers,
		source_evidence: { discussion_note_ids: [1] },
		...(attempts === undefined ? {} : { reconcile_attempts: attempts }),
	};
}

function prefCandidate(text: string, attempts?: number): PreferenceCandidate {
	return {
		text,
		source_evidence: { discussion_note_ids: [1] },
		...(attempts === undefined ? {} : { reconcile_attempts: attempts }),
	};
}

function domainCandidate(summary: string, detail: string, attempts?: number): DomainCandidate {
	return {
		summary,
		detail,
		source_evidence: { discussion_note_ids: [1] },
		...(attempts === undefined ? {} : { reconcile_attempts: attempts }),
	};
}

function setupMemory(root: string, existingLessons: Lesson[], stagingCandidates: {
	lessons?: LessonCandidate[];
	preferences?: PreferenceCandidate[];
	decisions?: any[];
	domain?: DomainCandidate[];
}) {
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	fs.writeFileSync(path.join(mem, "lessons.md"), serializeLessonsFile(existingLessons), "utf8");
	fs.writeFileSync(path.join(mem, "preferences.md"), serializePreferencesFile([]), "utf8");
	for (const name of ["decisions.md", "domain.md"]) fs.writeFileSync(path.join(mem, name), "", "utf8");
	writeStaging(path.join(mem, "staging", "s1.json"), {
		schemaVersion: 1,
		session_id: "s1",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: root,
		candidates: {
			lessons: stagingCandidates.lessons ?? [],
			preferences: stagingCandidates.preferences ?? [],
			decisions: stagingCandidates.decisions ?? [],
			domain: stagingCandidates.domain ?? [],
		},
	});
	const db = openIndex(path.join(mem, "index.db"));
	return { root, mem, db };
}

// ---------------------------------------------------------------------------
// T9.1 — No staging file survives when all candidates are resolved (consumed).
// ---------------------------------------------------------------------------
async function testAllResolvedFileConsumed() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-1-"));
	const { mem, db } = setupMemory(root,
		[],
		{ lessons: [lessonCandidate("Distinct lesson", "No collision here.", undefined, [{ type: "topic", value: "unique" }])] },
	);
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(result.counts.stagingFiles.consumed, 1, "file should be consumed");
		assert.equal(result.counts.stagingFiles.deadLettered, 0, "no dead letters for fully resolved file");
		assert.equal(result.counts.stagingFiles.preserved, 0, "T9: never preserved");
		assert.equal(listStagingFiles(mem).length, 0, "staging file deleted");
		assert.equal(listDeadLetterFiles(mem).length, 0, "no dead letters");
		assert.equal(parseLessonsFile(path.join(mem, "lessons.md")).length, 1, "lesson committed");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.2 — Never-attempted candidates are preserved for a future run.
// ---------------------------------------------------------------------------
async function testNoResolvedFileDeadLettered() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-2-"));
	const { mem, db } = setupMemory(root,
		[existingLesson("lsn_01", "Existing lesson", "Original detail that differs.")],
		{ lessons: [lessonCandidate("Existing lesson", "Different detail — collision, not exact dupe.")] },
	);
	try {
		// No model available → collision candidates cannot be resolved.
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			// Deliberately omit callCarefulModel and callAdjudicationModel
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(result.counts.stagingFiles.consumed, 0, "no candidates resolved");
		assert.equal(result.counts.stagingFiles.deadLettered, 0, "no never-attempted dead letters");
		assert.equal(result.counts.stagingFiles.preserved, 1, "file preserved with survivor");
		const stagedFiles = listStagingFiles(mem);
		assert.equal(stagedFiles.length, 1, "staging file survives");
		assert.equal(readStaging(stagedFiles[0])?.candidates.lessons.length, 1, "candidate re-staged unchanged");
		assert.equal(listDeadLetterFiles(mem).length, 0, "candidate not dead-lettered");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.3 — Mixed: resolved candidates are consumed; unresolved survivors stay staged.
// ---------------------------------------------------------------------------
async function testMixedResolvedAndDeadLettered() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-3-"));
	const { mem, db } = setupMemory(root,
		[existingLesson("lsn_01", "Collision anchor", "Original detail for collision.")],
		{
			lessons: [
				// Truly distinct: zero lexical overlap with existing lesson.
				lessonCandidate("Banana pancake breakfast", "Mix flour eggs banana in morning.", undefined, [{ type: "topic", value: "cooking" }]),
				lessonCandidate("Collision anchor", "Different detail — collision, not exact dupe.", 0),
			],
		},
	);
	try {
		// No model → deterministic add succeeds for first candidate (no collision),
		// second candidate (collision) is unattempted → re-staged.
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(result.counts.stagingFiles.consumed, 0, "file rewritten with survivor");
		assert.equal(result.counts.stagingFiles.deadLettered, 0, "file not counted as wholly dead-lettered");
		assert.equal(result.counts.stagingFiles.preserved, 1, "survivor preserved");
		const stagedFiles = listStagingFiles(mem);
		assert.equal(stagedFiles.length, 1, "staging file survives");
		assert.equal(readStaging(stagedFiles[0])?.candidates.lessons.length, 1, "only unresolved candidate remains");
		assert.equal(listDeadLetterFiles(mem).length, 0, "unresolved candidate not dead-lettered");
		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		assert.equal(lessons.length, 2, "1 existing + 1 committed");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.4 — Unattempted candidates (generation stopped) are re-staged with
//        attempts unchanged.
// ---------------------------------------------------------------------------
async function testGenerationStoppedCandidatesDeadLettered() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-4-"));
	const { mem, db } = setupMemory(root, [], {
		lessons: [
			lessonCandidate("First", "First detail", undefined, [{ type: "topic", value: "first" }]),
			lessonCandidate("Second", "Second detail", 2, [{ type: "topic", value: "second" }]),
			lessonCandidate("Third", "Third detail", 3, [{ type: "topic", value: "third" }]),
		],
	});
	try {
		// Stop after first candidate is processed.
		let stop = false;
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			shouldContinue: () => !stop,
			afterDeterministicAddForTest: () => { stop = true; },
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		const stagedFiles = listStagingFiles(mem);
		assert.equal(stagedFiles.length, 1, "staging file survives");
		const staged = readStaging(stagedFiles[0])?.candidates.lessons ?? [];
		assert.equal(staged.length, 2, "two unattempted candidates re-staged");
		assert.deepEqual(staged.map((candidate) => candidate.reconcile_attempts).sort(), [2, 3], "attempts unchanged for unattempted candidates");
		assert.equal(listDeadLetterFiles(mem).length, 0, "no transient dead letters");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.5 — Multiple categories in one staging file all reach terminal state.
// ---------------------------------------------------------------------------
async function testMultiCategoryAllTerminal() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-5-"));
	const { mem, db } = setupMemory(root, [], {
		lessons: [lessonCandidate("Distinct lesson", "No collision.", undefined, [{ type: "topic", value: "distinct" }])],
		preferences: [prefCandidate("I prefer tabs over spaces.")],
		domain: [domainCandidate("Domain fact", "Some domain detail.")],
	});
	try {
		// No model — all non-colliding candidates are deterministic adds.
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(result.counts.stagingFiles.consumed, 1);
		assert.equal(result.counts.stagingFiles.preserved, 0, "T9: never preserved");
		assert.equal(listStagingFiles(mem).length, 0, "staging file deleted");
		assert.equal(listDeadLetterFiles(mem).length, 0, "all resolved");
		assert.equal(parseLessonsFile(path.join(mem, "lessons.md")).length, 1);
		assert.equal(parsePreferencesFile(path.join(mem, "preferences.md")).length, 1);
		assert.equal(parseDomainFile(path.join(mem, "domain.md")).length, 1);
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.6 — Attempted-but-unresolved candidates retry under cap.
// ---------------------------------------------------------------------------
async function testAttemptedUnresolvedIncrements() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-6-"));
	const { mem, db } = setupMemory(root,
		[existingLesson("lsn_01", "Collision", "Original detail.")],
		{ lessons: [lessonCandidate("Collision", "Different detail for collision.", 1)] },
	);
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			adjudicationBatchSize: 1,
			callAdjudicationModel: async () => { throw new Error("adjudication failure"); },
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		const stagedFiles = listStagingFiles(mem);
		assert.equal(stagedFiles.length, 1, "staging file survives under cap");
		const staged = readStaging(stagedFiles[0])?.candidates.lessons ?? [];
		assert.equal(staged.length, 1);
		assert.equal(staged[0].reconcile_attempts, 2, "attempts incremented from 1 -> 2");
		assert.equal(listDeadLetterFiles(mem).length, 0, "under-cap candidate not dead-lettered");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testAttemptedUnresolvedDeadLettersAtCap() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-6-cap-"));
	const { mem, db } = setupMemory(root,
		[existingLesson("lsn_01", "Collision", "Original detail.")],
		{ lessons: [lessonCandidate("Collision", "Different detail for collision.", 2)] },
	);
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			adjudicationBatchSize: 1,
			callAdjudicationModel: async () => { throw new Error("adjudication failure"); },
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(listStagingFiles(mem).length, 0, "at-cap candidate leaves staging");
		const deadFiles = listDeadLetterFiles(mem);
		assert.equal(deadFiles.length, 1, "at-cap candidate dead-lettered");
		const deadLetter = readDeadLetter(deadFiles[0]);
		assert.ok(deadLetter);
		assert.equal(deadLetter.attempts, 3, "attempts incremented to cap");
		assert.match(deadLetter.last_gate_reason, /retry cap 3 reached/);
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T9.7 — Wrong-project files are terminal (untouched by this project).
// ---------------------------------------------------------------------------
async function testWrongProjectTerminal() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t9-7-"));
	const projectRoot = path.join(root, "project-a");
	const otherRoot = path.join(root, "project-b");
	const mem = path.join(projectRoot, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	for (const name of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) fs.writeFileSync(path.join(mem, name), "", "utf8");

	// Staging file for a different project
	fs.writeFileSync(path.join(mem, "staging", "wrong.json"), JSON.stringify({
		schemaVersion: 1,
		session_id: "wrong",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: otherRoot,
		candidates: { lessons: [], preferences: [], decisions: [], domain: [] },
	}, null, 2));

	const db = openIndex(path.join(mem, "index.db"));
	try {
		const result = await runReconciliation({ projectRoot, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "skipped");
		assert.equal(result.status === "skipped" ? result.reason : "", "no_valid_staging");
		assert.equal(result.counts.stagingFiles.wrongProject, 1);
		assert.equal(result.counts.stagingFiles.preserved, 0, "T9: wrongProject is terminal, not preserved");
		assert.equal(listStagingFiles(mem).length, 1, "wrong-project file left on disk (terminal)");
		assert.equal(listDeadLetterFiles(mem).length, 0);
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function main() {
	await testAllResolvedFileConsumed();
	await testNoResolvedFileDeadLettered();
	await testMixedResolvedAndDeadLettered();
	await testGenerationStoppedCandidatesDeadLettered();
	await testMultiCategoryAllTerminal();
	await testAttemptedUnresolvedIncrements();
	await testAttemptedUnresolvedDeadLettersAtCap();
	await testWrongProjectTerminal();
	console.log("test_t9_staging_consumption passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
