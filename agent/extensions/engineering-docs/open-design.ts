import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isInside, resolveForWrite } from "./design.js";

export const OPEN_DESIGN_REFERENCE_DIR = "docs/design/reference/open-design";
export const OPEN_DESIGN_QUERY_TIMEOUT_MS = 5_000;
export const OPEN_DESIGN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const OPEN_DESIGN_MAX_LINKED_DIRS = 32;
export const OPEN_DESIGN_MAX_NAME_CHARS = 200;
export const OPEN_DESIGN_MAX_SLUG_CHARS = 48;
export const OPEN_DESIGN_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const OPEN_DESIGN_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECTS_SQL = "SELECT id, name, metadata_json FROM projects;";
const SNAPSHOT_SUFFIXES = [".html", ".md", ".sketch.json", ".artifact.json"];

export interface OpenDesignProject {
	id: string;
	name: string;
	slug: string;
	linkedDirs: string[];
}

export interface OpenDesignReadResult {
	dbPath: string;
	projects: OpenDesignProject[];
	rejected: number;
}

export interface SkippedFile {
	name: string;
	reason: string;
}

export interface SnapshotSelection {
	selected: string[];
	skipped: SkippedFile[];
}

export interface SnapshotResult {
	folder: string;
	copied: string[];
	skipped: SkippedFile[];
}

async function realpathOrNull(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

function parseLinkedDirs(metadataJson: unknown): string[] | null {
	if (metadataJson === null || metadataJson === undefined || metadataJson === "") return [];
	if (typeof metadataJson !== "string") return null;
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataJson);
	} catch {
		return null;
	}
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
	const value = (metadata as Record<string, unknown>).linkedDirs;
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value) || value.length > OPEN_DESIGN_MAX_LINKED_DIRS) return null;
	if (!value.every((dir) => typeof dir === "string" && dir.length > 0 && dir.length <= 1024 && isAbsolute(dir))) return null;
	return [...value] as string[];
}

export function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, OPEN_DESIGN_MAX_SLUG_CHARS)
		.replace(/-+$/, "");
	return slug || "project";
}

export function snapshotFolderName(project: OpenDesignProject): string {
	return `${project.slug}-${project.id.slice(0, 8)}`;
}

export function isSnapshotFile(name: string): boolean {
	const lower = name.toLowerCase();
	return SNAPSHOT_SUFFIXES.some((suffix) => lower.length > suffix.length && lower.endsWith(suffix));
}

export function parseProjectRows(raw: string): { projects: OpenDesignProject[]; rejected: number } {
	let rows: unknown;
	try {
		rows = raw.trim() ? JSON.parse(raw) : [];
	} catch {
		throw new Error("Open Design returned unreadable project data.");
	}
	if (!Array.isArray(rows)) throw new Error("Open Design returned an unexpected project list.");

	const projects: OpenDesignProject[] = [];
	let rejected = 0;
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) {
			rejected++;
			continue;
		}
		const record = row as Record<string, unknown>;
		const id = record.id;
		const name = record.name;
		const linkedDirs = parseLinkedDirs(record.metadata_json);
		if (typeof id !== "string" || !SAFE_ID_RE.test(id)
			|| typeof name !== "string" || name.trim().length === 0 || name.length > OPEN_DESIGN_MAX_NAME_CHARS
			|| linkedDirs === null) {
			rejected++;
			continue;
		}
		projects.push({ id, name: name.trim(), slug: slugifyProjectName(name), linkedDirs });
	}
	return { projects, rejected };
}

export async function findOpenDesignDb(home: string): Promise<string | null> {
	const namespacesRoot = join(home, "Library", "Application Support", "Open Design", "namespaces");
	let entries;
	try {
		entries = await readdir(namespacesRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	const candidates: { namespace: string; dbPath: string }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dbPath = join(namespacesRoot, entry.name, "data", "app.sqlite");
		try {
			const info = await lstat(dbPath);
			if (info.isFile() && info.size > 0) candidates.push({ namespace: entry.name, dbPath });
		} catch {
			// Namespace has no database yet.
		}
	}
	candidates.sort((left, right) => {
		if (left.namespace === right.namespace) return 0;
		if (left.namespace === "release-stable") return -1;
		if (right.namespace === "release-stable") return 1;
		return left.namespace.localeCompare(right.namespace);
	});
	return candidates[0]?.dbPath ?? null;
}

function runSqlite(dbPath: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"sqlite3",
			["-readonly", "-json", dbPath, PROJECTS_SQL],
			{ encoding: "utf8", timeout: OPEN_DESIGN_QUERY_TIMEOUT_MS, maxBuffer: OPEN_DESIGN_MAX_OUTPUT_BYTES },
			(error, stdout, stderr) => {
				if (!error) {
					resolvePromise(stdout);
					return;
				}
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error("sqlite3 CLI not found; install sqlite3 to read Open Design projects."));
					return;
				}
				const detail = String(stderr || error.message).trim();
				if (/no such table|no such column/i.test(detail)) {
					reject(new Error("Open Design database schema is unknown; expected projects.id, projects.name, and projects.metadata_json."));
					return;
				}
				reject(new Error(`Could not read Open Design projects: ${detail}`));
			},
		);
	});
}

export async function readOpenDesignProjects(home: string): Promise<OpenDesignReadResult> {
	const dbPath = await findOpenDesignDb(home);
	if (!dbPath) throw new Error("Open Design database not found. Open Open Design once, then retry.");
	const parsed = parseProjectRows(await runSqlite(dbPath));
	return { dbPath, projects: parsed.projects, rejected: parsed.rejected };
}

export async function projectsForRoot(projects: readonly OpenDesignProject[], root: string): Promise<OpenDesignProject[]> {
	const rootReal = await realpathOrNull(resolve(root));
	if (!rootReal) return [];
	const matched: OpenDesignProject[] = [];
	for (const project of projects) {
		for (const linkedDir of project.linkedDirs) {
			const dirReal = await realpathOrNull(linkedDir);
			if (dirReal && (dirReal === rootReal || isInside(rootReal, dirReal))) {
				matched.push(project);
				break;
			}
		}
	}
	return matched;
}

export async function selectSnapshotFiles(sourceDir: string): Promise<SnapshotSelection> {
	const entries = (await readdir(sourceDir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
	const selected: string[] = [];
	const skipped: SkippedFile[] = [];
	let totalBytes = 0;
	for (const entry of entries) {
		if (!isSnapshotFile(entry.name)) continue;
		const filePath = join(sourceDir, entry.name);
		let info;
		try {
			info = await lstat(filePath);
		} catch {
			skipped.push({ name: entry.name, reason: "unreadable" });
			continue;
		}
		if (info.isSymbolicLink()) {
			skipped.push({ name: entry.name, reason: "symlink" });
			continue;
		}
		if (!info.isFile()) {
			skipped.push({ name: entry.name, reason: "not a regular file" });
			continue;
		}
		if (info.size > OPEN_DESIGN_MAX_FILE_BYTES) {
			skipped.push({ name: entry.name, reason: "exceeds 5 MiB" });
			continue;
		}
		if (totalBytes + info.size > OPEN_DESIGN_MAX_TOTAL_BYTES) {
			skipped.push({ name: entry.name, reason: "exceeds 25 MiB total" });
			continue;
		}
		totalBytes += info.size;
		selected.push(entry.name);
	}
	return { selected, skipped };
}

export async function copyProjectSnapshot(projectRoot: string, project: OpenDesignProject, sourceDir: string): Promise<SnapshotResult> {
	const rootReal = await realpathOrNull(resolve(projectRoot));
	if (!rootReal) throw new Error("Project root is not readable.");
	const referenceRoot = await resolveForWrite(resolve(rootReal, OPEN_DESIGN_REFERENCE_DIR));
	if (!referenceRoot || !isInside(rootReal, referenceRoot)) {
		throw new Error(`Cannot resolve ${OPEN_DESIGN_REFERENCE_DIR} inside the project.`);
	}
	const folder = snapshotFolderName(project);
	const dest = resolve(referenceRoot, folder);
	if (!isInside(referenceRoot, dest) || dest === referenceRoot) throw new Error("Snapshot path escapes the reference directory.");

	const selection = await selectSnapshotFiles(sourceDir);
	const staging = join(referenceRoot, `.${folder}.staging-${randomUUID()}`);
	const backup = join(referenceRoot, `.${folder}.backup-${randomUUID()}`);
	await mkdir(referenceRoot, { recursive: true });
	await mkdir(staging, { recursive: true });
	try {
		for (const name of selection.selected) {
			await copyFile(join(sourceDir, name), join(staging, name));
		}
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}

	let hadExisting = false;
	try {
		await rename(dest, backup);
		hadExisting = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}
	try {
		await rename(staging, dest);
	} catch (error) {
		if (hadExisting) await rename(backup, dest).catch(() => { /* keep the staged folder for recovery */ });
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	if (hadExisting) await rm(backup, { recursive: true, force: true });
	return { folder, copied: selection.selected, skipped: selection.skipped };
}

export function snapshotSourceDir(dbPath: string, projectId: string): string {
	return join(dirname(dbPath), "projects", projectId);
}
