import assert from "node:assert";
import { buildSubmitPlanTool, extractLastAssistantText, extractSubmitPlanToolArguments, SUBMIT_PLAN_TOOL_NAME } from "../consolidation/careful-model.js";
import { parseModelJson, validateExtractionResult } from "../consolidation/extract.js";
import { EXTRACTION_SYSTEM_PROMPT, RECONCILIATION_SYSTEM_PROMPT } from "../consolidation/prompts.js";

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

// Forced structured output reads submit_plan tool-call arguments directly.
{
	const plan = {
		candidates: {
			lessons: [],
			preferences: [{ text: "Prefer focused tests.", source_evidence: { discussion_note_ids: [1] } }],
			decisions: [],
			domain: [],
		},
	};
	const extracted = extractSubmitPlanToolArguments({
		role: "assistant",
		content: [
			{ type: "text", text: "ignored free text" },
			{ type: "toolCall", id: "call_1", name: SUBMIT_PLAN_TOOL_NAME, arguments: plan },
		],
	} as never);

	assert.strictEqual(extracted, JSON.stringify(plan));
	assert.strictEqual(validateExtractionResult(parseModelJson(extracted!)), true);
}

// No submit_plan call leaves callers on the existing free-text/salvage path.
{
	const extracted = extractSubmitPlanToolArguments({
		role: "assistant",
		content: [{ type: "text", text: validExtractionJson }],
	} as never);
	assert.strictEqual(extracted, null);
}

// Tool schemas are registered under the single custom tool name and use TypeBox-shaped JSON schema.
{
	const extractionTool = buildSubmitPlanTool(EXTRACTION_SYSTEM_PROMPT);
	const reconciliationTool = buildSubmitPlanTool(RECONCILIATION_SYSTEM_PROMPT);
	assert.strictEqual(extractionTool.name, SUBMIT_PLAN_TOOL_NAME);
	assert.strictEqual(reconciliationTool.name, SUBMIT_PLAN_TOOL_NAME);

	const extractionSchema = JSON.stringify(extractionTool.parameters);
	const reconciliationSchema = JSON.stringify(reconciliationTool.parameters);
	assert.match(extractionSchema, /candidates/);
	assert.match(reconciliationSchema, /candidate_refs/);
	assert.doesNotMatch(extractionSchema, /__optional|__schema/);
	assert.doesNotMatch(reconciliationSchema, /__optional|__schema/);
	assert.deepStrictEqual((extractionTool.parameters as any).required, ["candidates"]);
	assert.deepStrictEqual((reconciliationTool.parameters as any).required, ["lessons", "preferences", "decisions", "domain"]);
	assert.ok(extractionSchema.includes("lesson_candidate_marker_ids"));
}

console.log("test_careful_model_extract passed!");
