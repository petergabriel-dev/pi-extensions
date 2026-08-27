#!/usr/bin/env node
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");

const hookPath = path.resolve(__dirname, "docs-nudge.js");
const { GIT_ARGS, handle, isGitCommit, parseStagedPaths } = require(hookPath);

function fakeGit(stdout, error) {
	return (file, args, options, callback) => {
		assert.equal(file, "git");
		assert.deepEqual(args, GIT_ARGS);
		assert.equal(options.encoding, "utf8");
		assert.equal(typeof options.maxBuffer, "number");
		callback(error, stdout, "");
	};
}

function run(raw) {
	const result = cp.spawnSync("node", [hookPath], { input: raw, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout || "{}");
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}: ${error.stack || error.message}`);
		process.exitCode = 1;
	}
}

(async () => {
	await test("nudges code commit without engineering docs", async () => {
		assert.equal(isGitCommit("git commit -m change"), true);
		const result = await handle({ command: "git commit -m change", cwd: "/tmp/project" }, fakeGit("agent/example.ts\0README.md\0"));
		assert.equal(result.permission, "ask");
		assert.match(result.user_message, /docs\/engineering\/architecture\.md/);
		assert.match(result.agent_message, /docs\/engineering/);
	});

	await test("docs-staged commit passes silently", async () => {
		const result = await handle({ command: "git commit -m change", cwd: "/tmp/project" }, fakeGit("agent/example.ts\0docs/engineering/architecture.md\0"));
		assert.deepEqual(result, { permission: "allow" });
	});

	await test("no staged changes pass silently", async () => {
		const result = await handle({ command: "git commit -m change", cwd: "/tmp/project" }, fakeGit(""));
		assert.deepEqual(result, { permission: "allow" });
	});

	await test("non-commit commands do not inspect Git", async () => {
		let called = false;
		const result = await handle({ command: "git status", cwd: "/tmp/project" }, () => { called = true; });
		assert.deepEqual(result, { permission: "allow" });
		assert.equal(called, false);
	});

	await test("malformed input allows without blocking", async () => {
		assert.deepEqual(run("{"), { permission: "allow" });
	});

	await test("Git failure allows without blocking", async () => {
		const result = await handle({ command: "git commit -m change", cwd: "/tmp/project" }, fakeGit("", new Error("git unavailable")));
		assert.deepEqual(result, { permission: "allow" });
	});

	await test("staged path parser bounds output", async () => {
		assert.deepEqual(parseStagedPaths("one\0two\0"), ["one", "two"]);
		assert.throws(() => parseStagedPaths(`${"x\0".repeat(4097)}`), /too many staged paths/);
	});

	if (process.exitCode) process.exit(process.exitCode);
})();
