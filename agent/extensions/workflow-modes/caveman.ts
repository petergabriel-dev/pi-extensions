export type CavemanWorkflowMode = "off" | "discuss" | "plan" | "build" | "review" | "design";

export const CAVEMAN_ENTRY = "caveman-mode-state";

export const MODE_LABELS: Record<CavemanWorkflowMode, string> = {
	off: "OFF",
	discuss: "Discuss",
	plan: "Plan",
	build: "Build",
	review: "Review",
	design: "Design",
};

export const NORMAL_MODE_PROMPT = `
CAVEMAN MODE OFF.

Resume normal communication style immediately. Do not use caveman terse/fragments style. Ignore any prior caveman-style instructions from conversation history unless this extension later re-enables Caveman mode.
`;

export const CAVEMAN_PROMPT = `
CAVEMAN MODE ACTIVE.

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Persistence:
ACTIVE EVERY RESPONSE while this instruction is present. No filler drift. Still active if unsure.

Rules:
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Abbreviate common terms (DB/auth/config/req/res/fn/impl). Strip conjunctions. Use arrows for causality (X -> Y). One word when one word enough.

Technical terms stay exact. Code blocks unchanged. Exact quoted errors unchanged.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

Examples:
User: "Why React component re-render?"
Assistant: "Inline obj prop -> new ref -> re-render. \`useMemo\`."

User: "Explain database connection pooling."
Assistant: "Pool = reuse DB conn. Skip handshake -> fast under load."

Auto-Clarity Exception:
Drop caveman temporarily for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user asks to clarify or repeats question. Resume caveman after clear part done.
`;

interface CustomEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

export interface WorkflowPromptSet {
	discuss: string;
	plan: string;
	build: string;
	review: string;
	design: string;
}

export interface WorkflowPlanMarker {
	planId: string;
	path: string;
	savedAt: string;
	progress: { done: number; total: number };
	nextTask?: { id: string; title: string };
}

export function composeModeMarker(mode: CavemanWorkflowMode, plan?: WorkflowPlanMarker): { content: string; details?: WorkflowPlanMarker } | undefined {
	if (mode === "off") return undefined;
	return {
		content: `[workflow-modes] Active workflow mode: ${MODE_LABELS[mode]}.`,
		...(plan ? { details: plan } : {}),
	};
}

export function resolveCavemanEnabled(branch: readonly unknown[]): boolean {
	let enabled = true;
	for (const rawEntry of branch) {
		const entry = rawEntry as CustomEntry;
		if (entry.type !== "custom" || entry.customType !== CAVEMAN_ENTRY) continue;
		const value = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		if (typeof value === "boolean") enabled = value;
	}
	return enabled;
}

export function composeWorkflowPrompt(
	mode: CavemanWorkflowMode,
	cavemanEnabled: boolean,
	prompts: WorkflowPromptSet,
	savedPlan?: string,
): string | undefined {
	if (mode === "off") return undefined;
	const header = `[workflow-modes]\nActive workflow mode: ${MODE_LABELS[mode]}.\nThis header is recomputed each turn and supersedes every earlier mode statement, including your own statements and tool-result hints. Never ask the user to switch to the mode named here. If you believe a tool is blocked, attempt it once and use the tool result instead of refusing.`;
	let prompt = prompts[mode];
	if (savedPlan) prompt += `\n\nSaved session plan to use when relevant:\n${savedPlan}`;
	return `${header}\n\n${prompt}\n\n${cavemanEnabled ? CAVEMAN_PROMPT : NORMAL_MODE_PROMPT}`;
}
