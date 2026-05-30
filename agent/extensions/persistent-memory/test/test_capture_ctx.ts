import assert from "node:assert";
import { captureCtx } from "../lifecycle.js";

console.log("Running test_capture_ctx...");

// Test captureCtx with getter-backed properties and subsequent mutation/invalidation
{
	let liveCwd = "/original/cwd";
	let isStale = false;
	const mutableCtx = {
		get cwd() {
			if (isStale) {
				throw new Error("Stale ctx!");
			}
			return liveCwd;
		},
		model: { id: "gemini-flash" },
		modelRegistry: { get: () => {} },
		thinkingLevel: "low" as const,
	};

	// Capture the context
	const captured = captureCtx(mutableCtx);

	// Invalidate the source context
	liveCwd = "/new/cwd";
	isStale = true;

	// Verify that the captured context retains original values and does not throw (is detached)
	assert.strictEqual(captured.cwd, "/original/cwd");
	assert.deepStrictEqual(captured.model, { id: "gemini-flash" });
	assert.strictEqual(captured.thinkingLevel, "low");
}

console.log("test_capture_ctx passed!");
