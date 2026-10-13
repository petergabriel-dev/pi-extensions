import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MEMORY_DIR = "memory";
const INDEX_FILE = "MEMORY.md";
const LEGACY_MEMORY_FILE = "memory.md";
const LEGACY_BACKUP_FILE = "memory.md.bak";
const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);
const memoryWriteQueues = new Map<string, Promise<void>>();

export type MemoryFactType = "user" | "feedback" | "project" | "reference";

export interface MemoryFactInput {
	name?: unknown;
	description?: unknown;
	type?: unknown;
	body?: unknown;
	slug?: unknown;
}

interface NormalizedFact {
	name: string;
	description: string;
	type: MemoryFactType;
	body: string;
	slug: string;
}

interface StoredFact extends NormalizedFact {
	fileName: string;
}

export function resolveMemoryDir(agentDir: string): string {
	const globalDir = path.basename(agentDir) === "agent" ? path.dirname(agentDir) : agentDir;
	return path.join(globalDir, MEMORY_DIR);
}

export async function readMemoryIndex(memoryDir: string): Promise<string | null> {
	try {
		const raw = await fs.readFile(indexPath(memoryDir), "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export async function readMemoryEntry(memoryDir: string, slug: string): Promise<string | null> {
	const safeSlug = validateSlug(slug);
	try {
		const raw = await fs.readFile(path.join(memoryDir, `${safeSlug}.md`), "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export async function writeMemoryFact(input: MemoryFactInput, memoryDir: string = path.join(os.homedir(), ".pi", MEMORY_DIR)): Promise<{ slug: string; path: string; index: string }> {
	const fact = normalizeFact(input);
	return withMemoryWriteQueue(indexPath(memoryDir), async () => {
		await fs.mkdir(memoryDir, { recursive: true });
		const target = path.join(memoryDir, `${fact.slug}.md`);
		await fs.writeFile(target, serializeFact(fact), "utf8");
		const index = await rebuildIndex(memoryDir);
		return { slug: fact.slug, path: target, index };
	});
}

export async function rebuildIndex(memoryDir: string): Promise<string> {
	await fs.mkdir(memoryDir, { recursive: true });
	const facts = await readStoredFacts(memoryDir);
	const index = formatIndex(facts);
	await fs.writeFile(indexPath(memoryDir), index, "utf8");
	return index;
}

export function formatMemoryIndexBlock(index: string | null): string | null {
	const trimmed = index?.trim();
	if (!trimmed) return null;
	return [
		"# User-global personal memory index",
		"Loaded from ~/.pi/memory/MEMORY.md. Fetch full entries with recall_memory_entry(slug).",
		"",
		trimmed,
	].join("\n");
}

export async function migrateFlatFile(memoryDir: string, legacyMemoryPath = path.join(path.dirname(memoryDir), LEGACY_MEMORY_FILE)): Promise<{ migrated: number; skipped: boolean }> {
	const backupPath = path.join(path.dirname(legacyMemoryPath), LEGACY_BACKUP_FILE);
	if (await exists(backupPath)) return { migrated: 0, skipped: true };
	let raw: string;
	try {
		raw = await fs.readFile(legacyMemoryPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { migrated: 0, skipped: true };
		throw error;
	}
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- "));
	await fs.mkdir(memoryDir, { recursive: true });
	for (const line of lines) {
		const body = line.replace(/^-\s*/, "").trim();
		await writeMemoryFact({ name: titleFromBody(body), description: body, type: "user", body }, memoryDir);
	}
	await rebuildIndex(memoryDir);
	await fs.rename(legacyMemoryPath, backupPath);
	return { migrated: lines.length, skipped: false };
}

export function slugify(value: unknown): string {
	const text = normalizeOneLine(value) ?? "memory";
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
	return validateSlug(slug || "memory");
}

export function validateSlug(value: unknown): string {
	if (typeof value !== "string") throw new Error("memory slug must be a string");
	const slug = value.trim();
	if (slug.includes("/") || slug === "." || slug === ".." || slug.includes("..")) throw new Error("invalid memory slug");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("invalid memory slug");
	return slug;
}

function normalizeFact(input: MemoryFactInput): NormalizedFact {
	const body = normalizeBody(input.body);
	const name = normalizeOneLine(input.name) ?? titleFromBody(body);
	const description = normalizeOneLine(input.description) ?? firstLine(body);
	const type = normalizeType(input.type);
	const slug = input.slug === undefined ? slugify(name) : validateSlug(input.slug);
	return { name, description, type, body, slug };
}

function normalizeType(value: unknown): MemoryFactType {
	return typeof value === "string" && VALID_TYPES.has(value) ? value as MemoryFactType : "user";
}

function normalizeBody(value: unknown): string {
	if (typeof value !== "string") throw new Error("memory body is required");
	const normalized = value.replace(/\r\n/g, "\n").trim();
	if (!normalized) throw new Error("memory body is required");
	return normalized;
}

function normalizeOneLine(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

function firstLine(value: string): string {
	return value.split("\n")[0]?.replace(/\s+/g, " ").trim() || "Personal memory";
}

export function titleFromBody(value: string): string {
	return firstLine(value).replace(/^\d{4}-\d{2}-\d{2}\s+—\s+/, "").slice(0, 80) || "Personal memory";
}

async function readStoredFacts(memoryDir: string): Promise<StoredFact[]> {
	let names: string[];
	try {
		names = await fs.readdir(memoryDir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const facts: StoredFact[] = [];
	for (const fileName of names.filter((name) => name.endsWith(".md") && name !== INDEX_FILE).sort()) {
		const raw = await fs.readFile(path.join(memoryDir, fileName), "utf8");
		const fact = parseFact(raw);
		if (fact) facts.push({ ...fact, fileName });
	}
	return facts.sort((a, b) => a.name.localeCompare(b.name));
}

function parseFact(raw: string): NormalizedFact | null {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return null;
	const frontmatter = match[1];
	const body = match[2].trim();
	const name = frontmatter.match(/^name:\s*(.*)$/m)?.[1]?.trim();
	const description = frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim();
	const type = frontmatter.match(/^\s{2}type:\s*(.*)$/m)?.[1]?.trim();
	if (!name || !description || !type || !VALID_TYPES.has(type)) return null;
	try {
		return normalizeFact({ name, description, type, body });
	} catch {
		return null;
	}
}

function serializeFact(fact: NormalizedFact): string {
	return [
		"---",
		`name: ${escapeFrontmatter(fact.name)}`,
		`description: ${escapeFrontmatter(fact.description)}`,
		"metadata:",
		`  type: ${fact.type}`,
		"---",
		fact.body,
		"",
	].join("\n");
}

function formatIndex(facts: StoredFact[]): string {
	const lines = ["# Personal memory index", ""];
	for (const fact of facts) lines.push(`- [${fact.name}](${fact.fileName}) — ${fact.description}`);
	return `${lines.join("\n").trim()}\n`;
}

function escapeFrontmatter(value: string): string {
	return value.replace(/\r?\n/g, " ").trim();
}

function indexPath(memoryDir: string): string {
	return path.join(memoryDir, INDEX_FILE);
}

async function withMemoryWriteQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T> {
	// ponytail: process-local serialization covers parallel extension calls; add a lockfile if cross-process writers become supported.
	const prior = memoryWriteQueues.get(queueKey) ?? Promise.resolve();
	const result = prior.catch(() => undefined).then(operation);
	const settled = result.then(() => undefined, () => undefined);
	memoryWriteQueues.set(queueKey, settled);
	try {
		return await result;
	} finally {
		if (memoryWriteQueues.get(queueKey) === settled) memoryWriteQueues.delete(queueKey);
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
