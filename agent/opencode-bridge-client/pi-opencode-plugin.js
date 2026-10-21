import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
const readonlyHook = require("../claude-bridge-client/pi-readonly-hook.js");

const BRIDGE_TOOL_PREFIX = "pi-claude-bridge_";
const READ_TOOLS = new Set(["read", "grep", "glob", "list", "ls", "find", "todoread", "webfetch", "websearch", "skill", "question"]);
// Code Mode dispatches nested tools through this hook, so the dispatcher itself must stay callable.
const PASSTHROUGH_TOOLS = new Set(["execute"]);
const MUTATION_TOOLS = new Set([
	"edit",
	"write",
	"opencode_worktree_create",
	"opencode_worktree_remove",
]);

function leaseNextStep(projectRoot) {
	const holder = bridgeClient.listSessions(projectRoot).map((session) => session.buildLease).find(Boolean);
	if (holder) return `Live build lease held by ${holder.harness}:${holder.id}; ask that holder to run /build-lease release, then run /build here.`;
	return "No live build lease for this session. Run /build after Pi has an active saved plan.";
}

export default {
	id: "pi-opencode-build-lease",
	setup(ctx) {
		const directory = ctx?.location?.directory;
		if (typeof directory !== "string" || !directory) {
			throw new Error("OpenCode build-lease plugin cannot determine the project directory; reopen the project and retry.");
		}
		const projectRoot = bridgeClient.findPiProjectRoot(directory);
		if (!projectRoot) return;
		if (typeof ctx.tool?.hook !== "function") {
			throw new Error("OpenCode build-lease plugin requires tool.hook support; update OpenCode and retry.");
		}

		ctx.tool.hook("execute.before", async (event) => {
			if (!event || typeof event !== "object" || Array.isArray(event)) {
				throw new Error("OpenCode tool hook received invalid input; retry in a valid OpenCode session.");
			}
			const toolName = typeof event.tool === "string" ? event.tool : event.tool?.name;
			if (typeof toolName !== "string" || !toolName) {
				throw new Error("OpenCode tool hook is missing its tool name; retry after updating the plugin.");
			}

			const input = event.input;
			if (toolName.startsWith(BRIDGE_TOOL_PREFIX)) {
				if (!input || typeof input !== "object" || Array.isArray(input)) {
					throw new Error("OpenCode bridge call has invalid arguments; retry after updating the plugin.");
				}
				if (!bridgeClient.isSafeId(event.sessionID)) {
					throw new Error("OpenCode session identity is missing or invalid; restart this OpenCode session and retry.");
				}
				input.sessionId = event.sessionID;
				input.harness = "opencode";
				delete input.claudeSessionId;
			}

			// Code Mode dispatches nested tools through this hook; keep it available for bridge recall.
			if (bridgeClient.holdsBuildLease(projectRoot, { harness: "opencode", id: event.sessionID })) return;

			if (toolName.startsWith(BRIDGE_TOOL_PREFIX)) return;

			if (MUTATION_TOOLS.has(toolName)) {
				throw new Error(`OpenCode ${toolName} is blocked in Pi project ${projectRoot}. ${leaseNextStep(projectRoot)}`);
			}

			if (toolName === "shell") {
				if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.command !== "string") {
					throw new Error("OpenCode shell input is invalid; no command was run. Retry from the current session.");
				}
				const wrapped = readonlyHook.wrapBashForSandbox(input.command, projectRoot);
				if (!wrapped) {
					throw new Error(`OpenCode shell is blocked in Pi project ${projectRoot}: macOS Seatbelt sandbox is unavailable. ${leaseNextStep(projectRoot)} Use a supported macOS sandbox to run shell without a lease.`);
				}
				input.command = wrapped;
				return;
			}

			if (READ_TOOLS.has(toolName) || PASSTHROUGH_TOOLS.has(toolName)) return;

			throw new Error(`OpenCode ${toolName} is not an allowlisted read-only tool in Pi project ${projectRoot}. ${leaseNextStep(projectRoot)}`);
		});
	},
};
