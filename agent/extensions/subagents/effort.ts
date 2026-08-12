import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type SubagentRole = "explorer" | "worker";
export type SubagentEffortLevel = ModelThinkingLevel;
export type SubagentParentThinkingLevel = SubagentEffortLevel | "max";

export interface SubagentEffortSettings {
	effort?: Partial<Record<SubagentRole, string>>;
}

const EFFORT_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function parseEffortLevel(raw: unknown): ModelThinkingLevel | "inherit" | undefined {
	if (raw === "inherit") return raw;
	return typeof raw === "string" && EFFORT_LEVELS.has(raw as ModelThinkingLevel) ? (raw as ModelThinkingLevel) : undefined;
}

export function resolveEffort(
	settings: SubagentEffortSettings | undefined,
	role: SubagentRole,
	parentLevel?: SubagentParentThinkingLevel,
): SubagentParentThinkingLevel | undefined {
	const parsed = parseEffortLevel(settings?.effort?.[role]);
	return parsed && parsed !== "inherit" ? parsed : parentLevel;
}
