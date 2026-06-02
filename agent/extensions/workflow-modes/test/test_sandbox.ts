import assert from "node:assert";
import { detectLauncher, wrapCommand } from "../sandbox.js";

console.log("Running test_sandbox...");

{
	const launcher = detectLauncher();
	assert.strictEqual(launcher, "none");
}

{
	const result = wrapCommand("pwd", { cwd: process.cwd() });
	assert.deepStrictEqual(result, {
		launcher: "none",
		command: "pwd",
		wrapped: false,
	});
}

console.log("test_sandbox passed!");
