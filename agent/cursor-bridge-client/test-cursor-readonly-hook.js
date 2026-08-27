#!/usr/bin/env node
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hook = path.resolve(__dirname, "cursor-readonly-hook.js");
const { classifyShell, classifyMcp, classifyTool } = require(hook);

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

function assertPermission(result, expected) {
	assert.equal(result.permission, expected);
	assert.equal("decision" in result, false);
	assert.equal("message" in result, false);
	if (expected !== "allow") {
		assert.equal(typeof result.user_message, "string");
		assert.equal(typeof result.agent_message, "string");
	}
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
	assert.equal(classifyShell("echo x > file.txt").permission, "deny");
	assert.equal(classifyShell("rm -rf tmp").permission, "deny");
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "echo x > file.txt" });
	assertPermission(result, "deny");
});

test("read-only shell allowed", () => {
	assert.equal(classifyShell("rg bridge agent").permission, "allow");
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "rg bridge agent" });
	assertPermission(result, "allow");
});

test("ambiguous shell asks", () => {
	const root = tempPiProject();
	const result = run({ event: "beforeShellExecution", cwd: root, command: "node script.js" });
	assertPermission(result, "ask");
});

test("mutating non-bridge MCP denied while Pi bridge allowed", () => {
	const root = tempPiProject();
	assert.equal(classifyMcp({ mcp_server_name: "filesystem", mcp_tool_name: "write_file" }).permission, "deny");
	assertPermission(run({ event: "beforeMCPExecution", cwd: root, mcp_server_name: "filesystem", mcp_tool_name: "write_file" }), "deny");
	assertPermission(run({ event: "beforeMCPExecution", cwd: root, mcp_server_name: "pi-claude-bridge", mcp_tool_name: "save_plan" }), "allow");
	assertPermission(run({ event: "beforeMCPExecution", cwd: root, mcp_server_name: "pi-claude-bridge", mcp_tool_name: "recall_memory" }), "allow");
});

test("preToolUse denies Write before bytes reach disk", () => {
	const root = tempPiProject();
	const file = path.join(root, "note.txt");
	fs.writeFileSync(file, "original\n", "utf8");
	const result = run({ event: "preToolUse", cwd: root, tool_name: "Write", tool_input: { path: file, content: "changed\n" } });
	assertPermission(result, "deny");
	assert.match(result.user_message, /Write tool/);
	assert.equal(fs.readFileSync(file, "utf8"), "original\n");
});

test("preToolUse allows non-Write tools", () => {
	const root = tempPiProject();
	assert.equal(classifyTool({ tool_name: "Read" }).permission, "allow");
	assertPermission(run({ event: "preToolUse", cwd: root, tool_name: "Read" }), "allow");
});

test("afterFileEdit no longer writes or reverts", () => {
	const root = tempPiProject();
	const file = path.join(root, "note.txt");
	fs.writeFileSync(file, "changed\n", "utf8");
	const result = run({ event: "afterFileEdit", cwd: root, filePath: file, beforeContent: "original\n" });
	assertPermission(result, "deny");
	assert.equal("reverted" in result, false);
	assert.equal(fs.readFileSync(file, "utf8"), "changed\n");
});

test("malformed hook input fails closed", () => {
	const result = run({}, "{");
	assertPermission(result, "deny");
	assert.match(result.user_message, /failed closed/);
});

if (process.exitCode) process.exit(process.exitCode);
