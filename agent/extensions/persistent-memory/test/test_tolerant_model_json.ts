import assert from "node:assert";
import { normalizeExtractionResult, parseModelJson, sanitizeExtractionResult, validateExtractionResult } from "../consolidation/extract.js";

console.log("Running test_tolerant_model_json...");

const emptyExtraction = {
	candidates: {
		lessons: [],
		preferences: [],
		decisions: [],
		domain: [],
	},
};

{
	const parsed = parseModelJson("```json\n" + JSON.stringify(emptyExtraction) + "\n```");
	assert.deepStrictEqual(parsed, emptyExtraction);
	assert.strictEqual(validateExtractionResult(parsed), true);
}

{
	const raw =
		'{"candidates":{"lessons":[],"preferences":[{"text":"line one' +
		"\n" +
		'line two","source_evidence":{"discussion_note_ids":[1]}}],"decisions":[],"domain":[]}}';
	const parsed = parseModelJson(raw);
	const normalized = normalizeExtractionResult(parsed);
	assert.ok(normalized);
	assert.strictEqual(normalized.preferences[0].text, "line one\nline two");
}

{
	const truncated = '{"candidates":{"lessons":[],"preferences":[],"decisions":[],"domain":[]';
	assert.strictEqual(validateExtractionResult(parseModelJson(truncated)), true);
}

{
	const incoherent = '{"candidates":{"lessons":[{"summary":"missing required fields"}';
	assert.strictEqual(validateExtractionResult(parseModelJson(incoherent)), false);
}

{
	const flattened = {
		lessons: [],
		preferences: [{ text: "Prefer raw model diagnostics.", source_evidence: { discussion_note_ids: [1] } }],
		decisions: [],
		domain: [],
	};
	const normalized = normalizeExtractionResult(flattened);
	assert.ok(normalized);
	assert.equal(normalized.preferences[0].text, "Prefer raw model diagnostics.");
}

{
	const missingArrays = { candidates: { preferences: [{ text: "Missing arrays default empty.", source_evidence: { discussion_note_ids: [1] } }] } };
	const normalized = normalizeExtractionResult(missingArrays);
	assert.ok(normalized);
	assert.equal(normalized.lessons.length, 0);
	assert.equal(normalized.preferences[0].text, "Missing arrays default empty.");
}

{
	const warnings: string[] = [];
	const sanitized = sanitizeExtractionResult({
		candidates: {
			lessons: [],
			preferences: [
				{ text: "keep valid", source_evidence: { discussion_note_ids: [1] } },
				{ text: "drop invalid" },
			],
		},
	}, { warn: (message: string) => warnings.push(message) });
	assert.ok(sanitized);
	assert.deepEqual(sanitized.preferences.map((item) => item.text), ["keep valid"]);
	assert.equal(warnings.length, 1);
}

console.log("test_tolerant_model_json passed!");
