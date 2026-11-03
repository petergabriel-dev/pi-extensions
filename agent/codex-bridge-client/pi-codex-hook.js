#!/usr/bin/env node
/*
 * Codex PreToolUse hook for Pi projects. Zero Pi imports.
 * Without this Codex session's Pi Build lease, a session cwd under a .pi marker stays read-only.
 *
 * Install as: node "<this file>" || { echo 'Pi Codex hook failed closed' >&2; exit 2; }
 * Codex treats exit 2 as a deny only when stderr carries a reason, and fails open on
 * crashes, timeouts, malformed output, and unsupported fields (permissionDecision "ask").
 * So this script must only ever print a supported allow/deny shape, or nothing.
 */

const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
const { classifyShell } = require("../cursor-bridge-client/cursor-readonly-hook.js");

const HARNESS = "codex";
// Codex normalizes MCP server names: the pi-claude-bridge server's tools arrive as mcp__pi_claude_bridge__<tool>.
const BRIDGE_MCP_PREFIX = "mcp__pi_claude_bridge__";
// Codex reports unified exec (exec_command) as Bash; apply_patch carries the whole patch in tool_input.command.
const SHELL_TOOLS = new Set(["Bash"]);
const PATCH_TOOLS = new Set(["apply_patch"]);
// Local function tools that cannot write files or start processes. Everything else in a Pi project is denied.
// The question tool is request_user_input in the CLI and request_user_input_async in the desktop app.
const READ_TOOLS = new Set(["view_image", "update_plan", "request_user_input", "request_user_input_async", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}

// null means allow unchanged: print nothing and exit 0.
function allow(updatedInput) {
	if (!updatedInput) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			updatedInput,
		},
	};
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identity(sessionId) {
	return bridgeClient.isSafeId(sessionId) ? { harness: HARNESS, id: sessionId } : null;
}

function leaseHint(projectRoot) {
	return `Request a Build lease with $pi-build in ${projectRoot}, then approve it in Pi with /build-lease approve.`;
}

// Another session's writer claim wins over the generic hint: a lease request would be refused until it is released.
function nextStep(projectRoot, sessionId) {
	return bridgeClient.writerConflictHint(projectRoot, identity(sessionId)) ?? leaseHint(projectRoot);
}

// Lease identity comes only from the host payload, never from model-supplied arguments.
function bridgeMcpDecision(input) {
	const sessionId = input.session_id;
	if (!bridgeClient.isSafeId(sessionId)) return deny("Pi bridge MCP call denied: missing or invalid Codex session_id.");
	const toolInput = input.tool_input;
	if (!isPlainObject(toolInput)) return deny("Pi bridge MCP call denied: tool input must be an object.");
	if (toolInput.sessionId !== undefined && toolInput.sessionId !== sessionId) return deny("Pi bridge MCP call denied: sessionId does not match this Codex session.");
	if (toolInput.claudeSessionId !== undefined && toolInput.claudeSessionId !== sessionId) return deny("Pi bridge MCP call denied: claudeSessionId does not match this Codex session.");
	if (toolInput.harness !== undefined && toolInput.harness !== HARNESS) return deny("Pi bridge MCP call denied: harness must be codex.");
	const { claudeSessionId, ...rest } = toolInput;
	return allow({ ...rest, sessionId, harness: HARNESS });
}

function decide(input) {
	if (!isPlainObject(input)) return deny("Pi Codex hook failed closed: hook input must be an object.");
	if (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse") return null;
	const toolName = input.tool_name;
	if (typeof toolName !== "string" || toolName === "") return deny("Pi Codex hook failed closed: tool_name is missing.");

	// Identity is enforced for every bridge call, inside or outside a Pi project: the call's own cwd may name one.
	if (toolName.startsWith(BRIDGE_MCP_PREFIX)) return bridgeMcpDecision(input);

	const projectRoot = bridgeClient.findPiProjectRoot(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
	if (!projectRoot) return null;

	const holder = identity(input.session_id);
	if (holder && bridgeClient.holdsBuildLease(projectRoot, holder)) return null;

	if (PATCH_TOOLS.has(toolName)) return deny(`${toolName} is blocked in Pi project ${projectRoot}. ${nextStep(projectRoot, input.session_id)}`);

	if (SHELL_TOOLS.has(toolName)) {
		const command = isPlainObject(input.tool_input) && typeof input.tool_input.command === "string" ? input.tool_input.command.trim() : "";
		const classified = classifyShell(command);
		if (classified.permission === "allow") return null;
		// Codex cannot ask, so anything not provably read-only is denied.
		return deny(`${classified.reason} Read-only shell only in Pi project ${projectRoot}. ${nextStep(projectRoot, input.session_id)}`);
	}

	if (READ_TOOLS.has(toolName)) return null;

	return deny(`${toolName} is not an allowlisted read-only tool in Pi project ${projectRoot}. ${nextStep(projectRoot, input.session_id)}`);
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

// Raw stdin text -> hook output object, or null to allow unchanged. Never throws.
function handle(raw) {
	let input;
	try {
		input = raw.trim() ? JSON.parse(raw) : {};
	} catch (error) {
		return deny(`Pi Codex hook failed closed: invalid hook input (${errorText(error)}).`);
	}
	try {
		return decide(input);
	} catch (error) {
		return deny(`Pi Codex hook failed closed: ${errorText(error)}.`);
	}
}

function main() {
	let output;
	try {
		output = handle(require("node:fs").readFileSync(0, "utf8"));
	} catch (error) {
		output = deny(`Pi Codex hook failed closed: cannot read hook input (${errorText(error)}).`);
	}
	if (output) process.stdout.write(JSON.stringify(output));
}

module.exports = { decide, handle, BRIDGE_MCP_PREFIX, READ_TOOLS };

if (require.main === module) main();
