#!/usr/bin/env node
/*
 * Cursor hook for Pi projects. Zero Pi imports.
 * Enforces read-only client behavior for any cwd under a .pi marker.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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
// Per-command SAFE flags (allowlists, not blocklists): bad-flag lists kept missing
// writers and executors (rg --hostname-bin, sort --compress-program, GNU long-option
// abbreviations such as sort --o). Anything not listed makes the segment ask.
// short: flag letters without a value; shortValued: letters taking a value
// (attached or next token); long: exact long flags; longOptional: exact long flags
// that may take "=value"; longValued: long flags requiring a value.
const SAFE_FLAGS = {
	rg: {
		short: "aciFHIlLnNoPqsSuUvwx0",
		shortValued: "ABCdeEfgjmMrtT",
		long: new Set(["--ignore-case", "--smart-case", "--case-sensitive", "--line-number", "--no-line-number", "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--invert-match", "--word-regexp", "--line-regexp", "--fixed-strings", "--with-filename", "--no-filename", "--only-matching", "--hidden", "--no-ignore", "--no-ignore-vcs", "--follow", "--files", "--json", "--vimgrep", "--no-heading", "--heading", "--column", "--multiline", "--pcre2", "--quiet", "--null", "--text", "--unrestricted", "--stats", "--trim", "--byte-offset", "--passthru", "--type-list", "--no-messages", "--one-file-system"]),
		longValued: new Set(["--regexp", "--glob", "--iglob", "--type", "--type-not", "--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--threads", "--max-columns", "--sort", "--sortr", "--color", "--colors", "--replace", "--encoding", "--max-filesize", "--file", "--context-separator"]),
	},
	sort: {
		short: "bdfghiMnRrsuVcCmz",
		shortValued: "ktS",
		long: new Set(["--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--human-numeric-sort", "--ignore-nonprinting", "--month-sort", "--numeric-sort", "--random-sort", "--reverse", "--stable", "--unique", "--version-sort", "--merge", "--zero-terminated"]),
		longOptional: new Set(["--check"]),
		longValued: new Set(["--key", "--field-separator", "--buffer-size", "--parallel"]),
	},
	uniq: {
		short: "cdDuiz",
		shortValued: "fsw",
		long: new Set(["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"]),
		longOptional: new Set(["--all-repeated", "--group"]),
		longValued: new Set(["--skip-fields", "--skip-chars", "--check-chars"]),
	},
	tree: {
		short: "adfilshugpDFqNQrtvUCnAJSXx",
		shortValued: "LPIT",
		long: new Set(["--noreport", "--dirsfirst", "--filesfirst", "--gitignore", "--prune", "--matchdirs", "--ignore-case", "--du", "--si", "--inodes", "--device", "--nolinks"]),
		longValued: new Set(["--charset", "--filelimit", "--timefmt", "--sort"]),
	},
	git: {
		short: "bepqstuvwlz",
		shortValued: "nLSGU",
		numeric: true,
		long: new Set(["--oneline", "--shortstat", "--numstat", "--name-only", "--name-status", "--patch", "--no-patch", "--graph", "--decorate", "--no-decorate", "--all", "--cached", "--staged", "--short", "--porcelain", "--branch", "--abbrev-commit", "--follow", "--reverse", "--merges", "--no-merges", "--first-parent", "--relative-date", "--no-color", "--ignore-all-space", "--ignore-space-change", "--summary", "--no-ext-diff", "--no-textconv", "--no-renames", "--minimal", "--full-history", "--root", "--compact-summary", "--raw", "--quiet", "--long"]),
		longOptional: new Set(["--stat", "--abbrev", "--word-diff", "--find-renames", "--color", "--untracked-files", "--pretty", "--decorate"]),
		longValued: new Set(["--format", "--max-count", "--since", "--until", "--after", "--before", "--author", "--committer", "--grep", "--date", "--unified", "--diff-filter", "--skip", "--encoding"]),
	},
};
// find takes single-dash primaries; only these, never -exec/-delete/-fprint/-fls/...
const FIND_SAFE_PRIMARIES = new Set(["-print", "-print0", "-prune", "-empty", "-depth", "-follow", "-xdev", "-mount", "-true", "-false", "-not", "-a", "-and", "-o", "-or", "-H", "-L", "-P", "-daystart", "-nowarn", "-ls", "-readable", "-writable", "-executable", "-noleaf"]);
const FIND_SAFE_VALUED_PRIMARIES = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-regextype", "-type", "-xtype", "-maxdepth", "-mindepth", "-newer", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum", "-samefile", "-printf"]);
const DANGEROUS_SHELL_SYNTAX = new Set(["$", "`", "(", ")", "{", "}", "<", ">"]);
const SHELL_SEPARATORS = new Set([";", "|", "&"]);
const MUTATING_COMMAND_RE = /(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|git\s+(commit|add|reset|checkout|switch|merge|rebase|cherry-pick|apply|am|clean|stash|push)|npm\s+(install|i|ci|update|audit\s+fix)|pnpm\s+(install|i|update)|yarn\s+(add|install|upgrade)|pip\s+install|python\s+-m\s+pip\s+install)(\s|$)|(^|[^<])>>?|<<|\|\s*(tee|xargs\s+rm)\b/;
const MUTATING_MCP_RE = /(^|_)(write|edit|delete|remove|create|update|insert|patch|mutate|apply|commit|save)(_|$)/i;

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

// Returns the operands when every flag is on spec's safe lists, else null. A
// separate value token that itself looks like a flag is refused rather than
// trusted, so a parser mismatch can only make a segment ask.
function safeOperands(args, spec) {
	const operands = [];
	const takeValue = (index) => index + 1 < args.length && !(args[index + 1].startsWith("-") && args[index + 1].length > 1);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") return operands.concat(args.slice(index + 1));
		if (arg === "-" || !arg.startsWith("-")) {
			operands.push(arg);
			continue;
		}
		if (spec.numeric && /^-\d+$/.test(arg)) continue;
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const name = equals === -1 ? arg : arg.slice(0, equals);
			if (spec.longValued?.has(name)) {
				if (equals !== -1) continue;
				if (!takeValue(index)) return null;
				index++;
				continue;
			}
			if (spec.longOptional?.has(name)) continue;
			if (equals === -1 && spec.long?.has(name)) continue;
			return null;
		}
		for (let letter = 1; letter < arg.length; letter++) {
			if (spec.shortValued?.includes(arg[letter])) {
				if (letter === arg.length - 1) {
					if (!takeValue(index)) return null;
					index++;
				}
				break;
			}
			if (!spec.short?.includes(arg[letter])) return null;
		}
	}
	return operands;
}

function allowsFindArgs(args) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "(" || arg === ")" || arg === "!" || arg === "," || !arg.startsWith("-")) continue;
		if (FIND_SAFE_PRIMARIES.has(arg)) continue;
		if (FIND_SAFE_VALUED_PRIMARIES.has(arg) && index + 1 < args.length) {
			index++;
			continue;
		}
		return false;
	}
	return true;
}

function allowsReadCommand(tokens) {
	const [name, ...args] = tokens;
	if (!name || name.includes("/")) return false;
	if (!READ_ONLY_COMMANDS.has(name)) return false;
	if (name === "file") return !args.some((arg) => arg === "-C" || arg === "--compile");
	if (name === "find") return allowsFindArgs(args);
	if (name === "git") return GIT_READ_SUBCOMMANDS.has(args[0]) && safeOperands(args.slice(1), SAFE_FLAGS.git) !== null;
	// uniq writes its second operand, so at most one operand (stdin "-" counts).
	if (name === "uniq") return (safeOperands(args, SAFE_FLAGS.uniq)?.length ?? Infinity) <= 1;
	if (SAFE_FLAGS[name]) return safeOperands(args, SAFE_FLAGS[name]) !== null;
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

function parseMcpToolInput(input) {
	const raw = input.tool_input ?? input.toolInput ?? input.arguments ?? input.args;
	if (raw === undefined || raw === null) return null;
	let value = raw;
	if (typeof raw === "string") {
		try { value = JSON.parse(raw); } catch { return null; }
	}
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function classifyBridgeMcp(input) {
	const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
	const conversationId = input.conversation_id;
	if (!bridgeClient.isSafeId(conversationId)) {
		return { permission: "deny", reason: "Pi bridge MCP call requires a valid Cursor conversation_id." };
	}
	const args = parseMcpToolInput(input);
	if (!args) {
		return { permission: "deny", reason: "Pi bridge MCP arguments are missing or unparseable." };
	}
	if (args.sessionId !== conversationId) {
		return { permission: "deny", reason: "Pi bridge MCP sessionId does not match Cursor conversation_id." };
	}
	if (args.harness !== "cursor") {
		return { permission: "deny", reason: "Pi bridge MCP harness must be cursor." };
	}
	return { permission: "allow" };
}

function classifyMcp(input) {
	const server = serverName(input);
	const tool = mcpToolName(input);
	if (PI_BRIDGE_SERVERS.has(server)) return classifyBridgeMcp(input);
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

const TOOL_TARGET_FIELDS = ["path", "file_path", "target_file"];

function toolTargetPath(input) {
	for (const source of [input.tool_input || input.toolInput, input]) {
		if (!source || typeof source !== "object" || Array.isArray(source)) continue;
		for (const field of TOOL_TARGET_FIELDS) {
			const value = source[field];
			if (typeof value === "string" && value.trim() !== "") return value;
		}
	}
	return null;
}

function preToolUseTargetDecision(input, cwdRoot) {
	const tool = toolType(input).toLowerCase();
	if (!tool || PRE_TOOL_READ_TOOLS.has(tool) || PRE_TOOL_PASSTHROUGH_TOOLS.has(tool)) return null;
	const target = toolTargetPath(input);
	if (!target) return null;
	const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
	const targetRoot = bridgeClient.targetPiProjectRoot(target, hookCwd(input));
	if (!targetRoot) return null;
	if (cwdRoot && bridgeClient.realpathDeepest(cwdRoot) === targetRoot) return null;
	const conversationId = input.conversation_id;
	if (bridgeClient.isSafeId(conversationId)
		&& bridgeClient.holdsBuildLease(targetRoot, { harness: "cursor", id: conversationId })) return allow();
	return deny(`${toolType(input)} is blocked: target is in Pi project ${targetRoot}, and this session has no Build lease there. Request a Build lease with /pi-build in ${targetRoot}, then approve it in Pi with /build-lease approve.`);
}

function handle(input) {
	const projectRoot = findPiProjectRoot(hookCwd(input));
	const event = eventName(input);
	if (event === "preToolUse") {
		const target = preToolUseTargetDecision(input, projectRoot);
		if (target) return target;
	}
	if (!projectRoot) return allow();
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
		const suffix = PI_BRIDGE_SERVERS.has(serverName(input)) ? "" : " Use pi-claude-bridge for Pi state.";
		if (classified.permission === "deny") return deny(`${classified.reason}${suffix}`);
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
