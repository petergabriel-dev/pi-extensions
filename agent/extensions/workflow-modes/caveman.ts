export type CavemanWorkflowMode = "off" | "discuss" | "plan" | "build";

export const CAVEMAN_ENTRY = "caveman-mode-state";

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
	let prompt = prompts[mode];
	if (mode === "build" && savedPlan) prompt += `\n\nSaved session plan to use when relevant:\n${savedPlan}`;
	return `${prompt}\n\n${cavemanEnabled ? CAVEMAN_PROMPT : NORMAL_MODE_PROMPT}`;
}
