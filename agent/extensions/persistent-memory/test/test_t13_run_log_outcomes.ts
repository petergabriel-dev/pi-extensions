import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReconciliation } from "../consolidation/reconcile.js";
import { writeStaging } from "../consolidation/staging.js";
import { serializeLessonsFile } from "../storage/markdown.js";
import { openIndex } from "../storage/sqlite.js";
import { recordReconcileRun, readRecentReconcileRuns } from "../storage/run-log.js";
import type { Lesson, StagingFile } from "../types.js";

console.log("Running test_t13_run_log_outcomes...");

function existingLesson(): Lesson {
	return {
		id: "lsn_01",
		summary: "Use healthz for health checks",
		detail: "The backend health endpoint is /healthz.",
		meta: {
			project_scope: "testproj",
			status: "active",
			session_level: false,
			reinforcement_count: 1,
			last_seen_at: null,
			source_session: "seed",
			created_at: "2026-01-01T00:00:00.000Z",
			supersedes: null,
			triggers: [{ type: "topic", value: "health" }],
		},
	};
}

function setup(root: string, staging: StagingFile) {
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	fs.writeFileSync(path.join(mem, "lessons.md"), serializeLessonsFile([existingLesson()]), "utf8");
	for (const name of ["preferences.md", "decisions.md", "domain.md"]) fs.writeFileSync(path.join(mem, name), "", "utf8");
	writeStaging(path.join(mem, "staging", `${staging.session_id}.json`), staging);
	return { mem, db: openIndex(path.join(mem, "index.db")) };
}

async function testRunReconciliationOutcomeRows() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t13-run-"));
	const staging: StagingFile = {
		schemaVersion: 1,
		session_id: "s1",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: root,
		candidates: {
			lessons: [
				{
					summary: "Use healthz for health probes",
					detail: "Probe /healthz before backend integration tests.",
					scope_suggestion: "testproj",
					triggers: [{ type: "topic", value: "health" }],
					source_evidence: { discussion_note_ids: [1] },
				},
				{
					summary: "Use health endpoint for probes",
					detail: "Probe the health route before running integration checks.",
					scope_suggestion: "testproj",
					triggers: [{ type: "topic", value: "health" }],
					source_evidence: { discussion_note_ids: [2] },
				},
			],
			preferences: [],
			decisions: [],
			domain: [],
		},
	};
	const { mem, db } = setup(root, staging);
	try {
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, db, {
			rebuildIndex: () => undefined,
			callAdjudicationModel: async () => JSON.stringify({ verdicts: [{ verdict: "duplicate" }] }),
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});
		assert.equal(result.status, "completed");
		assert.ok(result.candidateOutcomes);
		assert.deepEqual(result.candidateOutcomes.map((row) => [row.ref, row.outcome]), [
			["s1:lessons:1", "duplicate"],
			["s1:lessons:2", "dead_lettered"],
		]);
		assert.equal(result.counts.candidate_outcomes.duplicate, 1);
		assert.equal(result.counts.candidate_outcomes.dead_lettered, 1);
		assert.equal(result.candidateMetrics?.total, 2);
		assert.equal(result.candidateMetrics?.discardOrDuplicate, 1);
		assert.equal(result.candidateMetrics?.discardDupRate, 0.5);
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function testRunLogPersistsOutcomesAndMetric() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t13-log-"));
	try {
		const paths = { projectRoot: root, projectMemoryDir: path.join(root, ".pi", "memory"), globalMemoryDir: path.join(root, "global") };
		recordReconcileRun(paths, {
			id: "run-t13",
			source: "manual",
			status: "completed",
			startedAt: "2026-06-10T00:00:00.000Z",
			finishedAt: "2026-06-10T00:00:01.000Z",
			durationMs: 1000,
			candidateOutcomes: [
				{ ref: "s1:lessons:1", category: "lessons", outcome: "duplicate" },
				{ ref: "s1:lessons:2", category: "lessons", outcome: "dead_lettered" },
			],
			candidateMetrics: { total: 2, discardOrDuplicate: 1, discardDupRate: 0.5 },
		}, 5);
		const [record] = readRecentReconcileRuns(paths, 5);
		assert.ok(record);
		assert.equal(record.id, "run-t13");
		assert.equal(record.candidateOutcomes?.length, 2);
		assert.equal(record.candidateOutcomes?.[0]?.outcome, "duplicate");
		assert.equal(record.candidateMetrics?.discardDupRate, 0.5);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function main() {
	await testRunReconciliationOutcomeRows();
	testRunLogPersistsOutcomesAndMetric();

	console.log("test_t13_run_log_outcomes passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
