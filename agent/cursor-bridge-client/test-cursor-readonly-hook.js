#!/usr/bin/env node
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hook = path.resolve(__dirname, "cursor-readonly-hook.js");
const { classifyShell } = require(hook);

function tempPiProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-hook-"));
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	return root;
}

function run(input, raw) {
	const out = cp.spawnSync("node", [hook], { input: raw ?? JSON.stringify(input), encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	return JSON.parse(out.stdout || "{}");
}

function test(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}: ${error.stack || error.message}`);
		process.exitCode = 1;
	}
}

test("mutating shell classified deny", () => {
	assert.equal(classifyShell("echo x > file.txt").decision, "deny");
	assert.equal(classifyShell("rm -rf tmp").decision, "deny");
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "echo x > file.txt" });
	assert.equal(result.decision, "deny");
});

test("read-only shell allowed", () => {
	assert.equal(classifyShell("rg bridge agent").decision, "allow");
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "rg bridge agent" });
	assert.equal(result.decision, "allow");
});

test("ambiguous shell asks", () => {
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "node script.js" });
	assert.equal(result.decision, "ask");
});

test("mutating non-bridge MCP denied while Pi bridge allowed", () => {
	const root = tempPiProject();
	assert.equal(run({ event: "beforeMCPExecution", cwd: root, server: "filesystem", name: "write_file" }).decision, "deny");
	assert.equal(run({ event: "beforeMCPExecution", cwd: root, server: "pi-claude-bridge", name: "save_plan" }).decision, "allow");
});

test("afterFileEdit restores original bytes and fails loud", () => {
	const root = tempPiProject();
	const file = path.join(root, "note.txt");
	fs.writeFileSync(file, "changed\n", "utf8");
	const result = run({ event: "afterFileEdit", cwd: root, filePath: file, beforeContent: "original\n" });
	assert.equal(result.decision, "deny");
	assert.equal(result.reverted, true);
	assert.match(result.message, /reverted/);
	assert.equal(fs.readFileSync(file, "utf8"), "original\n");
});

test("malformed hook input fails closed", () => {
	const result = run({}, "{");
	assert.equal(result.decision, "deny");
	assert.match(result.message, /failed closed/);
});

if (process.exitCode) process.exit(process.exitCode);
