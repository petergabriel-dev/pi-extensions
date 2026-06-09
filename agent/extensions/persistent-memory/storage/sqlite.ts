import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	parseDecisionsFile,
	parseDomainFile,
	parseLessonsFile,
	parsePreferencesFile,
} from "./markdown.js";
import type { MemoryPaths } from "./paths.js";
import type { Decision, DomainFact, Lesson, Preference } from "../types.js";

export type SqliteDatabase = ReturnType<typeof Database>;

export interface IndexedLesson {
	id: string;
	summary: string;
	detail: string;
	project_scope: string;
	status: string;
	session_level: number;
	reinforcement_count: number;
	last_seen_at: string | null;
	source_session: string;
	created_at: string;
	supersedes: string | null;
	triggers_json: string;
	source_file: string;
}

export interface RebuildCounts {
	lessons: number;
	preferences: number;
	decisions: number;
	domainFacts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
	id TEXT PRIMARY KEY,
	summary TEXT NOT NULL,
	detail TEXT NOT NULL,
	project_scope TEXT NOT NULL,
	status TEXT NOT NULL,
	session_level INTEGER NOT NULL,
	reinforcement_count INTEGER NOT NULL,
	last_seen_at TEXT,
	source_session TEXT NOT NULL,
	created_at TEXT NOT NULL,
	supersedes TEXT,
	triggers_json TEXT NOT NULL,
	source_file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(project_scope);
CREATE INDEX IF NOT EXISTS idx_lessons_session_level ON lessons(session_level);

CREATE TABLE IF NOT EXISTS preferences (
	id TEXT PRIMARY KEY,
	text TEXT NOT NULL,
	scope TEXT NOT NULL,
	source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
	id TEXT PRIMARY KEY,
	summary TEXT NOT NULL,
	detail TEXT NOT NULL,
	scope TEXT NOT NULL,
	source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_facts (
	id TEXT PRIMARY KEY,
	summary TEXT NOT NULL,
	detail TEXT NOT NULL,
	scope TEXT NOT NULL,
	source_file TEXT NOT NULL
);
`;

export function openIndex(dbPath: string): SqliteDatabase {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	try {
		db.exec(SCHEMA);
		ensureLessonColumns(db);
		return db;
	} catch (error) {
		try {
			db.close();
		} catch {
			// Ignore close errors while preserving original open/schema error.
		}
		throw error;
	}
}

function ensureLessonColumns(db: SqliteDatabase): void {
	const columns = new Set((db.prepare("PRAGMA table_info(lessons)").all() as { name: string }[]).map((column) => column.name));
	if (!columns.has("source_session")) db.exec("ALTER TABLE lessons ADD COLUMN source_session TEXT NOT NULL DEFAULT 'unknown'");
	if (!columns.has("created_at")) db.exec("ALTER TABLE lessons ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'");
	if (!columns.has("supersedes")) db.exec("ALTER TABLE lessons ADD COLUMN supersedes TEXT");
}

function markdownSources(paths: MemoryPaths, fileName: string): string[] {
	const sources = [path.join(paths.globalMemoryDir, fileName)];
	if (paths.projectMemoryDir) sources.push(path.join(paths.projectMemoryDir, fileName));
	return sources;
}

function tableCount(db: SqliteDatabase, table: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
	return row.count;
}

export function insertLessons(db: SqliteDatabase, filePath: string, lessons: Lesson[]): void {
	const insert = db.prepare(`
		INSERT OR REPLACE INTO lessons (
			id, summary, detail, project_scope, status, session_level,
			reinforcement_count, last_seen_at, source_session, created_at,
			supersedes, triggers_json, source_file
		) VALUES (
			@id, @summary, @detail, @project_scope, @status, @session_level,
			@reinforcement_count, @last_seen_at, @source_session, @created_at,
			@supersedes, @triggers_json, @source_file
		)
	`);

	for (const lesson of lessons) {
		insert.run({
			id: lesson.id,
			summary: lesson.summary,
			detail: lesson.detail,
			project_scope: lesson.meta.project_scope,
			status: lesson.meta.status,
			session_level: lesson.meta.session_level ? 1 : 0,
			reinforcement_count: lesson.meta.reinforcement_count,
			last_seen_at: lesson.meta.last_seen_at,
			source_session: lesson.meta.source_session,
			created_at: lesson.meta.created_at,
			supersedes: lesson.meta.supersedes,
			triggers_json: JSON.stringify(lesson.meta.triggers),
			source_file: filePath,
		});
	}
}

export function insertPreferences(db: SqliteDatabase, filePath: string, preferences: Preference[]): void {
	const insert = db.prepare(`
		INSERT OR REPLACE INTO preferences (id, text, scope, source_file)
		VALUES (@id, @text, @scope, @source_file)
	`);

	for (const preference of preferences) {
		insert.run({
			id: preference.id,
			text: preference.text,
			scope: preference.scope,
			source_file: filePath,
		});
	}
}

export function insertDecisions(db: SqliteDatabase, filePath: string, decisions: Decision[]): void {
	const insert = db.prepare(`
		INSERT OR REPLACE INTO decisions (id, summary, detail, scope, source_file)
		VALUES (@id, @summary, @detail, @scope, @source_file)
	`);

	for (const decision of decisions) {
		insert.run({
			id: decision.id,
			summary: decision.summary,
			detail: decision.detail,
			scope: decision.scope,
			source_file: filePath,
		});
	}
}

export function insertDomainFacts(db: SqliteDatabase, filePath: string, domainFacts: DomainFact[]): void {
	const insert = db.prepare(`
		INSERT OR REPLACE INTO domain_facts (id, summary, detail, scope, source_file)
		VALUES (@id, @summary, @detail, @scope, @source_file)
	`);

	for (const domainFact of domainFacts) {
		insert.run({
			id: domainFact.id,
			summary: domainFact.summary,
			detail: domainFact.detail,
			scope: domainFact.scope,
			source_file: filePath,
		});
	}
}

export function rebuildIndex(db: SqliteDatabase, paths: MemoryPaths): RebuildCounts {
	const rebuild = db.transaction(() => {
		db.exec(`
			DELETE FROM lessons;
			DELETE FROM preferences;
			DELETE FROM decisions;
			DELETE FROM domain_facts;
		`);

		for (const filePath of markdownSources(paths, "lessons.md")) {
			insertLessons(db, filePath, parseLessonsFile(filePath));
		}
		for (const filePath of markdownSources(paths, "preferences.md")) {
			insertPreferences(db, filePath, parsePreferencesFile(filePath));
		}
		for (const filePath of markdownSources(paths, "decisions.md")) {
			insertDecisions(db, filePath, parseDecisionsFile(filePath));
		}
		for (const filePath of markdownSources(paths, "domain.md")) {
			insertDomainFacts(db, filePath, parseDomainFile(filePath));
		}
	});

	rebuild();
	return getIndexCounts(db);
}

export function getIndexCounts(db: SqliteDatabase): RebuildCounts {
	return {
		lessons: tableCount(db, "lessons"),
		preferences: tableCount(db, "preferences"),
		decisions: tableCount(db, "decisions"),
		domainFacts: tableCount(db, "domain_facts"),
	};
}
