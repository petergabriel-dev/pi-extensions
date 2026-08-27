export const MAX_SUBAGENT_DEPTH = 2;

export const MUTATING_SUBAGENT_TOOLS = new Set([
	"bash",
	"edit",
	"write",
	"apply_patch",
	"delete",
	"move",
	"browser_goto",
	"browser_eval",
	"browser_fill",
	"browser_click",
	"browser_close",
	"browser_kill",
]);

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function subagentToolsRequireBuild(tools: readonly string[]): boolean {
	return tools.some((tool) => MUTATING_SUBAGENT_TOOLS.has(normalize(tool)));
}

export function validateSubagentToolset(tools: readonly string[], mode: string | undefined): string | undefined {
	if (!subagentToolsRequireBuild(tools)) return undefined;
	if (mode === "build") return undefined;
	const mutating = tools.filter((tool) => MUTATING_SUBAGENT_TOOLS.has(normalize(tool)));
	return `Subagent toolset includes mutating tool(s) outside Build mode: ${mutating.join(", ")}.`;
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
