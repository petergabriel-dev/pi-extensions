export type Harness = "claude" | "cursor" | "opencode" | "codex";
export type EntryKind = "hook" | "statusline" | "mcp" | "command" | "plugin" | "skill";

export interface HarnessEntry {
	kind: EntryKind;
	event?: string;
	script: string;
	dest: string;
	ownerExtension: string;
}

const bridgeOwner = "claude-bridge";
const skillOwner = "package-skills";

export const PACKAGE_SKILL_NAMES = [
	"animate",
	"animate-expo",
	"animation-performance",
	"animation-vocabulary",
	"apple-design",
	"ask-sonner",
	"break-ui",
	"emil-design-eng",
	"find-animation-opportunities",
	"grill",
	"grill-with-docs",
	"impeccable",
	"improve-animations",
	"mobile-native",
	"pick-ui-library",
	"playwright-cli",
	"prototype",
	"remove-animations",
	"review-animations",
	"web-debug",
	"web-design-guidelines",
	"worker-orchestration",
	"write-swift",
] as const;

function skillEntries(): HarnessEntry[] {
	return PACKAGE_SKILL_NAMES.map((name): HarnessEntry => ({
		kind: "skill",
		script: `agent/skills/${name}`,
		dest: `skills/${name}`,
		ownerExtension: skillOwner,
	}));
}

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
		...skillEntries(),
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
		...skillEntries(),
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
		...skillEntries(),
	],
	codex: [
		{
			kind: "hook",
			event: "PreToolUse",
			script: "agent/codex-bridge-client/pi-codex-hook.js",
			dest: "hooks.json#/hooks/PreToolUse",
			ownerExtension: bridgeOwner,
		},
		{
			kind: "mcp",
			script: "agent/claude-bridge-client/pi-bridge-mcp.js",
			dest: "config.toml#mcp_servers.pi-claude-bridge",
			ownerExtension: bridgeOwner,
		},
		// Codex has no command files; the Pi workflows ship as explicit-only skill directories.
		...(["discuss", "plan", "build"] as const).map((command): HarnessEntry => ({
			kind: "skill",
			script: `agent/harness-commands/codex/pi-${command}`,
			dest: `skills/pi-${command}`,
			ownerExtension: bridgeOwner,
		})),
		...skillEntries(),
	],
};

export const harnessManifest = HARNESS_MANIFEST;

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const STATUSLINE_REFRESH_INTERVAL = 5;
export const CURSOR_HOOK_FAIL_CLOSED = true;
// Codex denies on exit 2 only when stderr carries a reason; a silent exit 2 lets the tool run.
export const CODEX_PRETOOL_GUARD = "|| { echo 'Pi Codex hook failed closed' >&2; exit 2; }";
export const PI_BRIDGE_MCP_KEY = "pi-claude-bridge";
