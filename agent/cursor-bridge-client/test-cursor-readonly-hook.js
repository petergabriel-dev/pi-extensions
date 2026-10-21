#!/usr/bin/env node
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hook = path.resolve(__dirname, "cursor-readonly-hook.js");
const { classifyShell, classifyMcp, classifyTool } = require(hook);
const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
const CURSOR = { harness: "cursor", id: "cursor-conversation-1" };

function tempPiProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-hook-"));
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	return root;
}

function addLeasePresence(root, { paired = true, heartbeatAt = new Date().toISOString(), buildLease = { ...CURSOR, planId: "plan-1", grantedAt: Date.now() } } = {}) {
	const paths = bridgeClient.bridgePaths(root, "pi-cursor-session");
	for (const dir of [paths.root, paths.sessions, paths.namespace, paths.requests, paths.responses, paths.processed]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	}
	const startedAt = new Date().toISOString();
	fs.writeFileSync(paths.presence, JSON.stringify({
		schemaVersion: 2,
		piSessionId: "pi-cursor-session",
		name: "cursor test",
		mode: "plan",
		pid: process.pid,
		startedAt,
		heartbeatAt,
		peers: paired ? [{ ...CURSOR, pendingCount: 0, inboundPendingCount: 0 }] : [],
		buildLease,
	}), { mode: 0o600 });
	fs.chmodSync(paths.presence, 0o600);
	return paths;
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

test("quoted separators stay inside one read segment", () => {
	assert.equal(classifyShell("rg 'a|b' agent").permission, "allow");
	assert.equal(classifyShell('rg "a;b" agent').permission, "allow");
	assert.equal(classifyShell("rg 'cost$' agent").permission, "allow");
});

test("every chained segment must be an allowlisted read", () => {
	assert.equal(classifyShell("rg bridge agent | head").permission, "allow");
	assert.equal(classifyShell("pwd; git status --short").permission, "allow");
	assert.equal(classifyShell("git log -1 --oneline").permission, "allow");
	for (const command of [
		"ls && python3 -c pass",
		"find . -delete",
		"cat script.sh | bash",
		"git diff --output=out.patch",
		"ls;",
	]) assert.equal(classifyShell(command).permission, "ask", command);
});

test("hidden writer flags ask", () => {
	for (const command of [
		"sort -o out.txt input.txt",
		"sort --output=out.txt input.txt",
		"uniq input.txt out.txt",
		"tree -o out.txt",
		"rg --pre ./hook pattern .",
		"find . -exec echo {} +",
		"find . -fprint out.txt",
		"file -C",
		"sed -n 1,5p file",
		"awk '{print}' file",
		"git -c core.pager=cat log",
		"git log --output=out.txt",
		"git diff --ext-diff",
		"/bin/ls -la",
	]) assert.equal(classifyShell(command).permission, "ask", command);
});

test("dynamic and nested shell syntax asks", () => {
	for (const command of [
		"rg $(cat list) .",
		"rg `cat list` .",
		'rg "$(cat list)" .',
		"cat < file",
		"(ls)",
		"{ ls }",
		"ls\ngit status",
	]) assert.equal(classifyShell(command).permission, "ask", command);
});

test("mutating non-bridge MCP denied while Pi bridge allowed", () => {
	const root = tempPiProject();
	assert.equal(classifyMcp({ mcp_server_name: "filesystem", mcp_tool_name: "write_file" }).permission, "deny");
	assert.equal(classifyMcp({ mcp_server_name: "github", mcp_tool_name: "merge_pull_request" }).permission, "ask");
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

test("live lease allows Cursor shell and tools while leaving MCP policy unchanged", () => {
	const root = tempPiProject();
	const paths = addLeasePresence(root);
	const file = path.join(root, "note.txt");
	fs.writeFileSync(file, "original\n", "utf8");
	assertPermission(run({ event: "beforeShellExecution", cwd: root, conversation_id: CURSOR.id, command: "echo changed > note.txt" }), "allow");
	assertPermission(run({ event: "preToolUse", cwd: root, conversation_id: CURSOR.id, tool_name: "Write", tool_input: { path: file, content: "changed\n" } }), "allow");
	assertPermission(run({ event: "preToolUse", cwd: root, conversation_id: CURSOR.id, tool_name: "Edit" }), "allow");
	assertPermission(run({ event: "preToolUse", cwd: root, conversation_id: CURSOR.id, tool_name: "apply_patch" }), "allow");
	assertPermission(run({ event: "beforeMCPExecution", cwd: root, conversation_id: CURSOR.id, mcp_server_name: "filesystem", mcp_tool_name: "write_file" }), "deny");
	assert.equal(fs.readFileSync(file, "utf8"), "original\n");
	assert.deepEqual(fs.readdirSync(paths.requests), []);
});

test("non-holder lease does not bypass Cursor shell or tool denial", () => {
	const root = tempPiProject();
	addLeasePresence(root, { buildLease: { ...CURSOR, id: "another-conversation", planId: "plan-1", grantedAt: Date.now() } });
	assertPermission(run({ event: "beforeShellExecution", cwd: root, conversation_id: CURSOR.id, command: "echo x > file.txt" }), "deny");
	assertPermission(run({ event: "preToolUse", cwd: root, conversation_id: CURSOR.id, tool_name: "Write" }), "deny");
	assertPermission(run({ event: "preToolUse", cwd: root, conversation_id: CURSOR.id, tool_name: "Edit" }), "deny");
});

test("missing or invalid conversation_id keeps Cursor deny behavior", () => {
	const root = tempPiProject();
	addLeasePresence(root);
	for (const conversation_id of [undefined, "../bad"]) {
		assertPermission(run({ event: "beforeShellExecution", cwd: root, conversation_id, command: "echo x > file.txt" }), "deny");
		assertPermission(run({ event: "preToolUse", cwd: root, conversation_id, tool_name: "Write" }), "deny");
	}
});

test("unpaired or stale Cursor lease does not bypass denial", () => {
	const unpairedRoot = tempPiProject();
	addLeasePresence(unpairedRoot, { paired: false });
	assertPermission(run({ event: "preToolUse", cwd: unpairedRoot, conversation_id: CURSOR.id, tool_name: "Write" }), "deny");
	const staleRoot = tempPiProject();
	addLeasePresence(staleRoot, { heartbeatAt: new Date(Date.now() - 6_000).toISOString() });
	assertPermission(run({ event: "beforeShellExecution", cwd: staleRoot, conversation_id: CURSOR.id, command: "echo x > file.txt" }), "deny");
	assertPermission(run({ event: "preToolUse", cwd: staleRoot, conversation_id: CURSOR.id, tool_name: "Edit" }), "deny");
});

test("preToolUse allows read tools and shell/MCP passthrough types", () => {
	const root = tempPiProject();
	for (const tool of ["Read", "Grep", "read_file", "list_dir", "shell", "mcp_tool"]) {
		assert.equal(classifyTool({ tool_name: tool }).permission, "allow", tool);
	}
	assertPermission(run({ event: "preToolUse", cwd: root, tool_name: "Read" }), "allow");
});

test("preToolUse denies mutation and unknown tool names", () => {
	const root = tempPiProject();
	for (const tool of ["Write", "Edit", "MultiEdit", "Delete", "delete_file", "apply_patch", "NotebookEdit", "unknown_tool"]) {
		const classified = classifyTool({ tool_name: tool });
		assert.equal(classified.permission, "deny", tool);
		assert.match(classified.reason, new RegExp(tool), tool);
	}
	const result = run({ event: "preToolUse", cwd: root, tool_name: "apply_patch" });
	assertPermission(result, "deny");
	assert.match(result.user_message, /apply_patch/);
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
