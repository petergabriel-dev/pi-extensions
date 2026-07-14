import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_BRANCH_LENGTH = 120;

export interface PlanStoreOptions {
	cwd?: string;
	homeDir?: string;
	branch?: string;
}

export interface PlanRecord {
	planId: string;
	savedAt: string;
	plan: string;
}

export interface WritePlanOptions extends PlanStoreOptions {
	planId: string;
	savedAt?: string;
}

export async function resolvePlanPath(options: PlanStoreOptions = {}): Promise<string> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const repoRoot = await resolveRepoRoot(cwd);
	const branch = sanitizeBranchName(options.branch ?? await resolveBranch(cwd));
	const homeDir = options.homeDir ?? os.homedir();
	return path.join(homeDir, ".pi", "agent", "plans", encodeRepoRoot(repoRoot), `${branch}.md`);
}

export async function readPlan(options: PlanStoreOptions = {}): Promise<PlanRecord | null> {
	const target = await resolvePlanPath(options);
	try {
		return parsePlan(await fs.readFile(target, "utf8"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export async function writePlan(plan: string, options: WritePlanOptions): Promise<PlanRecord> {
	if (typeof plan !== "string" || plan.trim().length === 0) throw new Error("plan text is required");
	const planId = requireText(options.planId, "planId");
	const savedAt = options.savedAt ?? new Date().toISOString();
	if (Number.isNaN(Date.parse(savedAt))) throw new Error("savedAt must be an ISO date");

	const target = await resolvePlanPath(options);
	const directory = path.dirname(target);
	await fs.mkdir(directory, { recursive: true });
	const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
	const record = { planId, savedAt, plan };
	try {
		await fs.writeFile(temporary, serializePlan(record), "utf8");
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return record;
}

export async function clearPlan(options: PlanStoreOptions = {}): Promise<void> {
	const target = await resolvePlanPath(options);
	try {
		await fs.rm(target);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export function sanitizeBranchName(value: string): string {
	if (typeof value !== "string") throw new Error("branch name must be a string");
	const branch = value.trim();
	if (!branch || branch.length > MAX_BRANCH_LENGTH || branch.includes("..")) throw new Error("invalid branch name");
	const sanitized = branch.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!sanitized || sanitized === ".") throw new Error("invalid branch name");
	return sanitized;
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd });
		const root = stdout.trim();
		return root ? path.resolve(root) : cwd;
	} catch {
		return cwd;
	}
}

async function resolveBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
		const branch = stdout.trim();
		if (branch) return branch;
	} catch {
		// Detached HEAD or non-git directory below.
	}
	try {
		const { stdout } = await execFile("git", ["rev-parse", "--short", "HEAD"], { cwd });
		const revision = stdout.trim();
		if (revision) return `detached-${revision}`;
	} catch {
		// No git repository.
	}
	return "no-git";
}

function encodeRepoRoot(repoRoot: string): string {
	return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function serializePlan(record: PlanRecord): string {
	return ["---", `planId: ${JSON.stringify(record.planId)}`, `savedAt: ${JSON.stringify(record.savedAt)}`, "---", record.plan].join("\n");
}

function parsePlan(raw: string): PlanRecord {
	const match = raw.match(/^---\nplanId: (.+)\nsavedAt: (.+)\n---\n([\s\S]*)$/);
	if (!match) throw new Error("invalid saved plan file");
	try {
		const planId = requireText(JSON.parse(match[1]), "planId");
		const savedAt = String(JSON.parse(match[2]));
		if (Number.isNaN(Date.parse(savedAt))) throw new Error("invalid savedAt");
		return { planId, savedAt, plan: match[3] };
	} catch (error) {
		throw new Error(`invalid saved plan file: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function requireText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
	return value;
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
