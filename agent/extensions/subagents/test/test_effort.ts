import assert from "node:assert/strict";

import {
	parseEffortLevel,
	resolveEffort,
	type SubagentEffortLevel,
} from "../effort.ts";

const levels: SubagentEffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

for (const level of levels) assert.equal(parseEffortLevel(level), level);
assert.equal(parseEffortLevel("inherit"), "inherit");

for (const invalid of ["xhihg", "", "OFF", 1, {}, null, undefined]) {
	assert.equal(parseEffortLevel(invalid), undefined);
}

assert.equal(resolveEffort({ effort: { worker: "high" } }, "worker", "low"), "high");
assert.equal(resolveEffort({ effort: { worker: "xhihg" } }, "worker", "low"), "low");
assert.equal(resolveEffort(undefined, "worker", "medium"), "medium");
assert.equal(resolveEffort({ effort: {} }, "worker"), undefined);
assert.equal(resolveEffort({ effort: { worker: "inherit" } }, "worker", "high"), "high");

console.log("test_effort: ok");
