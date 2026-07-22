import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { formatPlanDocsTagValidation, validatePlanDocsTags } from "../filesystem.ts";

assert.equal(formatPlanDocsTagValidation("No tagged tasks."), "No docs tags found in plan text.");
assert.equal(
	formatPlanDocsTagValidation("- [ ] [DOCS:dev-workflow] Update workflow"),
	"All 1 docs tags valid: [DOCS:dev-workflow]",
);

assert.deepEqual(
	validatePlanDocsTags("[DOCS:architecture][DOCS:traps]"),
	[
		{ tag: "[DOCS:architecture]", valid: true },
		{ tag: "[DOCS:traps]", valid: true },
	],
	"adjacent tags are retained in source order",
);

const bare = validatePlanDocsTags("[DOCS]");
assert.equal(bare.length, 1);
assert.equal(bare[0]?.valid, false);
assert.match(bare[0]?.error ?? "", /Bare \[DOCS\]/);

const designDocs = validatePlanDocsTags("[DOCS:design]");
assert.equal(designDocs[0]?.valid, true);

const unknownDocs = validatePlanDocsTags("[DOCS:operations]");
assert.equal(unknownDocs[0]?.valid, false);
assert.match(unknownDocs[0]?.error ?? "", /Unknown docs area: operations/);

const mixed = validatePlanDocsTags("[DOCS:architecture] [DOCS:operations]");
assert.deepEqual(mixed.map(result => result.valid), [true, false]);
assert.match(formatPlanDocsTagValidation("[DOCS:architecture] [DOCS:operations]"), /^Invalid docs tags found:/);

assert.deepEqual(
	validatePlanDocsTags("[DOCS:decisions][ADR:new]"),
	[
		{ tag: "[DOCS:decisions]", valid: true },
		{ tag: "[ADR:new]", valid: true },
	],
	"valid same-line ADR action satisfies decision pairing",
);

const unpaired = validatePlanDocsTags("[DOCS:decisions]");
assert.equal(unpaired.length, 1, "unpaired decision produces one outcome");
assert.equal(unpaired[0]?.valid, false);
assert.match(unpaired[0]?.error ?? "", /must be accompanied/);

const nextLineAdr = validatePlanDocsTags("[DOCS:decisions]\n[ADR:update]");
assert.equal(nextLineAdr[0]?.valid, false, "ADR action on next line does not satisfy pairing");
assert.equal(nextLineAdr[1]?.valid, true, "standalone valid ADR action remains valid");

const unknownAdr = validatePlanDocsTags("[ADR:merge]");
assert.equal(unknownAdr[0]?.valid, false);
assert.match(unknownAdr[0]?.error ?? "", /Unknown ADR action: merge/);

const tagBlock = "[DOCS:architecture]\n".repeat(1_000);
const largePlan = tagBlock + "x".repeat(100 * 1_024 - tagBlock.length);
assert.equal(largePlan.length, 100 * 1_024, "performance fixture is 100 KB ASCII text");
validatePlanDocsTags(largePlan); // Warm JIT before timing.
const samples = Array.from({ length: 5 }, () => {
	const start = performance.now();
	const results = validatePlanDocsTags(largePlan);
	const elapsed = performance.now() - start;
	assert.equal(results.length, 1_000);
	return elapsed;
}).sort((a, b) => a - b);
const medianMs = samples[Math.floor(samples.length / 2)]!;
assert.ok(medianMs < 10, `100 KB median validation time ${medianMs.toFixed(2)} ms exceeded 10 ms`);

console.log(`tag validator assertions passed; 100 KB median ${medianMs.toFixed(2)} ms`);
