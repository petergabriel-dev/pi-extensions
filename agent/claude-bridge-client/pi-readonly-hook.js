#!/usr/bin/env node
/*
 * Claude Code PreToolUse hook for Pi projects.
 * Zero Pi imports. Enforces read-only in any cwd with .pi ancestor.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const bridgeClient = require("./pi-bridge-mcp.js");

const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const BRIDGE_MCP_PREFIX = "mcp__pi-claude-bridge__";
const READ_PASSTHROUGH_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoRead", "BashOutput", "TaskOutput"]);
function isDir(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isHomeDir(dir, homeReal) {
	if (!homeReal) return false;
	try { return fs.realpathSync(dir) === homeReal; } catch { return false; }
}

function findPiProjectRoot(start) {
	let dir = path.resolve(start || process.cwd());
	let homeReal = null;
	try { homeReal = fs.realpathSync(os.homedir()); } catch { /* no home exclusion */ }
	while (true) {
		if (isDir(path.join(dir, ".pi")) && !isHomeDir(dir, homeReal)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readStdinJson() {
	const raw = fs.readFileSync(0, "utf8");
	return raw.trim() ? JSON.parse(raw) : {};
}

function hookCwd(input) {
	return input.cwd || input.working_directory || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny"
		},
		systemMessage: reason
	};
}

function ask(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask"
		},
		systemMessage: reason
	};
}

function allow(updatedInput) {
	if (!updatedInput) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			updatedInput
		}
	};
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bridgeMcpDecision(input) {
	if (!bridgeClient.isSafeId(input.session_id)) {
		return deny("Pi bridge MCP call denied: missing or invalid session_id.");
	}
	const toolInput = input.tool_input || input.toolInput || input.input;
	if (!isPlainObject(toolInput)) {
		return deny("Pi bridge MCP call denied: tool input must be an object.");
	}
	if (toolInput.sessionId !== undefined && toolInput.sessionId !== input.session_id) {
		return deny("Pi bridge MCP call denied: sessionId does not match session_id.");
	}
	if (toolInput.claudeSessionId !== undefined && toolInput.claudeSessionId !== input.session_id) {
		return deny("Pi bridge MCP call denied: claudeSessionId does not match session_id.");
	}
	if (toolInput.harness !== undefined && toolInput.harness !== "claude") {
		return deny("Pi bridge MCP call denied: harness must be claude.");
	}
	const { claudeSessionId, ...rest } = toolInput;
	return allow({ ...rest, sessionId: input.session_id, harness: "claude" });
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function detectSandboxExec() {
	// Test-only env override: set PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC=1 to force fail-closed path.
	if (process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC === "1") return false;
	return process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
}

function realPathIfExists(p) {
	const resolved = path.resolve(p);
	try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function seatbeltProfile(projectRoot, scratchDir) {
	const root = realPathIfExists(projectRoot);
	const home = realPathIfExists(process.env.HOME || projectRoot);
	const scratch = realPathIfExists(scratchDir);
	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny appleevent-send)",
		"(deny file-write*)",
		`(allow file-write* (literal ${JSON.stringify(scratch)}))`,
		`(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
		"(allow file-write* (literal \"/dev/null\"))",
		`;; repo read-only: ${root}`,
		`;; home read-only: ${home}`
	].join("\n");
}

function wrapBashForSandbox(command, projectRoot) {
	if (!detectSandboxExec()) return null;
	const scratchDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pi-cc-readonly-"));
	const root = realPathIfExists(projectRoot);
	const scratch = realPathIfExists(scratchDir);
	const profile = seatbeltProfile(root, scratch);
	const inner = `cd ${shellQuote(root)} && ${command}`;
	return [
		"/usr/bin/sandbox-exec",
		"-p",
		shellQuote(profile),
		"/usr/bin/env",
		`TMPDIR=${shellQuote(scratch)}`,
		"PYTHONDONTWRITEBYTECODE=1",
		"/bin/bash",
		"-lc",
		shellQuote(inner)
	].join(" ");
}

function bashCommand(input) {
	const toolInput = input.tool_input || input.toolInput || input.input || {};
	return String(toolInput.command || "").trim();
}

function main() {
	let input;
	try {
		input = readStdinJson();
	} catch (error) {
		console.log(JSON.stringify(deny(`Pi read-only hook failed closed: invalid hook input (${error.message}).`)));
		return;
	}

	const projectRoot = findPiProjectRoot(hookCwd(input));
	if (!projectRoot) {
		console.log(JSON.stringify(allow()));
		return;
	}

	const toolName = String(input.tool_name || input.toolName || "");
	if (toolName.startsWith(BRIDGE_MCP_PREFIX)) {
		console.log(JSON.stringify(bridgeMcpDecision(input)));
		return;
	}

	try {
		if (bridgeClient.holdsBuildLease(projectRoot, { harness: "claude", id: input.session_id })) {
			console.log(JSON.stringify(allow()));
			return;
		}
	} catch {}

	if (MUTATION_TOOLS.has(toolName)) {
		console.log(JSON.stringify(deny(`${toolName} is blocked in Pi project ${projectRoot}. Switch to Pi /mode build for mutations.`)));
		return;
	}

	if (toolName === "Bash") {
		const toolInput = input.tool_input || input.toolInput || input.input || {};
		if (toolInput.dangerouslyDisableSandbox) {
			console.log(JSON.stringify(deny("Bash dangerouslyDisableSandbox is blocked in Pi projects; mutations require Pi /mode build.")));
			return;
		}
		const command = bashCommand(input);
		const wrapped = wrapBashForSandbox(command, projectRoot);
		if (wrapped) {
			// macOS Seatbelt sandbox enforces read-only; no Pi bridge policy round-trip required.
			console.log(JSON.stringify(allow({ ...toolInput, command: wrapped })));
			return;
		}
		// Sandbox unavailable: fail closed. No unsandboxed Bash in Pi projects.
		console.log(JSON.stringify(deny(`Bash is blocked in Pi project ${projectRoot}: macOS Seatbelt sandbox (sandbox-exec) is unavailable on this system. Pi read-only Bash requires sandbox-exec.`)));
		return;
	}

	if (READ_PASSTHROUGH_TOOLS.has(toolName)) {
		console.log(JSON.stringify(allow()));
		return;
	}

	console.log(JSON.stringify(ask(`${toolName || "Unknown tool"} is not an allowlisted read-only tool in Pi project. Switch to Pi /mode build for mutations.`)));
}

module.exports = { wrapBashForSandbox };

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.log(JSON.stringify(deny(`Pi read-only hook failed closed: ${error instanceof Error ? error.message : String(error)}.`)));
	}
}
