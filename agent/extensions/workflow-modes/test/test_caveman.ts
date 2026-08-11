import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
	CAVEMAN_ENTRY,
	CAVEMAN_PROMPT,
	composeModeMarker,
	composeWorkflowPrompt,
	MODE_LABELS,
	NORMAL_MODE_PROMPT,
	resolveCavemanEnabled,
	type WorkflowPromptSet,
} from "../caveman.js";

const prompts: WorkflowPromptSet = {
	discuss: "DISCUSS",
	plan: "PLAN",
	build: "BUILD",
	review: "REVIEW",
	design: "DESIGN",
};
const state = (enabled: unknown) => ({ type: "custom", customType: CAVEMAN_ENTRY, data: { enabled } });

console.log("Running test_caveman...");

assert.equal(resolveCavemanEnabled([]), true, "new branches must default Caveman ON");
assert.equal(resolveCavemanEnabled([state(false), state(true)]), true, "last valid entry must win");
assert.equal(resolveCavemanEnabled([state(true), state(false)]), false, "explicit OFF must restore");
assert.equal(resolveCavemanEnabled([state(false), state("on")]), false, "invalid entries must not override state");
assert.equal(resolveCavemanEnabled([{ type: "custom", customType: "other", data: { enabled: false } }]), true);

for (const mode of ["discuss", "plan", "build", "review", "design"] as const) {
	const composed = composeWorkflowPrompt(mode, true, prompts);
	assert.ok(composed?.startsWith(`[workflow-modes]\nActive workflow mode: ${MODE_LABELS[mode]}.`), `${mode} authoritative header must come first`);
	assert.ok(composed?.includes(prompts[mode]), `${mode} workflow prompt must be present`);
	assert.ok(composed?.includes("recomputed each turn and supersedes every earlier mode statement"), `${mode} must supersede stale mode statements`);
	assert.ok(composed?.includes("including your own statements and tool-result hints"), `${mode} must supersede assistant and tool-result claims`);
	assert.ok(composed?.includes("Never ask the user to switch to the mode named here"), `${mode} must forbid redundant mode-switch requests`);
	assert.ok(composed?.includes("attempt it once and use the tool result instead of refusing"), `${mode} must require tool evidence`);
	assert.ok(composed?.includes(CAVEMAN_PROMPT), `${mode} must include Caveman while enabled`);
	assert.ok(!composed?.includes(NORMAL_MODE_PROMPT), `${mode} must not include normal override while enabled`);
}

const disabled = composeWorkflowPrompt("design", false, prompts);
assert.ok(disabled?.includes(NORMAL_MODE_PROMPT), "active workflow mode must include normal override while disabled");
assert.ok(!disabled?.includes(CAVEMAN_PROMPT), "disabled workflow mode must omit Caveman prompt");

for (const mode of ["discuss", "plan", "build", "review", "design"] as const) {
	assert.ok(
		composeWorkflowPrompt(mode, true, prompts, "# Saved plan")?.includes("Saved session plan to use when relevant:\n# Saved plan"),
		`${mode} must include saved plan`,
	);
}
assert.equal(composeWorkflowPrompt("off", true, prompts, "# Saved plan"), undefined, "Off must suppress enabled Caveman");
assert.equal(composeWorkflowPrompt("off", false, prompts, "# Saved plan"), undefined, "Off must suppress normal override");

const marker = {
	planId: "plan-a",
	path: "/agent/plans/session-a/plan-a.md",
	savedAt: "2026-07-01T00:00:00.000Z",
	progress: { done: 2, total: 5 },
	nextTask: { id: "task-a", title: "Next task" },
};
const markerMessage = composeModeMarker("build", marker);
assert.deepEqual(markerMessage?.details, marker, "marker must carry O(1) plan identity and progress");
assert.ok(markerMessage?.content.includes("plan-a") && markerMessage.content.includes("2/5") && markerMessage.content.includes("Next task") && markerMessage.content.includes("task-a"), "marker content must carry tracker position");
assert.equal(markerMessage?.content.split("\n").length, 2, "marker must add one tracker line");
assert.equal(JSON.stringify(markerMessage).includes("tasks"), false, "marker must not carry full task list");
assert.equal(composeModeMarker("off", marker), undefined, "Off must not carry marker");

const progressedMarker = composeModeMarker("build", { ...marker, progress: { done: 3, total: 5 }, nextTask: { id: "task-b", title: "Later task" } });
assert.notEqual(progressedMarker?.content, markerMessage?.content, "marker content must reflect progress changes");
const stablePrompt = composeWorkflowPrompt("build", true, prompts, "# Saved plan");
assert.equal(composeWorkflowPrompt("build", true, prompts, "# Saved plan"), stablePrompt, "workflow prompt must ignore mutable marker progress");

const longBranch = Array.from({ length: 10_000 }, (_, index) =>
	index % 2 === 0 ? { type: "message" } : state(index === 9_999 ? false : true));
const startedAt = performance.now();
assert.equal(resolveCavemanEnabled(longBranch), false);
const durationMs = performance.now() - startedAt;
assert.ok(durationMs < 50, `10,000-entry reconstruction took ${durationMs.toFixed(2)} ms`);

console.log(`test_caveman passed (${durationMs.toFixed(2)} ms for 10,000 entries)`);
