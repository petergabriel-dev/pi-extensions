import assert from "node:assert";
import * as path from "node:path";
import { normalizeStagingFile } from "../consolidation/reconcile.js";
import { deriveLessonTriggers } from "../consolidation/staging.js";

console.log("Running test_bridge_capture_staging...");

function testBridgeShapedLessonCandidateNormalizes() {
	const projectRoot = "/tmp/example-project";
	const noteText = "When staging bridge-captured lessons, derive a non-empty topic trigger before reconciliation.";
	const payloadContext = "claude bridge capture";
	const scopeSuggestion = path.basename(projectRoot);
	const triggerContext = { topic: payloadContext, project_root: projectRoot };

	const staged = {
		schemaVersion: 1,
		session_id: "claude-code-session-1",
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: projectRoot,
		candidates: {
			lessons: [{
				summary: noteText.slice(0, 96),
				detail: noteText,
				triggers: deriveLessonTriggers(noteText, triggerContext, scopeSuggestion),
				scope_suggestion: scopeSuggestion,
				source_evidence: {
					discussion_note_ids: [42],
					source: "claude-code",
					request_id: "request-1",
					bridge_session_id: "bridge-session-1",
					claude_session_id: "session-1",
					context: payloadContext,
				},
			}],
			preferences: [],
			decisions: [],
			domain: [],
		},
	};

	const normalized = normalizeStagingFile(staged);
	assert.ok(normalized, "bridge-shaped lesson candidate should pass staging normalization");
	assert.deepEqual(normalized.candidates.lessons[0].triggers, [{ type: "topic", value: payloadContext }]);
}

testBridgeShapedLessonCandidateNormalizes();

console.log("test_bridge_capture_staging passed");
