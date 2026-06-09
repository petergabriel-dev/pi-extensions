import assert from "node:assert";
import { normalizeExtractionResult, parseModelJson, validateExtractionResult } from "../consolidation/extract.js";

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

console.log("test_tolerant_model_json passed!");
