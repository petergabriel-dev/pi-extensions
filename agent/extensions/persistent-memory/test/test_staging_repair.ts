import assert from "node:assert";
import { normalizeStagingFile } from "../consolidation/reconcile.js";
import { deriveLessonTriggers, repairStagingFile } from "../consolidation/staging.js";

console.log("Running test_staging_repair...");

function testDeriveLessonTriggersReturnsValidTopic() {
	const triggers = deriveLessonTriggers("Prefer atomic writes for staging files.", { project_root: "/tmp/example-project" }, "project");
	assert.deepEqual(triggers, [{ type: "topic", value: "example-project" }]);
	assert.deepEqual(deriveLessonTriggers("", {}, "fallback-scope"), [{ type: "topic", value: "fallback-scope" }]);
	assert.deepEqual(deriveLessonTriggers("Prefer atomic writes for staging files.", {}, ""), [{ type: "topic", value: "prefer atomic writes staging" }]);
	assert.ok(normalizeStagingFile({
		schemaVersion: 1,
		session_id: "session-derive",
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: "/tmp/example-project",
		candidates: {
			lessons: [{
				summary: "Atomic staging writes",
				detail: "Prefer atomic writes for staging files.",
				triggers,
				scope_suggestion: "project",
				source_evidence: { discussion_note_ids: [1] },
			}],
			preferences: [],
			decisions: [],
			domain: [],
		},
	}), "derived trigger should be accepted by staging normalization");
}

function testRepairBackfillsMissingLessonTriggers() {
	const raw = {
		schemaVersion: 1,
		session_id: "session-missing",
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: "/tmp/example-project",
		candidates: {
			lessons: [{
				summary: "Backfill missing triggers",
				detail: "Missing trigger fields should be repaired without weakening normalization.",
				scope_suggestion: "persistent-memory",
				source_evidence: { discussion_note_ids: [8] },
			}],
			preferences: [],
			decisions: [],
			domain: [],
		},
	};

	const repaired = repairStagingFile(raw);
	assert.ok(repaired, "repair should return a staging file");
	assert.deepEqual(repaired.candidates.lessons[0].triggers, [{ type: "topic", value: "example-project" }]);
	assert.ok(normalizeStagingFile(repaired), "repaired staging file should pass staging normalization");
}

function testRepairBackfillsEmptyLessonTriggers() {
	const raw = {
		schemaVersion: 1,
		session_id: "session-1",
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: "/tmp/example-project",
		candidates: {
			lessons: [{
				summary: "Keep staging repair pure",
				detail: "Staging repairs should not perform file system I/O.",
				triggers: [],
				scope_suggestion: "persistent-memory",
				source_evidence: { discussion_note_ids: [7] },
				reconcile_attempts: 2,
			}],
			preferences: [],
			decisions: [],
			domain: [],
		},
	};

	const repaired = repairStagingFile(raw);
	assert.ok(repaired, "repair should return a staging file");
	assert.deepEqual(repaired.candidates.lessons[0].triggers, [{ type: "topic", value: "example-project" }]);
	assert.equal(repaired.candidates.lessons[0].reconcile_attempts, 2);
	assert.ok(normalizeStagingFile(repaired), "repaired staging file should pass staging normalization");
}

function testRepairRejectsMissingStagingShape() {
	assert.equal(repairStagingFile({ schemaVersion: 1, candidates: { lessons: [] } }), null);
}

testDeriveLessonTriggersReturnsValidTopic();
testRepairBackfillsMissingLessonTriggers();
testRepairBackfillsEmptyLessonTriggers();
testRepairRejectsMissingStagingShape();

console.log("test_staging_repair passed");
