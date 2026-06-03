import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadValidSameProjectStaging, normalizeStagingFile, runReconciliation } from "../consolidation/reconcile.js";
import { listDeadLetterFiles, listStagingFiles, readDeadLetter, stagingPath, writeStaging } from "../consolidation/staging.js";
import type { StagingFile } from "../types.js";

console.log("Running test_reconcile_loader_repair_quarantine...");

function makeTempMemory(): { root: string; memoryDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-loader-"));
	const memoryDir = path.join(root, ".pi", "memory", "project");
	fs.mkdirSync(path.join(memoryDir, "staging"), { recursive: true });
	for (const fileName of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) {
		fs.writeFileSync(path.join(memoryDir, fileName), "", "utf-8");
	}
	return { root, memoryDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function repairableStaging(projectRoot: string): StagingFile {
	return {
		schemaVersion: 1,
		session_id: "claude-code-repairable",
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: projectRoot,
		candidates: {
			lessons: [{
				summary: "Repair bridge lesson triggers",
				detail: "Bridge-captured lessons with empty triggers should be backfilled by the loader.",
				triggers: [],
				scope_suggestion: "project",
				source_evidence: { discussion_note_ids: [1] },
			}],
			preferences: [],
			decisions: [],
			domain: [],
		},
	};
}

async function testRepairableMalformedFileIsRepairedAndConsumedByReconciliation() {
	const temp = makeTempMemory();
	try {
		const filePath = stagingPath(temp.memoryDir, "claude-code-repairable");
		writeStaging(filePath, repairableStaging(temp.root));
		assert.equal(normalizeStagingFile(JSON.parse(fs.readFileSync(filePath, "utf-8"))), null, "fixture starts malformed");

		const result = await runReconciliation({ projectRoot: temp.root, projectMemoryDir: temp.memoryDir, globalMemoryDir: temp.memoryDir }, {} as any, {
			rebuildIndex: () => undefined,
			callCarefulModel: async () => JSON.stringify({
				lessons: [{
					action: "add",
					candidate_refs: ["claude-code-repairable:lessons:1"],
					summary: "Repair bridge lesson triggers",
					detail: "Bridge-captured lessons with empty triggers should be backfilled by the loader.",
					triggers: [{ type: "topic", value: "bridge staging" }],
				}],
				preferences: [],
				decisions: [],
				domain: [],
			}),
		});

		assert.equal(result.status, "completed");
		assert.equal(result.counts.stagingFiles.valid, 1);
		assert.equal(result.counts.stagingFiles.deadLettered, 0);
		assert.equal(result.counts.stagingFiles.preserved, 0);
		assert.deepEqual(result.counts.candidates.deadLettered, { lessons: 0, preferences: 0, decisions: 0, domain: 0 });
		assert.equal(listStagingFiles(temp.memoryDir).length, 0, "repaired valid file should be consumed by reconciliation");
		assert.equal(listDeadLetterFiles(temp.memoryDir).length, 0);
	} finally {
		temp.cleanup();
	}
}

function testRepairableMalformedFileIsRewrittenAndLoaded() {
	const temp = makeTempMemory();
	try {
		const filePath = stagingPath(temp.memoryDir, "claude-code-repairable");
		writeStaging(filePath, repairableStaging(temp.root));
		assert.equal(normalizeStagingFile(JSON.parse(fs.readFileSync(filePath, "utf-8"))), null, "fixture starts malformed");

		const loaded = loadValidSameProjectStaging([filePath], temp.root, temp.memoryDir);

		assert.equal(loaded.valid.length, 1);
		assert.deepEqual(loaded.deadLettered, []);
		assert.deepEqual(loaded.deadLetteredCandidates, { lessons: 0, preferences: 0, decisions: 0, domain: 0 });
		assert.equal(listDeadLetterFiles(temp.memoryDir).length, 0);
		const rewritten = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.ok(normalizeStagingFile(rewritten), "repairable file should be rewritten as valid staging");
		assert.deepEqual(rewritten.candidates.lessons[0].triggers, [{ type: "topic", value: path.basename(temp.root) }]);
	} finally {
		temp.cleanup();
	}
}

function testUnrepairableMalformedFileIsDeadLetteredAndRemoved() {
	const temp = makeTempMemory();
	try {
		const filePath = stagingPath(temp.memoryDir, "broken");
		const raw = {
			schemaVersion: 1,
			session_id: "broken",
			produced_at: "2026-01-01T00:00:00.000Z",
			project_root: temp.root,
			candidates: {
				lessons: [{
					summary: "Missing detail cannot be repaired",
					triggers: [],
					scope_suggestion: "project",
					source_evidence: { discussion_note_ids: [2] },
					reconcile_attempts: 3,
				}],
				preferences: [],
				decisions: [],
				domain: [],
			},
		};
		fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

		const loaded = loadValidSameProjectStaging([filePath], temp.root, temp.memoryDir);

		assert.equal(loaded.valid.length, 0);
		assert.deepEqual(loaded.deadLettered, [filePath]);
		assert.deepEqual(loaded.deadLetteredCandidates, { lessons: 1, preferences: 0, decisions: 0, domain: 0 });
		assert.equal(listStagingFiles(temp.memoryDir).length, 0, "unrepairable file should leave staging");
		const deadLetterFiles = listDeadLetterFiles(temp.memoryDir);
		assert.equal(deadLetterFiles.length, 1);
		const deadLetter = readDeadLetter(deadLetterFiles[0]);
		assert.ok(deadLetter, "deadletter should be readable by /memory deadletter storage helpers");
		assert.equal(deadLetter.category, "lessons");
		assert.equal(deadLetter.session_id, "broken");
		assert.equal(deadLetter.attempts, 3);
		assert.equal(deadLetter.last_gate_reason, "malformed staging file");
		assert.deepEqual(deadLetter.candidate.candidate, raw.candidates.lessons[0]);
		assert.deepEqual(deadLetter.candidate.original_staging_file, raw);
	} finally {
		temp.cleanup();
	}
}

function testWrongProjectMalformedFileIsPreserved() {
	const temp = makeTempMemory();
	try {
		const otherRoot = path.join(temp.root, "other");
		const filePath = stagingPath(temp.memoryDir, "wrong-project");
		fs.writeFileSync(filePath, JSON.stringify({ ...repairableStaging(otherRoot), project_root: otherRoot }, null, 2));

		const loaded = loadValidSameProjectStaging([filePath], temp.root, temp.memoryDir);

		assert.equal(loaded.valid.length, 0);
		assert.deepEqual(loaded.wrongProject, [filePath]);
		assert.deepEqual(loaded.deadLettered, []);
		assert.equal(listStagingFiles(temp.memoryDir).length, 1, "wrong-project staging remains preserved");
		assert.equal(listDeadLetterFiles(temp.memoryDir).length, 0);
	} finally {
		temp.cleanup();
	}
}

(async () => {
	await testRepairableMalformedFileIsRepairedAndConsumedByReconciliation();
	testRepairableMalformedFileIsRewrittenAndLoaded();
	testUnrepairableMalformedFileIsDeadLetteredAndRemoved();
	testWrongProjectMalformedFileIsPreserved();

	console.log("test_reconcile_loader_repair_quarantine passed");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
