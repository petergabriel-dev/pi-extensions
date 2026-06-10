import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeExtractionResult, normalizeExtractionResult, runExtraction } from "../consolidation/extract.js";
import { deriveLessonTriggers, stagingPath, writeStaging, readStaging } from "../consolidation/staging.js";
import type { LessonCandidate, StagingFile, Trigger } from "../types.js";

console.log("Running test_t10_validate_at_write...");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validLesson(overrides: Partial<LessonCandidate> = {}): LessonCandidate {
	return {
		summary: overrides.summary ?? "Test lesson summary",
		detail: overrides.detail ?? "Test lesson detail with enough content.",
		triggers: overrides.triggers ?? [{ type: "topic", value: "testing" }],
		scope_suggestion: overrides.scope_suggestion ?? "testproj",
		source_evidence: overrides.source_evidence ?? { discussion_note_ids: [1] },
	};
}

function validPreference() {
	return {
		text: "I prefer tabs over spaces.",
		source_evidence: { discussion_note_ids: [1] },
	};
}

function validDecision() {
	return {
		summary: "Use TypeScript strict mode",
		detail: "We decided to enable strict mode for all new projects.",
		source_evidence: { discussion_note_ids: [1] },
	};
}

function validDomain() {
	return {
		summary: "Project uses Node 22",
		detail: "The project runtime is Node.js 22 LTS.",
		source_evidence: { discussion_note_ids: [1] },
	};
}

function extractionPayload(candidates: {
	lessons?: unknown[];
	preferences?: unknown[];
	decisions?: unknown[];
	domain?: unknown[];
}) {
	return {
		candidates: {
			lessons: candidates.lessons ?? [],
			preferences: candidates.preferences ?? [],
			decisions: candidates.decisions ?? [],
			domain: candidates.domain ?? [],
		},
	};
}

// ---------------------------------------------------------------------------
// T10.1 — sanitizeExtractionResult drops malformed lesson candidates
// ---------------------------------------------------------------------------
function testDropsMalformedLessonCandidates() {
	// Lesson missing required "detail" field
	const malformed = {
		summary: "Incomplete lesson",
		// detail is missing
		triggers: [{ type: "topic", value: "testing" }],
		scope_suggestion: "testproj",
		source_evidence: { discussion_note_ids: [1] },
	};

	const payload = extractionPayload({
		lessons: [malformed, validLesson(), validLesson({ summary: "Another valid lesson" })],
	});

	const result = sanitizeExtractionResult(payload);
	assert.ok(result, "sanitization should succeed with mixed valid/invalid");
	assert.equal(result.lessons.length, 2, "should keep 2 valid lessons, drop 1 malformed");
	assert.equal(result.lessons[0].summary, "Test lesson summary");
	assert.equal(result.lessons[1].summary, "Another valid lesson");
}

// ---------------------------------------------------------------------------
// T10.2 — sanitizeExtractionResult drops malformed preference/decision/domain candidates
// ---------------------------------------------------------------------------
function testDropsMalformedNonLessonCandidates() {
	const malformedPref = { text: "", source_evidence: { discussion_note_ids: [1] } }; // empty text
	const malformedDec = { summary: "", detail: "detail", source_evidence: {} }; // empty summary + no evidence
	const malformedDom = { summary: "Fact", detail: "", source_evidence: {} }; // empty detail + no evidence

	const payload = extractionPayload({
		preferences: [malformedPref, validPreference()],
		decisions: [malformedDec, validDecision()],
		domain: [malformedDom, validDomain()],
	});

	const result = sanitizeExtractionResult(payload);
	assert.ok(result);
	assert.equal(result.preferences.length, 1, "should keep 1 valid preference");
	assert.equal(result.decisions.length, 1, "should keep 1 valid decision");
	assert.equal(result.domain.length, 1, "should keep 1 valid domain");
}

// ---------------------------------------------------------------------------
// T10.3 — sanitizeExtractionResult derives triggers for lessons with missing triggers
// ---------------------------------------------------------------------------
function testDerivesTriggersForMissingTriggers() {
	const lessonNoTriggers = {
		summary: "Atomic writes for staging",
		detail: "Use atomic writes to prevent partial staging files.",
		scope_suggestion: "persistent-memory",
		source_evidence: { discussion_note_ids: [1] },
		// triggers field is missing entirely
	};

	const payload = extractionPayload({ lessons: [lessonNoTriggers] });

	// Strict normalization should reject this (triggers missing)
	const strict = normalizeExtractionResult(payload);
	assert.equal(strict, null, "strict normalization should reject lesson without triggers");

	// Lenient sanitization should derive triggers
	const result = sanitizeExtractionResult(payload);
	assert.ok(result, "sanitization should succeed");
	assert.equal(result.lessons.length, 1);
	const triggers = result.lessons[0].triggers;
	assert.ok(Array.isArray(triggers), "triggers should be an array");
	assert.ok(triggers.length > 0, "triggers should be non-empty");
	assert.equal(triggers[0].type, "topic");
	const topicTrigger = triggers[0] as { type: "topic"; value: string };
	assert.ok(typeof topicTrigger.value === "string" && topicTrigger.value.length > 0, "derived trigger should have a non-empty topic value");

	// Also verify the derived trigger matches what deriveLessonTriggers produces
	const expectedTriggers = deriveLessonTriggers(
		`${lessonNoTriggers.summary}\n${lessonNoTriggers.detail}`,
		undefined,
		lessonNoTriggers.scope_suggestion,
	);
	assert.deepEqual(triggers, expectedTriggers, "derived triggers should match deriveLessonTriggers output");
}

// ---------------------------------------------------------------------------
// T10.4 — sanitizeExtractionResult derives triggers for lessons with empty triggers array
// ---------------------------------------------------------------------------
function testDerivesTriggersForEmptyTriggers() {
	const lessonEmptyTriggers: LessonCandidate = {
		summary: "Keep staging repair pure",
		detail: "Staging repairs should not perform file system I/O.",
		triggers: [],
		scope_suggestion: "persistent-memory",
		source_evidence: { discussion_note_ids: [7] },
	};

	const payload = extractionPayload({ lessons: [lessonEmptyTriggers] });

	// Strict normalization should reject (empty triggers array)
	const strict = normalizeExtractionResult(payload);
	assert.equal(strict, null, "strict normalization should reject lesson with empty triggers");

	// Lenient sanitization should derive triggers
	const result = sanitizeExtractionResult(payload);
	assert.ok(result, "sanitization should succeed");
	assert.equal(result.lessons.length, 1);
	assert.ok(result.lessons[0].triggers.length > 0, "derived triggers should be non-empty");

	// Verify derived triggers match
	const expectedTriggers = deriveLessonTriggers(
		`${lessonEmptyTriggers.summary}\n${lessonEmptyTriggers.detail}`,
		undefined,
		lessonEmptyTriggers.scope_suggestion,
	);
	assert.deepEqual(result.lessons[0].triggers, expectedTriggers);
}

// ---------------------------------------------------------------------------
// T10.5 — sanitizeExtractionResult preserves existing valid triggers
// ---------------------------------------------------------------------------
function testPreservesExistingValidTriggers() {
	const existingTriggers: Trigger[] = [
		{ type: "path", value: "src/consolidation/staging.ts" },
		{ type: "tool", value: "write" },
	];
	const lesson: LessonCandidate = {
		summary: "Lesson with good triggers",
		detail: "This lesson already has valid triggers defined.",
		triggers: existingTriggers,
		scope_suggestion: "persistent-memory",
		source_evidence: { discussion_note_ids: [5] },
	};

	const payload = extractionPayload({ lessons: [lesson] });

	// Both strict and lenient should accept this
	const strict = normalizeExtractionResult(payload);
	assert.ok(strict, "strict normalization should accept lesson with valid triggers");
	assert.deepEqual(strict.lessons[0].triggers, existingTriggers);

	const result = sanitizeExtractionResult(payload);
	assert.ok(result, "sanitization should accept lesson with valid triggers");
	assert.deepEqual(result.lessons[0].triggers, existingTriggers, "existing triggers preserved unchanged");
	assert.equal(result.lessons[0].triggers.length, 2);
}

// ---------------------------------------------------------------------------
// T10.6 — sanitizeExtractionResult returns null for structurally broken input
// ---------------------------------------------------------------------------
function testReturnsNullForBrokenStructure() {
	// Missing candidates wrapper
	assert.equal(sanitizeExtractionResult({}), null, "should return null for empty object");
	assert.equal(sanitizeExtractionResult({ candidates: null }), null, "should return null for null candidates");
	assert.equal(sanitizeExtractionResult({ candidates: { lessons: "not-array", preferences: [], decisions: [], domain: [] } }), null);
	assert.equal(sanitizeExtractionResult({ candidates: { lessons: [], preferences: "bad", decisions: [], domain: [] } }), null);
	assert.equal(sanitizeExtractionResult({ candidates: { lessons: [], preferences: [], decisions: 123, domain: [] } }), null);
	assert.equal(sanitizeExtractionResult({ candidates: { lessons: [], preferences: [], decisions: [], domain: null } }), null);
}

// ---------------------------------------------------------------------------
// T10.7 — sanitizeExtractionResult keeps zero candidates when all are malformed
// ---------------------------------------------------------------------------
function testAllMalformedYieldsEmpty() {
	const payload = extractionPayload({
		lessons: [
			{ summary: "", detail: "detail", scope_suggestion: "x", triggers: [], source_evidence: {} }, // empty summary
		],
		preferences: [
			{ text: "", source_evidence: {} }, // empty text + no evidence
		],
	});

	const result = sanitizeExtractionResult(payload);
	assert.ok(result, "should return a result, not null");
	assert.equal(result.lessons.length, 0, "all lessons malformed → empty");
	assert.equal(result.preferences.length, 0, "all preferences malformed → empty");
	assert.equal(result.decisions.length, 0, "no decisions");
	assert.equal(result.domain.length, 0, "no domain");
}

// ---------------------------------------------------------------------------
// T10.8 — Triggers are derived without requiring a model call (no careful-model)
// ---------------------------------------------------------------------------
function testTriggerDerivationIsDeterministic() {
	const summary = "Prefer atomic writes for staging files.";
	const detail = "When writing staging files, use atomic write to avoid partial corruption.";
	const scope = "persistent-memory";

	const triggers1 = deriveLessonTriggers(`${summary}\n${detail}`, undefined, scope);
	const triggers2 = deriveLessonTriggers(`${summary}\n${detail}`, undefined, scope);
	assert.deepEqual(triggers1, triggers2, "deriveLessonTriggers must be deterministic (no model)");
	assert.ok(triggers1.length > 0);
	assert.equal(triggers1[0].type, "topic");
}

// ---------------------------------------------------------------------------
// T10.9 — Full extraction write-path integration: sanitized staging is valid
// ---------------------------------------------------------------------------
function testSanitizedStagingPassesStrictNormalization() {
	// Mixed payload: one valid lesson with triggers, one without triggers, one malformed
	const payload = extractionPayload({
		lessons: [
			validLesson({ summary: "Good lesson A" }),
			{
				summary: "Lesson B missing triggers",
				detail: "This lesson has no triggers field at all.",
				scope_suggestion: "testproj",
				source_evidence: { discussion_note_ids: [2] },
				// triggers missing
			},
			{
				// malformed: missing detail
				summary: "Bad lesson C",
				scope_suggestion: "testproj",
				triggers: [{ type: "topic", value: "bad" }],
				source_evidence: { discussion_note_ids: [3] },
			},
		],
		preferences: [
			validPreference(),
			{ text: "", source_evidence: {} }, // malformed
		],
	});

	// Sanitize
	const sanitized = sanitizeExtractionResult(payload);
	assert.ok(sanitized);
	assert.equal(sanitized.lessons.length, 2, "2 valid lessons (A kept, B repaired, C dropped)");
	assert.equal(sanitized.preferences.length, 1, "1 valid preference");
	assert.equal(sanitized.decisions.length, 0);
	assert.equal(sanitized.domain.length, 0);

	// Lesson A: triggers preserved
	assert.equal(sanitized.lessons[0].summary, "Good lesson A");
	assert.deepEqual(sanitized.lessons[0].triggers, [{ type: "topic", value: "testing" }]);

	// Lesson B: triggers derived
	assert.equal(sanitized.lessons[1].summary, "Lesson B missing triggers");
	assert.ok(sanitized.lessons[1].triggers.length > 0, "Lesson B should have derived triggers");

	// Now verify that the sanitized result would pass strict normalization
	// (simulating what the reconcile loader does)
	const stagingWrapper = {
		schemaVersion: 1,
		session_id: "test-session",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: "/tmp/testproj",
		candidates: sanitized,
	};

	// normalizeStagingFile uses normalizeExtractionResult internally
	const strictCheck = normalizeExtractionResult({ candidates: stagingWrapper.candidates });
	assert.ok(strictCheck, "sanitized result should pass strict normalization");
	assert.equal(strictCheck.lessons.length, 2);
	assert.equal(strictCheck.preferences.length, 1);
	assert.ok(strictCheck.lessons[1].triggers.length > 0, "derived triggers pass strict check");
}

// ---------------------------------------------------------------------------
// T10.10 — End-to-end staging write: sanitized candidates written to disk are clean
// ---------------------------------------------------------------------------
function testWriteSanitizedStagingToDisk() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t10-write-"));
	const stagingDir = path.join(root, "staging");
	fs.mkdirSync(stagingDir, { recursive: true });
	try {
		const payload = extractionPayload({
			lessons: [
				validLesson({ summary: "Clean lesson" }),
				{
					summary: "Repaired lesson",
					detail: "This lesson needs trigger derivation.",
					scope_suggestion: "testproj",
					source_evidence: { discussion_note_ids: [4] },
					// triggers missing → will be derived
				},
			],
		});

		const sanitized = sanitizeExtractionResult(payload);
		assert.ok(sanitized);
		assert.equal(sanitized.lessons.length, 2);

		const staging: StagingFile = {
			schemaVersion: 1,
			session_id: "t10-test",
			produced_at: "2026-06-10T00:00:00.000Z",
			project_root: root,
			candidates: sanitized,
		};

		const filePath = stagingPath(root, "t10-test");
		writeStaging(filePath, staging);

		// Read it back and verify
		const read = readStaging(filePath);
		assert.ok(read, "staging file should be readable");
		assert.equal(read.candidates.lessons.length, 2, "both lessons should be present");
		assert.equal(read.candidates.lessons[0].summary, "Clean lesson");
		assert.deepEqual(read.candidates.lessons[0].triggers, [{ type: "topic", value: "testing" }]);
		assert.equal(read.candidates.lessons[1].summary, "Repaired lesson");
		assert.ok(read.candidates.lessons[1].triggers.length > 0, "repaired lesson has derived triggers");

		// Verify the staging file passes strict normalization (reconcile loader path)
		const strictCheck = normalizeExtractionResult({ candidates: read.candidates });
		assert.ok(strictCheck, "written staging passes strict normalization");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// T10.11 — runExtraction writes only sanitized candidates to staging
// ---------------------------------------------------------------------------
async function testRunExtractionWritesOnlySanitizedCandidates() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-t10-run-"));
	const memoryDir = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(memoryDir, "staging"), { recursive: true });
	try {
		const payload = extractionPayload({
			lessons: [
				{
					summary: "Needs derived trigger",
					detail: "The extractor omitted triggers, so write-time validation should repair them.",
					scope_suggestion: "testproj",
					source_evidence: { discussion_note_ids: [1] },
				},
				{ summary: "Malformed", triggers: [{ type: "topic", value: "bad" }], scope_suggestion: "testproj", source_evidence: { discussion_note_ids: [2] } },
			],
			preferences: [validPreference(), { text: "", source_evidence: { discussion_note_ids: [3] } }],
		});

		const result = await runExtraction(
			{
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: "discussion-notes", data: { schemaVersion: 1, notes: [{ type: "lesson" }] } }],
				},
			},
			{ projectRoot: root, projectMemoryDir: memoryDir, globalMemoryDir: memoryDir },
			"t10-run",
			{
				callCarefulModel: async () => JSON.stringify(payload),
				now: () => new Date("2026-06-10T00:00:00.000Z"),
				logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
			},
		);

		assert.equal(result.status, "written");
		assert.equal(result.status === "written" ? result.totalCandidates : 0, 2, "only repaired lesson + valid preference are written");
		const staging = readStaging(path.join(memoryDir, "staging", "t10-run.json"));
		assert.ok(staging);
		assert.equal(staging.candidates.lessons.length, 1);
		assert.ok(staging.candidates.lessons[0].triggers.length > 0, "lesson reaches staging with non-empty triggers");
		assert.equal(staging.candidates.preferences.length, 1);
		assert.ok(normalizeExtractionResult({ candidates: staging.candidates }), "staged candidates pass strict normalization");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

async function main() {
	testDropsMalformedLessonCandidates();
	testDropsMalformedNonLessonCandidates();
	testDerivesTriggersForMissingTriggers();
	testDerivesTriggersForEmptyTriggers();
	testPreservesExistingValidTriggers();
	testReturnsNullForBrokenStructure();
	testAllMalformedYieldsEmpty();
	testTriggerDerivationIsDeterministic();
	testSanitizedStagingPassesStrictNormalization();
	testWriteSanitizedStagingToDisk();
	await testRunExtractionWritesOnlySanitizedCandidates();

	console.log("test_t10_validate_at_write passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
