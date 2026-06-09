/**
 * Adjudication tool schema + tolerant parser for per-candidate reconciliation.
 *
 * The tool contract is intentionally minimal: a `verdict` enum plus an
 * optional `merged_text` (only meaningful for `merge`).  No structural
 * fields (ids, timestamps, refs, supersede pointers) are exposed to the
 * model — the host maps candidates to shortlist targets after parsing.
 *
 * T2 spec: Section 4, adjudication tool schema + tolerant parse.
 */

import { parseModelJson } from "./extract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const VERDICT_ACTIONS = ["distinct", "duplicate", "supersedes", "merge"] as const;
export type VerdictAction = (typeof VERDICT_ACTIONS)[number];

/** A single per-candidate adjudication verdict emitted by the model. */
export interface AdjudicationVerdict {
	/** The reconciliation action for the candidate. */
	verdict: VerdictAction;
	/**
	 * Merged text when the candidate should be merged into a target.
	 * Only meaningful (and required) for `merge` verdicts.
	 */
	merged_text?: string;
	/**
	 * Optional bounded reason string.  Kept intentionally short.
	 * Not required for any verdict.
	 */
	reason?: string;
}

export type AdjudicationResult =
	| { status: "valid"; verdicts: AdjudicationVerdict[]; parked?: ParkedItem[] }
	| { status: "parked"; raw: string; message: string; parked?: ParkedItem[] };

export interface ParkedItem {
	index: number;
	raw: unknown;
	reason: string;
}

// ---------------------------------------------------------------------------
// Tool schema builder
// ---------------------------------------------------------------------------

const ADJUDICATION_TOOL_NAME = "submit_plan";

/** Build a submit_plan-style tool definition for adjudication. */
export function buildAdjudicationTool(): {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
} {
	return {
		name: ADJUDICATION_TOOL_NAME,
		description:
			"Submit adjudication verdicts for each candidate. For each candidate emit one verdict object with a `verdict` field (one of distinct, duplicate, supersedes, merge). For merge verdicts include merged_text. Optional reason for all verdicts. Do not include ids, timestamps, refs, or structural fields.",
		parameters: adjudicationSubmitPlanSchema(),
	};
}

function adjudicationSubmitPlanSchema(): Record<string, unknown> {
	const reason = optional(stringSchema());
	const nonMerge = (verdict: Exclude<VerdictAction, "merge">) => objectSchema(
		{ verdict: literalSchema(verdict), reason },
		{ additionalProperties: false },
	);
	const merge = objectSchema(
		{ verdict: literalSchema("merge"), merged_text: stringSchema(), reason },
		{ additionalProperties: false },
	);
	return objectSchema(
		{ verdicts: arraySchema(unionSchema([nonMerge("distinct"), nonMerge("duplicate"), nonMerge("supersedes"), merge])) },
		{ additionalProperties: false },
	);
}

// ---------------------------------------------------------------------------
// JSON-schema builders (local, same style as careful-model.ts)
// ---------------------------------------------------------------------------

function objectSchema(
	properties: Record<string, unknown>,
	options: Record<string, unknown> = {},
): Record<string, unknown> {
	const required = Object.entries(properties)
		.filter(([, value]) => !value?.[OPTIONAL_SCHEMA])
		.map(([key]) => key);
	const normalized = Object.fromEntries(
		Object.entries(properties).map(([key, value]) => [
			key,
			value?.[OPTIONAL_SCHEMA] ?? value,
		]),
	);
	return {
		type: "object",
		properties: normalized,
		required,
		...options,
	};
}

const OPTIONAL_SCHEMA = Symbol("optional-schema");

function optional(
	schema: Record<string, unknown>,
): Record<symbol, Record<string, unknown>> {
	return { [OPTIONAL_SCHEMA]: schema };
}

function arraySchema(items: unknown): Record<string, unknown> {
	return { type: "array", items };
}

function stringSchema(): Record<string, unknown> {
	return { type: "string" };
}

function unionSchema(anyOf: unknown[]): Record<string, unknown> {
	return { anyOf };
}

function literalSchema(value: string): Record<string, unknown> {
	return { const: value };
}

// ---------------------------------------------------------------------------
// Tolerant parser
// ---------------------------------------------------------------------------

const VALID_VERDICT_KEYS = new Set(["verdict", "merged_text", "reason"]);

/**
 * Parse raw model output into adjudication verdicts.
 *
 * Never throws.  Malformed or completely invalid input is parked.
 * Partial batches salvage valid verdicts while parking individual
 * invalid entries so the host can still apply the recoverable subset.
 */
export function parseAdjudication(raw: string): AdjudicationResult {
	if (!raw || raw.trim().length === 0) {
		return { status: "parked", raw, message: "empty input" };
	}

	// Step 1 — parse JSON (tolerant: fences, repair, streaming fallback)
	let parsed: unknown;
	try {
		parsed = parseModelJson(raw);
	} catch {
		return { status: "parked", raw, message: "unparseable JSON" };
	}

	// Step 2 — extract verdicts array
	const root = asRecord(parsed);
	const rawVerdicts = root.verdicts;

	if (rawVerdicts === undefined) {
		return { status: "parked", raw, message: "missing verdicts key" };
	}

	if (!Array.isArray(rawVerdicts)) {
		return { status: "parked", raw, message: "verdicts is not an array" };
	}

	// Step 3 — validate each verdict item, salvage valid, park invalid
	const validVerdicts: AdjudicationVerdict[] = [];
	const parkedItems: ParkedItem[] = [];

	for (let i = 0; i < rawVerdicts.length; i++) {
		const item = rawVerdicts[i];
		const result = normalizeVerdict(item);
		if (result.valid) {
			validVerdicts.push(result.verdict);
		} else {
			parkedItems.push({ index: i, raw: item, reason: (result as { reason: string }).reason });
		}
	}

	if (validVerdicts.length === 0 && parkedItems.length > 0) {
		return {
			status: "parked",
			raw,
			message: `all ${parkedItems.length} verdict(s) invalid`,
			parked: parkedItems,
		};
	}

	return {
		status: "valid",
		verdicts: validVerdicts,
		...(parkedItems.length > 0 ? { parked: parkedItems } : {}),
	};
}

type NormalizeResult =
	| { valid: true; verdict: AdjudicationVerdict }
	| { valid: false; reason: string };

function normalizeVerdict(raw: unknown): NormalizeResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { valid: false, reason: "not an object" };
	}

	const item = raw as Record<string, unknown>;

	// Reject structural fields beyond allowed set
	const keys = Object.keys(item);
	const extraKeys = keys.filter((k) => !VALID_VERDICT_KEYS.has(k));
	if (extraKeys.length > 0) {
		return {
			valid: false,
			reason: `unexpected structural keys: ${extraKeys.join(", ")}`,
		};
	}

	// Validate verdict
	const verdict = item.verdict;
	if (typeof verdict !== "string" || !isVerdictAction(verdict)) {
		return {
			valid: false,
			reason: `invalid or missing verdict: ${JSON.stringify(verdict)}`,
		};
	}

	const v: VerdictAction = verdict;

	// Validate merged_text
	const mergedText = item.merged_text;
	if (v === "merge") {
		if (mergedText !== undefined && typeof mergedText !== "string") {
			return {
				valid: false,
				reason: "merge verdict has non-string merged_text",
			};
		}
		if (typeof mergedText !== "string" || mergedText.trim().length === 0) {
			return {
				valid: false,
				reason: "merge verdict requires non-empty merged_text string",
			};
		}
	} else {
		// For non-merge verdicts, merged_text should not be present
		if (mergedText !== undefined) {
			return {
				valid: false,
				reason: `merged_text provided for non-merge verdict "${v}"`,
			};
		}
	}

	// Validate reason (optional)
	const reason = item.reason;
	if (reason !== undefined && typeof reason !== "string") {
		return { valid: false, reason: "reason must be a string" };
	}

	const result: AdjudicationVerdict = { verdict: v };
	if (v === "merge") result.merged_text = (mergedText as string).trim();
	if (typeof reason === "string" && reason.trim().length > 0) {
		result.reason = reason.trim();
	}

	return { valid: true, verdict: result };
}

function isVerdictAction(value: string): value is VerdictAction {
	return (VERDICT_ACTIONS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}
