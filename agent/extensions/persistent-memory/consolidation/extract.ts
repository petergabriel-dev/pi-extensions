import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt, type SessionEntryLike } from "./prompts.js";
import { stagingPath, writeStaging } from "./staging.js";
import type { MemoryPaths } from "../storage/paths.js";
import type { LessonCandidate, StagingFile, Trigger } from "../types.js";

export interface ExtractionContextLike {
	sessionManager: {
		getBranch(): SessionEntryLike[];
	};
}

export interface ExtractionLogger {
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface ExtractionDeps {
	callCarefulModel: (system: string, user: string) => Promise<string>;
	now?: () => Date;
	logger?: ExtractionLogger;
}

export type ExtractionRunResult =
	| { status: "skipped"; reason: "no_project" | "no_high_value_content" | "no_candidates" }
	| { status: "written"; filePath: string; totalCandidates: number }
	| { status: "failed"; reason: "model_error" | "parse_error" | "invalid_schema" | "write_error" | "unexpected_error"; error?: unknown };

type ExtractionCandidates = StagingFile["candidates"];
type Evidence = {
	discussion_note_ids?: number[];
	lesson_candidate_marker_ids?: string[];
};

const HIGH_VALUE_NOTE_TYPES = new Set(["lesson", "preference", "decision", "requirement", "constraint"]);

type JsonParseUtils = {
	parseJsonWithRepair: <T = unknown>(json: string) => T;
	parseStreamingJson: <T = unknown>(json: string | undefined) => T;
};

const jsonParseUtils = await loadJsonParseUtils();

export async function runExtraction(
	ctx: ExtractionContextLike,
	memoryPaths: MemoryPaths,
	sessionId: string,
	deps: ExtractionDeps,
): Promise<ExtractionRunResult> {
	const logger = deps.logger ?? console;
	try {
		if (!memoryPaths.projectMemoryDir) {
			logger.info?.("[persistent-memory] extraction skipped: no project memory dir.");
			return { status: "skipped", reason: "no_project" };
		}

		const branch = ctx.sessionManager.getBranch();
		if (shouldSkipExtraction(branch)) {
			logger.info?.("[persistent-memory] extraction skipped: no high-value content.");
			return { status: "skipped", reason: "no_high_value_content" };
		}

		const projectName = memoryPaths.projectRoot ? path.basename(memoryPaths.projectRoot) : null;
		const userPrompt = buildExtractionUserPrompt(branch, projectName);

		let rawResponse: string;
		try {
			rawResponse = await deps.callCarefulModel(EXTRACTION_SYSTEM_PROMPT, userPrompt);
		} catch (error) {
			logger.error?.("[persistent-memory] extraction model call failed:", error);
			return { status: "failed", reason: "model_error", error };
		}

		let parsed: unknown;
		try {
			parsed = parseModelJson(rawResponse);
		} catch (error) {
			logger.error?.("[persistent-memory] extraction returned malformed JSON; not writing staging.", error);
			return { status: "failed", reason: "parse_error", error };
		}

		const candidates = normalizeExtractionResult(parsed);
		if (!candidates) {
			logger.error?.("[persistent-memory] extraction produced invalid schema; not writing staging.");
			return { status: "failed", reason: "invalid_schema" };
		}

		const totalCandidates = countCandidates(candidates);
		if (totalCandidates === 0) {
			logger.info?.("[persistent-memory] extraction produced no candidates.");
			return { status: "skipped", reason: "no_candidates" };
		}

		const staging: StagingFile = {
			schemaVersion: 1,
			session_id: sessionId,
			produced_at: (deps.now?.() ?? new Date()).toISOString(),
			project_root: memoryPaths.projectRoot ?? "",
			candidates,
		};

		const filePath = stagingPath(memoryPaths.projectMemoryDir, sessionId);
		try {
			writeStaging(filePath, staging);
		} catch (error) {
			logger.error?.("[persistent-memory] extraction failed to write staging:", error);
			return { status: "failed", reason: "write_error", error };
		}

		return { status: "written", filePath, totalCandidates };
	} catch (error) {
		logger.error?.("[persistent-memory] extraction failed:", error);
		return { status: "failed", reason: "unexpected_error", error };
	}
}

export function shouldSkipExtraction(branch: SessionEntryLike[]): boolean {
	for (const entry of branch) {
		if (isLessonCandidateMarkerEntry(entry)) return false;
		for (const note of discussionNotesForEntry(entry)) {
			if (HIGH_VALUE_NOTE_TYPES.has(note.type)) return false;
		}
	}
	return true;
}

export function parseModelJson(raw: string): unknown {
	const jsonText = stripJsonFence(raw);
	try {
		return JSON.parse(jsonText);
	} catch (jsonError) {
		try {
			return jsonParseUtils.parseJsonWithRepair(jsonText);
		} catch {
			try {
				return jsonParseUtils.parseStreamingJson(jsonText);
			} catch {
				throw jsonError;
			}
		}
	}
}

function stripJsonFence(raw: string): string {
	const trimmed = raw.trim();
	const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
	return (fence ? fence[1] : trimmed).trim();
}

export function validateExtractionResult(result: unknown): boolean {
	return normalizeExtractionResult(result) !== null;
}

export function normalizeExtractionResult(result: unknown): ExtractionCandidates | null {
	const root = asRecord(result);
	const candidates = asRecord(root.candidates);
	if (!Array.isArray(candidates.lessons)) return null;
	if (!Array.isArray(candidates.preferences)) return null;
	if (!Array.isArray(candidates.decisions)) return null;
	if (!Array.isArray(candidates.domain)) return null;

	const lessons = normalizeArray(candidates.lessons, normalizeLessonCandidate);
	const preferences = normalizeArray(candidates.preferences, normalizePreferenceCandidate);
	const decisions = normalizeArray(candidates.decisions, normalizeDecisionCandidate);
	const domain = normalizeArray(candidates.domain, normalizeDomainCandidate);
	if (!lessons || !preferences || !decisions || !domain) return null;
	return { lessons, preferences, decisions, domain };
}

function normalizeLessonCandidate(raw: unknown): LessonCandidate | null {
	const item = asRecord(raw);
	const summary = requireString(item.summary);
	const detail = requireString(item.detail);
	const scopeSuggestion = requireString(item.scope_suggestion);
	const triggers = normalizeTriggers(item.triggers);
	const sourceEvidence = normalizeEvidence(item.source_evidence);
	if (!summary || !detail || !scopeSuggestion || !triggers || !sourceEvidence) return null;
	const reconcile_attempts = typeof item.reconcile_attempts === "number" ? item.reconcile_attempts : 0;
	return {
		summary,
		detail,
		triggers,
		scope_suggestion: scopeSuggestion,
		source_evidence: sourceEvidence,
		reconcile_attempts,
	};
}

function normalizePreferenceCandidate(raw: unknown): { text: string; source_evidence: Evidence; reconcile_attempts: number } | null {
	const item = asRecord(raw);
	const text = requireString(item.text);
	const sourceEvidence = normalizeEvidence(item.source_evidence);
	if (!text || !sourceEvidence) return null;
	const reconcile_attempts = typeof item.reconcile_attempts === "number" ? item.reconcile_attempts : 0;
	return { text, source_evidence: sourceEvidence, reconcile_attempts };
}

function normalizeDecisionCandidate(raw: unknown): { summary: string; detail: string; source_evidence: Evidence; reconcile_attempts: number } | null {
	const item = asRecord(raw);
	const summary = requireString(item.summary);
	const detail = requireString(item.detail);
	const sourceEvidence = normalizeEvidence(item.source_evidence);
	if (!summary || !detail || !sourceEvidence) return null;
	const reconcile_attempts = typeof item.reconcile_attempts === "number" ? item.reconcile_attempts : 0;
	return { summary, detail, source_evidence: sourceEvidence, reconcile_attempts };
}

function normalizeDomainCandidate(raw: unknown): { summary: string; detail: string; source_evidence: Evidence; reconcile_attempts: number } | null {
	const item = asRecord(raw);
	const summary = requireString(item.summary);
	const detail = requireString(item.detail);
	const sourceEvidence = normalizeEvidence(item.source_evidence);
	if (!summary || !detail || !sourceEvidence) return null;
	const reconcile_attempts = typeof item.reconcile_attempts === "number" ? item.reconcile_attempts : 0;
	return { summary, detail, source_evidence: sourceEvidence, reconcile_attempts };
}

function normalizeArray<T>(raw: unknown[], normalize: (value: unknown) => T | null): T[] | null {
	const out: T[] = [];
	for (const item of raw) {
		const normalized = normalize(item);
		if (!normalized) return null;
		out.push(normalized);
	}
	return out;
}

function normalizeTriggers(raw: unknown): Trigger[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const triggers: Trigger[] = [];
	for (const item of raw) {
		const trigger = normalizeTrigger(item);
		if (!trigger) return null;
		triggers.push(trigger);
	}
	return triggers;
}

function normalizeTrigger(raw: unknown): Trigger | null {
	const trigger = asRecord(raw);
	if (trigger.type === "path" || trigger.type === "filename" || trigger.type === "topic") {
		const value = requireString(trigger.value);
		return value ? { type: trigger.type, value } : null;
	}
	if (trigger.type === "tool") {
		const value = requireString(trigger.value);
		if (!value) return null;
		if (trigger.pattern !== undefined && typeof trigger.pattern !== "string") return null;
		const pattern = typeof trigger.pattern === "string" ? trigger.pattern.trim() : "";
		return pattern ? { type: "tool", value, pattern } : { type: "tool", value };
	}
	if (trigger.type === "command") {
		const pattern = requireString(trigger.pattern);
		return pattern ? { type: "command", pattern } : null;
	}
	return null;
}

function normalizeEvidence(raw: unknown): Evidence | null {
	const evidence = asRecord(raw);
	const out: Evidence = {};
	let hasEvidence = false;

	if (evidence.discussion_note_ids !== undefined) {
		if (!Array.isArray(evidence.discussion_note_ids)) return null;
		const ids: number[] = [];
		for (const id of evidence.discussion_note_ids) {
			if (typeof id !== "number" || !Number.isFinite(id)) return null;
			ids.push(id);
		}
		out.discussion_note_ids = ids;
		if (ids.length > 0) hasEvidence = true;
	}

	if (evidence.lesson_candidate_marker_ids !== undefined) {
		if (!Array.isArray(evidence.lesson_candidate_marker_ids)) return null;
		const ids: string[] = [];
		for (const id of evidence.lesson_candidate_marker_ids) {
			if (typeof id !== "string" || id.trim().length === 0) return null;
			ids.push(id.trim());
		}
		out.lesson_candidate_marker_ids = ids;
		if (ids.length > 0) hasEvidence = true;
	}

	return hasEvidence ? out : null;
}

function discussionNotesForEntry(entry: SessionEntryLike): Array<{ type: string }> {
	const notes: Array<{ type: string }> = [];
	const type = typeof entry.type === "string" ? entry.type : "";
	if (type === "message") {
		const message = asRecord(entry.message);
		if (message.role === "toolResult" && message.toolName === "discussion_notes") {
			notes.push(...discussionNotesFromSnapshot(message.details));
		}
		if (message.role === "custom" && message.customType === "discussion-notes") {
			notes.push(...discussionNotesFromSnapshot(message.details));
		}
	}
	if (type === "custom" && entry.customType === "discussion-notes") {
		notes.push(...discussionNotesFromSnapshot(entry.data));
	}
	if (type === "custom_message" && entry.customType === "discussion-notes") {
		notes.push(...discussionNotesFromSnapshot(entry.details));
	}
	return notes;
}

function discussionNotesFromSnapshot(raw: unknown): Array<{ type: string }> {
	const snapshot = asRecord(raw);
	if (snapshot.schemaVersion !== 1) return [];
	const notes: Array<{ type: string }> = [];
	for (const key of ["added", "notes"] as const) {
		const rawNotes = snapshot[key];
		if (!Array.isArray(rawNotes)) continue;
		for (const rawNote of rawNotes) {
			const note = asRecord(rawNote);
			if (typeof note.type === "string") notes.push({ type: note.type });
		}
	}
	return notes;
}

function isLessonCandidateMarkerEntry(entry: SessionEntryLike): boolean {
	const customType = typeof entry.customType === "string" ? entry.customType : "";
	if (customType.includes("lesson_candidate")) return true;
	if (isLessonCandidateMarkerData(entry.data)) return true;
	if (isLessonCandidateMarkerData(entry.details)) return true;
	const message = asRecord(entry.message);
	const messageCustomType = typeof message.customType === "string" ? message.customType : "";
	return messageCustomType.includes("lesson_candidate") || isLessonCandidateMarkerData(message.details);
}

function isLessonCandidateMarkerData(raw: unknown): boolean {
	const data = asRecord(raw);
	return data.type === "lesson_candidate" || data.kind === "lesson_candidate" || data.markerType === "lesson_candidate";
}

function countCandidates(candidates: ExtractionCandidates): number {
	return candidates.lessons.length + candidates.preferences.length + candidates.decisions.length + candidates.domain.length;
}

function requireString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

async function loadJsonParseUtils(): Promise<JsonParseUtils> {
	const module = await importPiAiJsonParseUtils();
	return module ?? {
		parseJsonWithRepair: parseJsonWithLocalRepair,
		parseStreamingJson: parseStreamingJsonWithLocalRepair,
	};
}

async function importPiAiJsonParseUtils(): Promise<JsonParseUtils | null> {
	const specifiers = [
		"@earendil-works/pi-ai/dist/utils/json-parse.js",
		"@mariozechner/pi-ai/dist/utils/json-parse.js",
		pathToFileURL("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js").href,
		pathToFileURL("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js").href,
	];
	for (const specifier of specifiers) {
		try {
			const module = (await import(specifier)) as Partial<JsonParseUtils>;
			if (typeof module.parseJsonWithRepair === "function" && typeof module.parseStreamingJson === "function") {
				return module as JsonParseUtils;
			}
		} catch {
			// Try the next host/bundled location. Parsing still has a local safety net below.
		}
	}
	return null;
}

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function parseJsonWithLocalRepair<T = unknown>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repaired = repairJsonStringLiterals(json);
		if (repaired !== json) return JSON.parse(repaired) as T;
		throw error;
	}
}

function parseStreamingJsonWithLocalRepair<T = unknown>(json: string | undefined): T {
	if (!json || json.trim() === "") return {} as T;
	try {
		return parseJsonWithLocalRepair<T>(json);
	} catch {
		try {
			return JSON.parse(closePartialJson(repairJsonStringLiterals(json))) as T;
		} catch {
			return {} as T;
		}
	}
}

function repairJsonStringLiterals(json: string): string {
	let repaired = "";
	let inString = false;
	for (let index = 0; index < json.length; index++) {
		const char = json[index];
		if (!inString) {
			repaired += char;
			if (char === '"') inString = true;
			continue;
		}
		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}
		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}
			if (nextChar === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(index + 2, index + 6))) {
				repaired += `\\u${json.slice(index + 2, index + 6)}`;
				index += 5;
				continue;
			}
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}
			repaired += "\\\\";
			continue;
		}
		const codePoint = char.codePointAt(0);
		repaired += codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f ? escapeControlCharacter(char) : char;
	}
	return repaired;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

function closePartialJson(json: string): string {
	let closed = "";
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	for (const char of json) {
		closed += char;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") stack.push("}");
		else if (char === "[") stack.push("]");
		else if ((char === "}" || char === "]") && stack[stack.length - 1] === char) stack.pop();
	}
	if (inString) closed += '"';
	for (let index = stack.length - 1; index >= 0; index--) closed += stack[index];
	return closed;
}
