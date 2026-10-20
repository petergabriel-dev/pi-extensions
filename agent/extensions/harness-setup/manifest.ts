export type Harness = "claude" | "cursor" | "opencode";
export type EntryKind = "hook" | "statusline" | "mcp" | "command" | "plugin";

export interface HarnessEntry {
	kind: EntryKind;
	event?: string;
	script: string;
	dest: string;
	ownerExtension: string;
}

const bridgeOwner = "claude-bridge";

export const HARNESS_MANIFEST: Record<Harness, HarnessEntry[]> = {
	claude: [
		{
			kind: "hook",
			event: "PreToolUse",
			script: "agent/claude-bridge-client/pi-readonly-hook.js",
			dest: "settings.json#/hooks/PreToolUse",
			ownerExtension: bridgeOwner,
		},
		{
			kind: "hook",
			event: "UserPromptSubmit",
			script: "agent/claude-bridge-client/pi-peer-hook.js",
			dest: "settings.json#/hooks/UserPromptSubmit",
			ownerExtension: bridgeOwner,
		},
		{
			kind: "hook",
			event: "SessionEnd",
			script: "agent/claude-bridge-client/pi-peer-hook.js",
			dest: "settings.json#/hooks/SessionEnd",
			ownerExtension: bridgeOwner,
		},
		{
			kind: "statusline",
			script: "agent/claude-bridge-client/pi-statusline.js",
			dest: "settings.json#/statusLine",
			ownerExtension: bridgeOwner,
		},
		{
			kind: "mcp",
			script: "agent/claude-bridge-client/pi-bridge-mcp.js",
			dest: "~/.claude.json#mcpServers.pi-claude-bridge",
			ownerExtension: bridgeOwner,
		},
		...(["discuss", "plan", "build"] as const).map((command): HarnessEntry => ({
			kind: "command",
			script: `agent/harness-commands/claude/pi-${command}.md`,
			dest: `commands/pi-${command}.md`,
			ownerExtension: bridgeOwner,
		})),
	],
	cursor: [
		...(["beforeShellExecution", "beforeMCPExecution", "preToolUse"] as const).map(
			(event): HarnessEntry => ({
				kind: "hook",
				event,
				script: "agent/cursor-bridge-client/cursor-readonly-hook.js",
				dest: `hooks.json#/hooks/${event}`,
				ownerExtension: bridgeOwner,
			}),
		),
		{
			kind: "mcp",
			script: "agent/claude-bridge-client/pi-bridge-mcp.js",
			dest: "mcp.json#mcpServers.pi-claude-bridge",
			ownerExtension: bridgeOwner,
		},
		...(["discuss", "plan", "build"] as const).map((command): HarnessEntry => ({
			kind: "command",
			script: `agent/harness-commands/cursor/pi-${command}.md`,
			dest: `commands/pi-${command}.md`,
			ownerExtension: bridgeOwner,
		})),
	],
	opencode: [
		{
			kind: "plugin",
			script: "agent/opencode-bridge-client/pi-opencode-plugin.js",
			dest: "plugins/pi-opencode-build-lease.js",
			ownerExtension: bridgeOwner,
		},
		...(["discuss", "plan", "build"] as const).map((command): HarnessEntry => ({
			kind: "command",
			script: `agent/harness-commands/opencode/pi-${command}.md`,
			dest: `commands/pi-${command}.md`,
			ownerExtension: bridgeOwner,
		})),
		{
			kind: "mcp",
			script: "agent/claude-bridge-client/pi-bridge-mcp.js",
			dest: "opencode.json#mcp.pi-claude-bridge",
			ownerExtension: bridgeOwner,
		},
	],
};

export const harnessManifest = HARNESS_MANIFEST;

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const STATUSLINE_REFRESH_INTERVAL = 5;
export const CURSOR_HOOK_FAIL_CLOSED = true;
export const PI_BRIDGE_MCP_KEY = "pi-claude-bridge";
