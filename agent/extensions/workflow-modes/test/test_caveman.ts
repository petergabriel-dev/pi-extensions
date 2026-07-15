import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
	CAVEMAN_ENTRY,
	CAVEMAN_PROMPT,
	composeWorkflowPrompt,
	NORMAL_MODE_PROMPT,
	resolveCavemanEnabled,
	type WorkflowPromptSet,
} from "../caveman.js";

const prompts: WorkflowPromptSet = {
	discuss: "DISCUSS",
	plan: "PLAN",
	build: "BUILD",
};
const state = (enabled: unknown) => ({ type: "custom", customType: CAVEMAN_ENTRY, data: { enabled } });

console.log("Running test_caveman...");

assert.equal(resolveCavemanEnabled([]), true, "new branches must default Caveman ON");
assert.equal(resolveCavemanEnabled([state(false), state(true)]), true, "last valid entry must win");
assert.equal(resolveCavemanEnabled([state(true), state(false)]), false, "explicit OFF must restore");
assert.equal(resolveCavemanEnabled([state(false), state("on")]), false, "invalid entries must not override state");
assert.equal(resolveCavemanEnabled([{ type: "custom", customType: "other", data: { enabled: false } }]), true);

for (const mode of ["discuss", "plan", "build"] as const) {
	const composed = composeWorkflowPrompt(mode, true, prompts);
	assert.ok(composed?.startsWith(prompts[mode]), `${mode} workflow prompt must come first`);
	assert.ok(composed?.includes(CAVEMAN_PROMPT), `${mode} must include Caveman while enabled`);
	assert.ok(!composed?.includes(NORMAL_MODE_PROMPT), `${mode} must not include normal override while enabled`);
}

const disabled = composeWorkflowPrompt("plan", false, prompts);
assert.ok(disabled?.includes(NORMAL_MODE_PROMPT), "active workflow mode must include normal override while disabled");
assert.ok(!disabled?.includes(CAVEMAN_PROMPT), "disabled workflow mode must omit Caveman prompt");

const buildWithPlan = composeWorkflowPrompt("build", true, prompts, "# Saved plan");
assert.ok(buildWithPlan?.includes("Saved session plan to use when relevant:\n# Saved plan"));
assert.equal(composeWorkflowPrompt("plan", true, prompts, "# Saved plan")?.includes("# Saved plan"), false);
assert.equal(composeWorkflowPrompt("off", true, prompts, "# Saved plan"), undefined, "Off must suppress enabled Caveman");
assert.equal(composeWorkflowPrompt("off", false, prompts, "# Saved plan"), undefined, "Off must suppress normal override");

const longBranch = Array.from({ length: 10_000 }, (_, index) =>
	index % 2 === 0 ? { type: "message" } : state(index === 9_999 ? false : true));
const startedAt = performance.now();
assert.equal(resolveCavemanEnabled(longBranch), false);
const durationMs = performance.now() - startedAt;
assert.ok(durationMs < 50, `10,000-entry reconstruction took ${durationMs.toFixed(2)} ms`);

console.log(`test_caveman passed (${durationMs.toFixed(2)} ms for 10,000 entries)`);
