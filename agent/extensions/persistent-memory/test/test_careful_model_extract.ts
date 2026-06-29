import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSubmitPlanTool, extractLastAssistantText, extractSubmitPlanToolArguments, SUBMIT_PLAN_TOOL_NAME } from "../consolidation/careful-model.js";
import { RawModelResponseError, parseModelJson, runExtraction, validateExtractionResult } from "../consolidation/extract.js";
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

// Invalid extraction schema carries truncated raw model output for diagnostics.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-extract-raw-"));
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	const raw = JSON.stringify({ nope: "x".repeat(3000) });
	const result = await runExtraction({
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "discussion-notes", data: { schemaVersion: 1, notes: [{ type: "preference" }] } }],
		},
	}, { projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, "s1", {
		callCarefulModel: async () => raw,
		logger: {},
	});
	if (result.status !== "failed") throw new Error(`expected failed extraction, got ${result.status}`);
	assert.equal(result.reason, "invalid_schema");
	assert.ok(result.error instanceof RawModelResponseError);
	assert.match(result.error.rawModelResponse, /nope/);
	assert.ok(result.error.rawModelResponse.length < raw.length);
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
