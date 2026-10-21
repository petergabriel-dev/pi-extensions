#!/usr/bin/env node
/*
 * Cursor hook for Pi projects. Zero Pi imports.
 * Enforces read-only client behavior for any cwd under a .pi marker.
 */

const fs = require("node:fs");
const path = require("node:path");

const PI_BRIDGE_SERVERS = new Set(["pi-claude-bridge", "pi-bridge", "pi"]);
// Cursor routes shell and MCP through dedicated events; allow those types here so the dedicated classifier decides.
const PRE_TOOL_READ_TOOLS = new Set([
	"read", "read_file", "read_multiple_files", "grep", "grep_search", "glob", "file_search",
	"list", "list_dir", "ls", "find", "search", "codebase_search", "semantic_search",
	"web_search", "webfetch", "fetch", "get_file_contents",
]);
const PRE_TOOL_PASSTHROUGH_TOOLS = new Set([
	"shell", "bash", "terminal", "run_terminal_cmd", "run_command",
	"mcp", "mcp_tool", "mcptool", "mcp_execution", "call_mcp_tool",
]);
const READ_ONLY_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "stat", "file", "tree", "diff", "grep", "rg", "find", "jq", "sort", "uniq", "column", "git"]);
const GIT_READ_SUBCOMMANDS = new Set(["status", "log", "show", "diff", "blame"]);
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"]);
const DANGEROUS_SHELL_SYNTAX = new Set(["$", "`", "(", ")", "{", "}", "<", ">"]);
const SHELL_SEPARATORS = new Set([";", "|", "&"]);
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

function scanShell(command) {
	const segments = [];
	let current = "";
	let quote = null;
	let escaped = false;
	let unsafe = false;
	const chars = [...command];
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index];
		if (char === "\n" || char === "\r") unsafe = true;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote === "'") {
			current += char;
			if (char === "'") quote = null;
			continue;
		}
		if (quote === "\"") {
			if (char === "\"") quote = null;
			else if (char === "$" || char === "`") unsafe = true;
			current += char;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			current += char;
			continue;
		}
		if (DANGEROUS_SHELL_SYNTAX.has(char)) unsafe = true;
		if (SHELL_SEPARATORS.has(char)) {
			segments.push(current.trim());
			current = "";
			if (char === "&" && chars[index + 1] === "&") index++;
			continue;
		}
		current += char;
	}
	if (escaped || quote) unsafe = true;
	segments.push(current.trim());
	return { segments, unsafe };
}

function tokenizeShell(segment) {
	const tokens = [];
	let current = "";
	let quote = null;
	let escaped = false;
	let started = false;
	for (const char of segment) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			started = true;
			continue;
		}
		if (quote === "\"") {
			if (char === "\"") quote = null;
			else current += char;
			started = true;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started || current) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (escaped || quote) return null;
	if (started || current) tokens.push(current);
	return tokens;
}

function allowsReadCommand(tokens) {
	const [name, ...args] = tokens;
	if (!name || name.includes("/")) return false;
	if (!READ_ONLY_COMMANDS.has(name)) return false;
	if (name === "file") return !args.some((arg) => arg === "-C" || arg === "--compile");
	if (name === "tree") return !args.some((arg) => arg === "--output" || arg.startsWith("--output=") || /^-[^-]*o/.test(arg));
	if (name === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob="));
	if (name === "find") return !args.some((arg) => FIND_WRITE_FLAGS.has(arg) || arg.startsWith("-fprint"));
	if (name === "sort") return !args.some((arg) => arg === "--output" || arg.startsWith("--output=") || /^-[^-]*o/.test(arg));
	if (name === "uniq") return args.filter((arg) => !arg.startsWith("-")).length <= 1;
	if (name === "git") {
		if (!GIT_READ_SUBCOMMANDS.has(args[0])) return false;
		return !args.slice(1).some((arg) => arg === "-c" || (arg.startsWith("-c") && !arg.startsWith("--")) || arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff");
	}
	return true;
}

function classifyShell(command) {
	if (!command) return { permission: "ask", reason: "Empty shell command in Pi project." };
	if (MUTATING_COMMAND_RE.test(command)) return { permission: "deny", reason: "Shell command appears to mutate files or repo state." };
	const scanned = scanShell(command);
	if (scanned.unsafe) return { permission: "ask", reason: "Shell command uses dynamic or nested syntax that cannot be checked as read-only." };
	if (scanned.segments.some((segment) => segment.length === 0)) return { permission: "ask", reason: "Shell command has an empty or trailing segment." };
	for (const segment of scanned.segments) {
		const tokens = tokenizeShell(segment);
		if (!tokens || tokens.length === 0) return { permission: "ask", reason: "Shell command has an unparseable segment." };
		if (!allowsReadCommand(tokens)) return { permission: "ask", reason: `Shell segment "${tokens[0]}" is not an allowlisted read-only command.` };
	}
	return { permission: "allow" };
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
	const normalized = tool.toLowerCase();
	if (PRE_TOOL_READ_TOOLS.has(normalized) || PRE_TOOL_PASSTHROUGH_TOOLS.has(normalized)) return { permission: "allow" };
	return { permission: "deny", reason: `${tool} tool is not allowlisted as read-only.` };
}

function handle(input) {
	const projectRoot = findPiProjectRoot(hookCwd(input));
	if (!projectRoot) return allow();
	const event = eventName(input);
	if (event === "beforeShellExecution" || event === "preToolUse") {
		try {
			const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
			const conversationId = input.conversation_id;
			if (bridgeClient.isSafeId(conversationId)
				&& bridgeClient.holdsBuildLease(projectRoot, { harness: "cursor", id: conversationId })) return allow();
		} catch {
			// Lease lookup errors retain today's read-only classifier.
		}
	}
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
