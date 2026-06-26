import assert from "node:assert";
import { logFiring, getSessionFiringLog, clearFiringLog } from "../retrieval/firing-log.js";

console.log("Running test_firing_log...");

// 1. Basic logging and retrieval
clearFiringLog();
assert.strictEqual(getSessionFiringLog().length, 0);

logFiring({
	lesson_id: "test-lesson-1",
	trigger: { type: "topic", value: "test-topic" },
	fired_at: new Date().toISOString(),
	context_summary: "test-context",
	tier: 1,
});

assert.strictEqual(getSessionFiringLog().length, 1);
assert.strictEqual(getSessionFiringLog()[0].lesson_id, "test-lesson-1");

// 2. Clear firing log works
clearFiringLog();
assert.strictEqual(getSessionFiringLog().length, 0);

// 3. Firing log persists until manual consolidation clears it.
logFiring({
	lesson_id: "test-lesson-2",
	trigger: { type: "topic", value: "test-topic" },
	fired_at: new Date().toISOString(),
	context_summary: "test-context",
	tier: 1,
});

assert.strictEqual(getSessionFiringLog().length, 1);
assert.strictEqual(getSessionFiringLog()[0].lesson_id, "test-lesson-2");

clearFiringLog();
assert.strictEqual(getSessionFiringLog().length, 0, "Firing log clears only when manual consolidation/reinforcement succeeds or explicit clear is called");

console.log("test_firing_log passed!");
