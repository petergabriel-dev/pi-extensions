import type { Decision, DomainFact, Lesson, Preference, Trigger } from "../types.js";

export type ShortlistCategory = "lesson" | "preference" | "decision" | "domain";

export type ShortlistCandidate =
	| { type: "lesson"; summary: string; detail: string; scope_suggestion?: string; triggers?: Trigger[] }
	| { type: "preference"; text: string; scope?: string }
	| { type: "decision"; summary: string; detail: string; scope?: string }
	| { type: "domain"; summary: string; detail: string; scope?: string };

export type ShortlistRecord = Lesson | Preference | Decision | DomainFact;

export interface ShortlistResult {
	record: ShortlistRecord;
	score: number;
}

export interface ShortlistOptions {
	maxResults?: number;
	minScore?: number;
}

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.15;

/**
 * Return 0..K same-category, same-scope records that plausibly collide with a
 * candidate. This is pure lexical recall: no model calls, no external deps.
 *
 * Scope is taken from lesson `scope_suggestion` or simple candidate `scope`.
 * If candidate scope is absent, scope filtering is skipped deterministically so
 * uncertain candidates are not accidentally hidden from later adjudication.
 */
export function shortlist(candidate: ShortlistCandidate, existing: ShortlistRecord[], options: ShortlistOptions = {}): ShortlistRecord[] {
	return shortlistWithScores(candidate, existing, options).map((result) => result.record);
}

/** Like `shortlist`, but preserves the deterministic lexical score for tests and diagnostics. */
export function shortlistWithScores(candidate: ShortlistCandidate, existing: ShortlistRecord[], options: ShortlistOptions = {}): ShortlistResult[] {
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const candidateTokens = tokenize(candidateText(candidate));
	if (candidateTokens.length === 0) return [];

	const category = candidate.type;
	const scope = candidateScope(candidate);
	const results: ShortlistResult[] = [];

	for (const record of existing) {
		if (recordCategory(record) !== category) continue;
		const recordScopeValue = recordScope(record);
		if (scope !== undefined && recordScopeValue !== undefined && scope !== recordScopeValue) continue;

		const score = overlapScore(candidateTokens, tokenize(recordText(record)));
		if (score >= minScore) results.push({ record, score });
	}

	return results
		.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
		.slice(0, maxResults);
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./:-]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);
}

export function stem(token: string): string {
	const suffixes = [
		"ification", "izational", "fulness", "ousness", "tional", "lessly", "liness", "izable", "ations", "ingly",
		"ition", "ation", "ening", "fully", "eless", "ility", "able", "ible", "ment", "ness", "tion", "sion",
		"ance", "ence", "ious", "ize", "ise", "ify", "ful", "less", "ing", "ed", "es", "er", "est", "ly", "s", "al", "ive", "ous",
	];
	for (const suffix of suffixes) {
		if (token.endsWith(suffix) && token.length - suffix.length >= 2) return token.slice(0, token.length - suffix.length);
	}
	return token;
}

/** Overlap coefficient over stemmed token sets: |A ∩ B| / min(|A|, |B|). */
export function overlapScore(tokensA: string[], tokensB: string[]): number {
	const stemsA = new Set(tokensA.map(stem));
	const stemsB = new Set(tokensB.map(stem));
	const denominator = Math.min(stemsA.size, stemsB.size);
	if (denominator === 0) return 0;

	let intersection = 0;
	for (const token of stemsA) {
		if (stemsB.has(token)) intersection += 1;
	}
	return intersection / denominator;
}

function candidateText(candidate: ShortlistCandidate): string {
	if (candidate.type === "preference") return candidate.text;
	return `${candidate.summary} ${candidate.detail}`;
}

function recordText(record: ShortlistRecord): string {
	if (isPreference(record)) return record.text;
	return `${record.summary} ${record.detail}`;
}

function candidateScope(candidate: ShortlistCandidate): string | undefined {
	return candidate.type === "lesson" ? candidate.scope_suggestion : candidate.scope;
}

function recordScope(record: ShortlistRecord): string | undefined {
	return isLesson(record) ? record.meta.project_scope : record.scope;
}

function recordCategory(record: ShortlistRecord): ShortlistCategory {
	if (isLesson(record)) return "lesson";
	if (isPreference(record)) return "preference";
	if (record.id.startsWith("dec_")) return "decision";
	if (record.id.startsWith("dom_")) return "domain";
	// Decision and domain records are structurally identical; tests and legacy
	// fixtures may use looser id prefixes, so keep deterministic fallback.
	return record.id.startsWith("dec") ? "decision" : "domain";
}

function isLesson(record: ShortlistRecord): record is Lesson {
	return "meta" in record;
}

function isPreference(record: ShortlistRecord): record is Preference {
	return "text" in record;
}
