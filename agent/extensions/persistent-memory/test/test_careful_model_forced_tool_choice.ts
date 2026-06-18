import assert from "node:assert";
import { forcedToolChoiceForApi, SUBMIT_PLAN_TOOL_NAME } from "../consolidation/careful-model.js";

console.log("Running test_careful_model_forced_tool_choice...");

assert.deepStrictEqual(forcedToolChoiceForApi("openai-completions"), {
	type: "function",
	function: { name: SUBMIT_PLAN_TOOL_NAME },
});
assert.deepStrictEqual(forcedToolChoiceForApi("mistral-conversations"), {
	type: "function",
	function: { name: SUBMIT_PLAN_TOOL_NAME },
});
assert.deepStrictEqual(forcedToolChoiceForApi("anthropic-messages"), {
	type: "tool",
	name: SUBMIT_PLAN_TOOL_NAME,
});
assert.deepStrictEqual(forcedToolChoiceForApi("bedrock-converse-stream"), {
	type: "tool",
	name: SUBMIT_PLAN_TOOL_NAME,
});
assert.strictEqual(forcedToolChoiceForApi("google-generative-ai"), "any");
assert.strictEqual(forcedToolChoiceForApi("google-vertex"), "any");

for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses", "unknown-api"]) {
	assert.strictEqual(forcedToolChoiceForApi(api), null, `${api} must skip forced submit_plan path`);
}

console.log("test_careful_model_forced_tool_choice passed!");
