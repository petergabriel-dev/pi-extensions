import assert from "node:assert";
import { extractLastAssistantText } from "../consolidation/careful-model.js";
import { parseModelJson, validateExtractionResult } from "../consolidation/extract.js";

console.log("Running test_careful_model_extract...");

function makeSession(messages: unknown[], direct = "") {
	return {
		getLastAssistantText: () => direct,
		messages,
	} as never;
}

const validExtractionJson = JSON.stringify({
	candidates: {
		lessons: [],
		preferences: [],
		decisions: [],
		domain: [],
	},
});

// Thinking-only assistant output is salvaged so downstream JSON parsing can proceed.
{
	const extracted = extractLastAssistantText(
		makeSession([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: validExtractionJson }],
			},
		]),
	);

	assert.strictEqual(extracted, validExtractionJson);
	assert.strictEqual(validateExtractionResult(parseModelJson(extracted)), true);
}

// Real text parts keep precedence over thinking content.
{
	const textJson = JSON.stringify({
		marker: "text",
		candidates: {
			lessons: [],
			preferences: [],
			decisions: [],
			domain: [],
		},
	});
	const thinkingJson = JSON.stringify({
		marker: "thinking",
		candidates: {
			lessons: [],
			preferences: [],
			decisions: [],
			domain: [],
		},
	});

	const extracted = extractLastAssistantText(
		makeSession([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: thinkingJson },
					{ type: "text", text: textJson },
				],
			},
		]),
	);

	assert.strictEqual(extracted, textJson);
	assert.strictEqual(validateExtractionResult(parseModelJson(extracted)), true);
}

console.log("test_careful_model_extract passed!");
