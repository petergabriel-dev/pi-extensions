import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "../storage/atomic.js";
import type { StagingFile, Trigger } from "../types.js";

export function stagingPath(projectMemoryDir: string, sessionId: string): string {
	return path.join(projectMemoryDir, "staging", `${sessionId}.json`);
}

export function listStagingFiles(projectMemoryDir: string): string[] {
	const stagingDir = path.join(projectMemoryDir, "staging");
	if (!fs.existsSync(stagingDir)) return [];
	return fs
		.readdirSync(stagingDir)
		.filter((fileName) => fileName.endsWith(".json"))
		.map((fileName) => path.join(stagingDir, fileName));
}

export function readStaging(filePath: string): StagingFile | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as StagingFile;
	} catch {
		return null;
	}
}

export function deriveLessonTriggers(text: string, context?: unknown, scope?: string): Trigger[] {
	const topic = firstNonEmpty(contextTopic(context), scope, keywordTopic(text), text, "lesson");
	return [{ type: "topic", value: topic }];
}

export function repairStagingFile(raw: unknown): StagingFile | null {
	const root = asRecord(raw);
	if (root.schemaVersion !== 1) return null;
	if (!nonEmptyString(root.session_id) || !nonEmptyString(root.produced_at) || !nonEmptyString(root.project_root)) return null;

	const candidates = asRecord(root.candidates);
	if (!Array.isArray(candidates.lessons)) return null;
	if (!Array.isArray(candidates.preferences)) return null;
	if (!Array.isArray(candidates.decisions)) return null;
	if (!Array.isArray(candidates.domain)) return null;

	const lessons = [];
	for (const rawLesson of candidates.lessons) {
		const lesson = asRecord(rawLesson);
		if (!nonEmptyString(lesson.summary) || !nonEmptyString(lesson.detail) || !nonEmptyString(lesson.scope_suggestion)) return null;
		const triggers = Array.isArray(lesson.triggers) && lesson.triggers.length > 0
			? lesson.triggers
			: deriveLessonTriggers(`${lesson.summary}\n${lesson.detail}`, root, lesson.scope_suggestion);
		lessons.push({ ...lesson, triggers });
	}

	return {
		...(root as Record<string, unknown>),
		schemaVersion: 1,
		session_id: root.session_id,
		produced_at: root.produced_at,
		project_root: root.project_root,
		candidates: {
			...candidates,
			lessons,
			preferences: candidates.preferences,
			decisions: candidates.decisions,
			domain: candidates.domain,
		},
	} as StagingFile;
}

function contextTopic(context: unknown): string | null {
	if (typeof context === "string") return cleanTopic(context);
	const record = asRecord(context);
	for (const key of ["topic", "project", "projectName", "name", "title", "repository", "repo", "scope"]) {
		const value = cleanTopic(record[key]);
		if (value) return value;
	}
	for (const key of ["project_root", "projectRoot", "root", "cwd"]) {
		const value = typeof record[key] === "string" ? cleanTopic(path.basename(record[key])) : null;
		if (value) return value;
	}
	return null;
}

function keywordTopic(text: string): string | null {
	const words = text
		.toLowerCase()
		.replace(/[`*_#>\[\]()[\]{}:;,.!?/\\|<>=+~$%^&\d-]+/g, " ")
		.split(/\s+/)
		.map((word) => word.trim())
		.filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
	return cleanTopic(words.slice(0, 4).join(" "));
}

function firstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const cleaned = cleanTopic(value);
		if (cleaned) return cleaned;
	}
	return "lesson";
}

function cleanTopic(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : null;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"when",
	"then",
	"into",
	"should",
	"must",
	"have",
	"has",
	"are",
	"was",
	"were",
	"use",
	"using",
]);

export function writeStaging(filePath: string, data: StagingFile): void {
	writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

export function deleteStaging(filePath: string): void {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export interface DeadLetteredCandidate {
	session_id: string;
	produced_at: string;
	attempts: number;
	last_gate_reason: string;
	category: "lessons" | "preferences" | "decisions" | "domain";
	candidate: any;
}

export function writeDeadLetter(projectMemoryDir: string, data: DeadLetteredCandidate): void {
	const dir = path.join(projectMemoryDir, "deadletter");
	const rand = Math.random().toString(36).substring(2, 8);
	const fileName = `${data.session_id}_${data.category}_${Date.now()}_${rand}.json`;
	const filePath = path.join(dir, fileName);
	writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

export function listDeadLetterFiles(projectMemoryDir: string): string[] {
	const dir = path.join(projectMemoryDir, "deadletter");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((fileName) => fileName.endsWith(".json"))
		.map((fileName) => path.join(dir, fileName));
}

export function readDeadLetter(filePath: string): DeadLetteredCandidate | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DeadLetteredCandidate;
	} catch {
		return null;
	}
}
