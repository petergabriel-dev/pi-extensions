#!/usr/bin/env node
/*
 * Claude Code PreToolUse hook for Pi projects.
 * Zero Pi imports. Enforces read-only in any cwd with .pi ancestor.
 */

const fs = require("node:fs");
const path = require("node:path");

const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function isDir(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function findPiProjectRoot(start) {
	let dir = path.resolve(start || process.cwd());
	while (true) {
		if (isDir(path.join(dir, ".pi"))) return dir;
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

	console.log(JSON.stringify(allow()));
}

main();
