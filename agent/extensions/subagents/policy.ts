export const MAX_SUBAGENT_DEPTH = 2;

export const REPOSITORY_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const BROWSER_PROXY_BUILD_TOOLS = [
	"browser_goto",
	"browser_eval",
	"browser_console",
	"browser_network",
	"browser_fill",
	"browser_click",
	"browser_screenshot",
	"browser_close",
] as const;
export const BROWSER_PROXY_READ_ONLY_TOOLS = ["browser_console", "browser_screenshot", "browser_network"] as const;
export type BrowserProxyName = typeof BROWSER_PROXY_BUILD_TOOLS[number];

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export const READ_ONLY_EXPLORER_TOOLS = new Set<string>([
	...REPOSITORY_READ_ONLY_TOOLS,
	...BROWSER_PROXY_BUILD_TOOLS,
]);
const RESTRICTED_SUBAGENT_TOOLS = new Set<string>([
	...REPOSITORY_READ_ONLY_TOOLS,
	"ask_question",
	"subagent",
	...BROWSER_PROXY_READ_ONLY_TOOLS,
]);
const REPOSITORY_READ_ONLY_OWNERSHIP_TOOLS = new Set<string>([
	...REPOSITORY_READ_ONLY_TOOLS,
	"ask_question",
	"subagent",
	...BROWSER_PROXY_BUILD_TOOLS,
].map(normalize));

export function subagentToolsRequireBuild(tools: readonly string[]): boolean {
	return tools.some((tool) => !RESTRICTED_SUBAGENT_TOOLS.has(normalize(tool)));
}

export function subagentToolsMutateRepository(tools: readonly string[]): boolean {
	return tools.some((tool) => !REPOSITORY_READ_ONLY_OWNERSHIP_TOOLS.has(normalize(tool)));
}

export function validateSubagentToolset(tools: readonly string[], mode: string | undefined): string | undefined {
	if (mode === "build") return undefined;
	if (!subagentToolsRequireBuild(tools)) return undefined;
	const restricted = tools.filter((tool) => !RESTRICTED_SUBAGENT_TOOLS.has(normalize(tool)));
	return `Subagent toolset includes tool(s) not allowed outside Build mode: ${restricted.join(", ")}.`;
}

export function validateSubagentAgentAllowlist(allowed: readonly string[] | undefined, requested: string): string | undefined {
	if (!allowed || allowed.length === 0) return `Subagent may not spawn ${requested}: no child agent allowlist.`;
	if (allowed.includes(requested)) return undefined;
	return `Subagent may not spawn ${requested}: allowed child agents are ${allowed.join(", ")}.`;
}

export function validateSubagentDepth(depth: number, maxDepth = MAX_SUBAGENT_DEPTH): string | undefined {
	if (!Number.isInteger(depth) || depth < 0) return "Subagent depth must be a non-negative integer.";
	if (!Number.isInteger(maxDepth) || maxDepth < 0) return "Subagent max depth must be a non-negative integer.";
	return depth > maxDepth ? `Subagent spawn depth ${depth} exceeds maximum ${maxDepth}.` : undefined;
}
