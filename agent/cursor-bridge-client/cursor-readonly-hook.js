#!/usr/bin/env node
/*
 * Cursor hook for Pi projects. Zero Pi imports.
 * Enforces read-only client behavior for any cwd under a .pi marker.
 */

const fs = require("node:fs");
const path = require("node:path");

const PI_BRIDGE_SERVERS = new Set(["pi-claude-bridge", "pi-bridge", "pi"]);
const READ_ONLY_COMMAND_RE = /^(pwd|ls|find|rg|grep|cat|head|tail|wc|jq|tree|diff|stat|file|sort|uniq|column)(\s|$)|^git\s+(diff|log|show|status|blame)(\s|$)|^sed\s+-n(\s|$)|^awk(\s|$)/;
const MUTATING_COMMAND_RE = /(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|git\s+(commit|add|reset|checkout|switch|merge|rebase|cherry-pick|apply|am|clean|stash|push)|npm\s+(install|i|ci|update|audit\s+fix)|pnpm\s+(install|i|update)|yarn\s+(add|install|upgrade)|pip\s+install|python\s+-m\s+pip\s+install)(\s|$)|(^|[^<])>>?|<<|\|\s*(tee|xargs\s+rm)\b/;
const MUTATING_MCP_RE = /(^|_)(write|edit|delete|remove|create|update|insert|patch|mutate|apply|commit|save)(_|$)/i;

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
	return input.cwd || input.workspaceRoot || input.workspace_root || input.projectRoot || input.project_root || process.cwd();
}

function eventName(input) {
	return String(input.hook_event_name || input.hookEventName || input.event || input.type || "");
}

function hookResult(permission, message) {
	return {
		permission,
		...(message ? { user_message: message, agent_message: message } : {}),
	};
}

function allow() { return hookResult("allow"); }
function ask(message) { return hookResult("ask", message); }
function deny(message) { return hookResult("deny", message); }

function commandFromInput(input) {
	return String(input.command || input.shell_command || input.shellCommand || input.tool_input?.command || input.toolInput?.command || "").trim();
}

function classifyShell(command) {
	if (!command) return { permission: "ask", reason: "Empty shell command in Pi project." };
	if (MUTATING_COMMAND_RE.test(command)) return { permission: "deny", reason: "Shell command appears to mutate files or repo state." };
	if (READ_ONLY_COMMAND_RE.test(command)) return { permission: "allow" };
	return { permission: "ask", reason: "Shell command is not clearly read-only." };
}

function serverName(input) {
	return String(input.mcp_server_name || input.server || input.serverName || input.server_name || input.mcp_server || input.mcpServer || input.tool?.server || "");
}

function mcpToolName(input) {
	return String(input.mcp_tool_name || input.name || input.toolName || input.tool_name || input.mcp_tool || input.mcpTool || input.tool?.name || "");
}

function classifyMcp(input) {
	const server = serverName(input);
	const tool = mcpToolName(input);
	if (PI_BRIDGE_SERVERS.has(server)) return { permission: "allow" };
	if (MUTATING_MCP_RE.test(tool)) return { permission: "deny", reason: `MCP tool ${server ? `${server}/` : ""}${tool || "<unknown>"} appears mutating and is not the Pi bridge.` };
	return { permission: "ask", reason: `MCP tool ${server ? `${server}/` : ""}${tool || "<unknown>"} is not known read-only.` };
}

function toolType(input) {
	const tool = input.tool_name || input.toolName || input.tool_type || input.toolType || (typeof input.tool === "string" ? input.tool : input.tool?.name) || "";
	return String(tool).trim();
}

function classifyTool(input) {
	const tool = toolType(input);
	if (!tool) return { permission: "deny", reason: "preToolUse is missing tool type." };
	if (tool.toLowerCase() === "write") return { permission: "deny", reason: "Write tool would mutate files in Pi project." };
	return { permission: "allow" };
}

function handle(input) {
	const projectRoot = findPiProjectRoot(hookCwd(input));
	if (!projectRoot) return allow();
	const event = eventName(input);
	if (event === "beforeShellExecution") {
		const classified = classifyShell(commandFromInput(input));
		if (classified.permission === "allow") return allow();
		if (classified.permission === "deny") return deny(`${classified.reason} Use Pi /mode build for mutations.`);
		return ask(`${classified.reason} Continue only if this is read-only.`);
	}
	if (event === "beforeMCPExecution") {
		const classified = classifyMcp(input);
		if (classified.permission === "allow") return allow();
		if (classified.permission === "deny") return deny(`${classified.reason} Use pi-claude-bridge for Pi state.`);
		return ask(`${classified.reason} Continue only if this cannot mutate state.`);
	}
	if (event === "preToolUse") {
		const classified = classifyTool(input);
		if (classified.permission === "allow") return allow();
		return deny(`${classified.reason} Use Pi /mode build for mutations.`);
	}
	return deny(`Unknown Cursor hook event ${event || "<missing>"} in Pi project.`);
}

function main() {
	try {
		console.log(JSON.stringify(handle(readStdinJson())));
	} catch (error) {
		console.log(JSON.stringify(deny(`Pi Cursor hook failed closed: ${error instanceof Error ? error.message : String(error)}.`)));
	}
}

if (require.main === module) main();

module.exports = { classifyShell, classifyMcp, classifyTool, handle, findPiProjectRoot };
