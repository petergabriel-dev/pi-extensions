import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReconciliation } from "../consolidation/reconcile.js";
import { listDeadLetterFiles, listStagingFiles, readStaging, writeStaging } from "../consolidation/staging.js";
import { parseLessonsFile, serializeLessonsFile } from "../storage/markdown.js";
import { openIndex } from "../storage/sqlite.js";
import type { Lesson, StagingFile, Trigger } from "../types.js";

console.log("Running test_per_candidate_reconcile...");

type LessonCandidate = StagingFile["candidates"]["lessons"][number];

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

function setup(existing: Lesson[], candidates: LessonCandidate[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-per-candidate-"));
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	fs.writeFileSync(path.join(mem, "lessons.md"), serializeLessonsFile(existing), "utf8");
	for (const name of ["preferences.md", "decisions.md", "domain.md"]) fs.writeFileSync(path.join(mem, name), "", "utf8");
	writeStaging(path.join(mem, "staging", "s1.json"), {
		schemaVersion: 1,
		session_id: "s1",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: root,
		candidates: { lessons: candidates, preferences: [], decisions: [], domain: [] },
	});
	const db = openIndex(path.join(mem, "index.db"));
	return { root, mem, db };
}

function stagedLessons(mem: string): LessonCandidate[] {
	return listStagingFiles(mem).flatMap((file) => readStaging(file)?.candidates.lessons ?? []);
}

async function testMixedBatchFailureIsolation() {
	const { root, mem, db } = setup(
		[
			existingLesson("lsn_01", "Auth workflow", "Use password login for auth."),
			existingLesson("lsn_02", "Build failure", "Build fails when cache is stale."),
		],
		[
			lessonCandidate("Banana pancake recipe", "Mix flour eggs and banana.", undefined, [{ type: "topic", value: "cooking" }]),
			lessonCandidate("Auth workflow token update", "Use token login for auth."),
			lessonCandidate("Build failure timeout", "Build fails when remote cache times out."),
		],
	);
	let calls = 0;
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			adjudicationBatchSize: 1,
			callAdjudicationModel: async () => {
				calls += 1;
				if (calls === 1) return JSON.stringify({ verdicts: [{ verdict: "supersedes" }] });
				throw new Error("simulated single-candidate adjudication failure");
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(calls, 2);
		assert.equal(result.counts.actions.add.lessons, 1, "deterministic add counted");
		assert.equal(result.counts.actions.supersede, 1, "supersede fired");

		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		assert.ok(lessons.some((lesson) => lesson.summary === "Banana pancake recipe"), "non-colliding candidate committed");
		const oldAuth = lessons.find((lesson) => lesson.id === "lsn_01");
		assert.ok(oldAuth);
		assert.equal(oldAuth.meta.status, "superseded", "old auth lesson superseded");
		assert.ok(lessons.some((lesson) => lesson.meta.status === "active" && lesson.meta.supersedes === "lsn_01"), "new superseding auth lesson committed");

		// T9: failed candidate dead-lettered immediately, not re-staged.
		const staged = stagedLessons(mem);
		assert.equal(staged.length, 0, "T9: no leftovers survive in staging");
		assert.equal(listDeadLetterFiles(mem).length, 1, "failed candidate dead-lettered");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testSingleFailedCandidateDeadLettersImmediately() {
	// T9: all leftovers dead-lettered immediately; the max-attempts env var is a no-op.
	const { root, mem, db } = setup(
		[existingLesson("lsn_01", "Build failure", "Build fails when cache is stale.")],
		[lessonCandidate("Build failure timeout", "Build fails when remote cache times out.", 1)],
	);
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			adjudicationBatchSize: 1,
			callAdjudicationModel: async () => { throw new Error("always fails"); },
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});

		assert.equal(result.status, "completed");
		assert.equal(stagedLessons(mem).length, 0, "T9: staging file deleted (terminal)");
		assert.equal(listDeadLetterFiles(mem).length, 1, "failed candidate dead-lettered");
		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		assert.equal(lessons.length, 1, "existing committed records remain untouched");
		assert.equal(lessons[0].id, "lsn_01");
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function main() {
	await testMixedBatchFailureIsolation();
	await testSingleFailedCandidateDeadLettersImmediately();
	console.log("test_per_candidate_reconcile passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
