import assert from "node:assert";
import { computeMemoryMenuModel } from "../index.js";

console.log("Running test_memory_menu...");

function recommendedValues(model: ReturnType<typeof computeMemoryMenuModel>): string[] {
	return model.rows.filter((row) => row.recommended).map((row) => row.value);
}

function testStagingRecommendedFirst() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 2, deadLetterCount: 3 });
	assert.equal(model.recommended, "consolidate");
	assert.deepEqual(recommendedValues(model), ["consolidate"]);
	assert.ok(model.rows.some((row) => row.value === "consolidate" && row.count === 2 && row.label.includes("2")));
	assert.ok(model.rows.some((row) => row.value === "recover" && row.count === 3 && row.label.includes("3")));
}

function testDeadLetterRecommendedWhenNoStaging() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 0, deadLetterCount: 1 });
	assert.equal(model.recommended, "recover");
	assert.deepEqual(recommendedValues(model), ["recover"]);
}

function testNoRecommendationWhenNoWork() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 0, deadLetterCount: 0 });
	assert.equal(model.recommended, null);
	assert.deepEqual(recommendedValues(model), []);
	assert.deepEqual(model.rows.map((row) => row.value), ["consolidate", "recover", "inspect"]);
}

function testUninitializedInitOnly() {
	const model = computeMemoryMenuModel({ initialized: false, stagingCount: 5, deadLetterCount: 4 });
	assert.equal(model.recommended, null);
	assert.deepEqual(model.rows.map((row) => row.value), ["init"]);
	assert.deepEqual(recommendedValues(model), []);
}

testStagingRecommendedFirst();
testDeadLetterRecommendedWhenNoStaging();
testNoRecommendationWhenNoWork();
testUninitializedInitOnly();
console.log("test_memory_menu passed!");
