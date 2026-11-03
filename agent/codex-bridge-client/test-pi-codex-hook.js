#!/usr/bin/env node
/* Codex PreToolUse hook tests. Zero Pi imports. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const client = require("../claude-bridge-client/pi-bridge-mcp.js");
const hook = require("./pi-codex-hook.js");

const SID = "01a1a1d0-d93a-7d71-a0ba-1bca624c4fce"; // Codex session_id is UUIDv7
const OTHER_SID = "01a1a1d2-4c00-7183-8771-7ce57ae3df2b";
const CODEX = { harness: "codex", id: SID };
const LEASE_TTL_MS = 4 * 60 * 60 * 1000;
const HOOK_PATH = path.join(__dirname, "pi-codex-hook.js");

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

function setupProject() {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-hook-")));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	return cwd;
}

function addSession(cwd, piSessionId, peers, { heartbeatAt = new Date().toISOString(), buildLease } = {}) {
	const paths = client.bridgePaths(cwd, piSessionId);
	for (const dir of [path.join(cwd, ".pi", "memory", "bridge"), paths.sessions, paths.namespace, paths.requests, paths.responses, paths.processed]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	}
	writeJson(paths.presence, {
		schemaVersion: 2,
		piSessionId,
		name: `name-${piSessionId}`,
		mode: "plan",
		pid: process.pid,
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		heartbeatAt,
		peers,
		...(buildLease ? { buildLease } : {}),
	});
}

function lease(peer, overrides = {}) {
	const grantedAt = Date.now();
	return { harness: peer.harness, id: peer.id, planId: "plan-1", grantedAt, expiresAt: grantedAt + LEASE_TTL_MS, ...overrides };
}

function pre(cwd, tool_name, tool_input = {}, session_id = SID) {
	return { hook_event_name: "PreToolUse", session_id, cwd, tool_name, tool_input, turn_id: "t1", tool_use_id: "u1", permission_mode: "default", model: "m" };
}

function withoutSession(payload) {
	const { session_id, ...rest } = payload;
	return rest;
}

function decision(output) {
	return output === null ? "allow" : output.hookSpecificOutput.permissionDecision;
}

function assertDeny(output, pattern, label) {
	assert.equal(decision(output), "deny", label);
	assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(typeof output.hookSpecificOutput.permissionDecisionReason, "string");
	if (pattern) assert.match(output.hookSpecificOutput.permissionDecisionReason, pattern, label);
	// Codex fails open on unsupported fields; only the supported deny shape may appear.
	assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
	assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
}

function withProject(name, fn) {
	const cwd = setupProject();
	try {
		fn(cwd);
		console.log(`PASS ${name}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function outsideDir() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-outside-")));
}

// --- input validation and fail-closed paths
assertDeny(hook.decide([]), /must be an object/, "array input");
assertDeny(hook.decide({ hook_event_name: "PreToolUse", cwd: os.tmpdir() }), /tool_name is missing/, "missing tool_name");
assert.equal(hook.decide({ hook_event_name: "SessionStart", session_id: SID }), null, "non-PreToolUse events are a no-op");
assertDeny(hook.handle("{not json"), /invalid hook input/, "invalid JSON");
assertDeny(hook.handle(""), /tool_name is missing/, "empty stdin");
{
	const original = client.findPiProjectRoot;
	client.findPiProjectRoot = () => { throw new Error("boom"); };
	try {
		assertDeny(hook.handle(JSON.stringify(pre(os.tmpdir(), "apply_patch"))), /failed closed: boom/, "in-script crash denies");
	} finally {
		client.findPiProjectRoot = original;
	}
}
console.log("PASS input validation and in-script crash fail closed");

// --- bridge MCP identity, enforced inside and outside Pi projects
for (const cwd of [outsideDir(), setupProject()]) {
	const tool = `${hook.BRIDGE_MCP_PREFIX}capture_note`;
	const injected = hook.decide(pre(cwd, tool, { notes: [], claudeSessionId: SID }));
	assert.deepEqual(injected, {
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { notes: [], sessionId: SID, harness: "codex" } },
	}, "host identity is injected and claudeSessionId dropped");
	assert.equal(decision(hook.decide(pre(cwd, tool, { sessionId: SID, harness: "codex" }))), "allow", "matching identity");
	assertDeny(hook.decide(pre(cwd, tool, { sessionId: OTHER_SID })), /sessionId does not match/, "spoofed sessionId");
	assertDeny(hook.decide(pre(cwd, tool, { claudeSessionId: OTHER_SID })), /claudeSessionId does not match/, "spoofed claudeSessionId");
	assertDeny(hook.decide(pre(cwd, tool, { harness: "claude" })), /harness must be codex/, "spoofed harness");
	assertDeny(hook.decide(pre(cwd, tool, "text")), /must be an object/, "non-object bridge input");
	assertDeny(hook.decide(pre(cwd, tool, {}, "../escape")), /session_id/, "invalid host session_id");
	assertDeny(hook.decide(withoutSession(pre(cwd, tool, {}))), /session_id/, "missing host session_id");
	// Claude's hyphenated prefix is not Codex's bridge; it is a foreign tool name.
	assert.equal(tool.startsWith("mcp__pi_claude_bridge__"), true);
	fs.rmSync(cwd, { recursive: true, force: true });
}
console.log("PASS bridge MCP identity comes from the host session_id only");

// --- outside a Pi project the hook stays out of the way
{
	const cwd = outsideDir();
	for (const [tool, input] of [["apply_patch", { command: "*** Begin Patch" }], ["Bash", { command: "rm -rf build" }], ["mcp__github__create_issue", {}], ["some_future_tool", {}]]) {
		assert.equal(hook.decide(pre(cwd, tool, input)), null, `outside project: ${tool}`);
	}
	fs.rmSync(cwd, { recursive: true, force: true });
	console.log("PASS outside a Pi project every tool passes");
}

// --- inside a Pi project without a lease: read-only, deny-unknown
withProject("no lease: patch, writing shell, unknown, and foreign MCP are denied; reads pass", (cwd) => {
	assertDeny(hook.decide(pre(cwd, "apply_patch", { command: "*** Begin Patch\n*** Add File: x\n+hi\n*** End Patch" })), /\$pi-build/, "apply_patch");
	for (const command of ["rm -rf build", "echo hi > f.txt", "git commit -m x", "ls $(pwd)", "cat a; touch b", "npm install", ""]) {
		assertDeny(hook.decide(pre(cwd, "Bash", { command })), /Read-only shell only/, `Bash ${JSON.stringify(command)}`);
	}
	assertDeny(hook.decide(pre(cwd, "Bash", {})), /Read-only shell only/, "Bash without command");
	for (const command of ["rg -n foo", "ls -la", "git status", "cat README.md | head -5", "find . -name '*.ts'"]) {
		assert.equal(hook.decide(pre(cwd, "Bash", { command })), null, `read-only Bash ${command}`);
	}
	for (const tool of hook.READ_TOOLS) assert.equal(hook.decide(pre(cwd, tool)), null, `read tool ${tool}`);
	for (const tool of ["spawn_agent", "write_stdin", "mcp__github__create_issue", "mcp__pi-claude-bridge__save_plan", "Edit", "Write", "some_future_tool"]) {
		assertDeny(hook.decide(pre(cwd, tool)), /not an allowlisted read-only tool/, tool);
	}
	// Subdirectories resolve to the same project.
	const sub = path.join(cwd, "src");
	fs.mkdirSync(sub);
	assertDeny(hook.decide(pre(sub, "apply_patch")), /Pi project/, "apply_patch from subdirectory");
});

// --- lease holder may write; nobody else may
withProject("matching unexpired lease allows writes for its holder only", (cwd) => {
	addSession(cwd, "pi-a", [CODEX], { buildLease: lease(CODEX) });
	assert.equal(hook.decide(pre(cwd, "apply_patch", { command: "*** Begin Patch" })), null, "holder apply_patch");
	assert.equal(hook.decide(pre(cwd, "Bash", { command: "rm -rf build" })), null, "holder writing shell");
	assert.equal(hook.decide(pre(cwd, "some_future_tool")), null, "holder unknown tool");
	assertDeny(hook.decide(pre(cwd, "apply_patch", {}, OTHER_SID)), /blocked/, "other codex session");
	assertDeny(hook.decide(withoutSession(pre(cwd, "apply_patch", {}))), /blocked/, "missing session_id");
	// A spoofed bridge identity cannot borrow the holder's session.
	assertDeny(hook.decide(pre(cwd, `${hook.BRIDGE_MCP_PREFIX}tick_plan_task`, { sessionId: SID }, OTHER_SID)), /does not match/, "spoofed bridge sessionId");
});

withProject("lease held by another harness with the same id does not match", (cwd) => {
	addSession(cwd, "pi-a", [{ harness: "claude", id: SID }], { buildLease: lease({ harness: "claude", id: SID }) });
	assertDeny(hook.decide(pre(cwd, "apply_patch")), /blocked/, "claude lease, codex caller");
});

withProject("expired lease is read-only", (cwd) => {
	const grantedAt = Date.now() - LEASE_TTL_MS - 1_000;
	addSession(cwd, "pi-a", [CODEX], { buildLease: lease(CODEX, { grantedAt, expiresAt: grantedAt + LEASE_TTL_MS }) });
	assertDeny(hook.decide(pre(cwd, "apply_patch")), /blocked/, "expired lease");
});

withProject("stale presence is read-only", (cwd) => {
	addSession(cwd, "pi-a", [CODEX], { heartbeatAt: new Date(Date.now() - 60_000).toISOString(), buildLease: lease(CODEX) });
	assertDeny(hook.decide(pre(cwd, "apply_patch")), /blocked/, "stale heartbeat");
});

withProject("absent presence is read-only", (cwd) => {
	assertDeny(hook.decide(pre(cwd, "apply_patch")), /blocked/, "no bridge presence");
});

// --- end-to-end through stdin, as Codex runs it
withProject("script prints only supported shapes and exits 0", (cwd) => {
	const run = (input) => spawnSync(process.execPath, [HOOK_PATH], { cwd, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 5_000 });
	const denied = run(pre(cwd, "apply_patch"));
	assert.equal(denied.status, 0);
	assert.equal(denied.stderr, "");
	assertDeny(JSON.parse(denied.stdout), /blocked/, "stdin deny");
	const allowed = run(pre(cwd, "Bash", { command: "ls" }));
	assert.equal(allowed.status, 0);
	assert.equal(allowed.stdout, "", "allow prints nothing");
	const malformed = run("{not json");
	assert.equal(malformed.status, 0);
	assertDeny(JSON.parse(malformed.stdout), /invalid hook input/, "stdin malformed");
	// Codex runs hooks with the session cwd as working directory; a payload without cwd still resolves the project.
	const noCwd = run({ hook_event_name: "PreToolUse", session_id: SID, tool_name: "apply_patch", tool_input: {} });
	assertDeny(JSON.parse(noCwd.stdout), /blocked/, "process cwd fallback");
});

console.log("codex hook tests passed");
