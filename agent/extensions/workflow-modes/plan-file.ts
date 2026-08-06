import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MAX_PLAN_BYTES = 256 * 1024;
export const PLAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlanFileReference {
	sessionId: string;
	planId: string;
}

const runtimeRequire = createRequire(import.meta.url);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function validateSegment(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
		throw new Error(`${label} must be a path-safe identifier`);
	}
	return value;
}

function getAgentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return resolve(configured);

	try {
		const pi = runtimeRequire("@earendil-works/pi-coding-agent") as { getAgentDir?: () => string };
		if (typeof pi.getAgentDir === "function") return resolve(pi.getAgentDir());
	} catch {
		// Tests can provide PI_CODING_AGENT_DIR without installing Pi peers.
	}

	throw new Error("Pi getAgentDir() unavailable");
}

function plansDirectory(): string {
	return join(getAgentDirectory(), "plans");
}

export function getPlanFilePath(sessionId: string, planId: string): string {
	const safeSessionId = validateSegment(sessionId, "sessionId");
	const safePlanId = validateSegment(planId, "planId");
	return join(plansDirectory(), safeSessionId, `${safePlanId}.md`);
}

async function ensurePlanDirectory(sessionId: string): Promise<string> {
	const root = plansDirectory();
	await mkdir(root, { recursive: true });
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("plan store root is not a directory");

	const sessionDirectory = join(root, validateSegment(sessionId, "sessionId"));
	await mkdir(sessionDirectory, { recursive: true });
	const sessionInfo = await lstat(sessionDirectory);
	if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()) throw new Error("plan session path is not a directory");
	return sessionDirectory;
}

export async function writePlanFile(sessionId: string, planId: string, text: string): Promise<string> {
	if (typeof text !== "string" || text.length === 0) throw new Error("plan text is required");
	if (Buffer.byteLength(text, "utf8") > MAX_PLAN_BYTES) throw new Error(`plan text exceeds ${MAX_PLAN_BYTES} bytes`);

	const sessionDirectory = await ensurePlanDirectory(sessionId);
	const safePlanId = validateSegment(planId, "planId");
	const destination = join(sessionDirectory, `${safePlanId}.md`);
	const temporary = join(sessionDirectory, `.${safePlanId}.tmp.${process.pid}.${randomUUID()}`);
	try {
		await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
		const handle = await open(temporary, "r+");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, destination);
		return destination;
	} catch (error) {
		try {
			await unlink(temporary);
		} catch (cleanupError) {
			if (!isMissing(cleanupError)) throw new AggregateError([error, cleanupError], "Failed to clean up temporary plan file");
		}
		throw error;
	}
}

export async function readPlanFile(sessionId: string, planId: string): Promise<string | undefined> {
	const filePath = getPlanFilePath(sessionId, planId);
	try {
		const fileInfo = await lstat(filePath);
		if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("plan file is not a regular file");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}

	let handle;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}

	try {
		const size = (await handle.stat()).size;
		if (size > MAX_PLAN_BYTES) throw new Error(`plan file exceeds ${MAX_PLAN_BYTES} bytes`);
		const buffer = Buffer.alloc(size);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		await handle.close();
	}
}

export async function gcPlanFiles(referencedPlans: Iterable<PlanFileReference>, now = Date.now()): Promise<string[]> {
	if (!Number.isFinite(now)) throw new Error("now must be a finite timestamp");
	const referenced = new Set<string>();
	for (const plan of referencedPlans) referenced.add(getPlanFilePath(plan.sessionId, plan.planId));

	const root = plansDirectory();
	try {
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("plan store root is not a directory");
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}

	let sessions;
	try {
		sessions = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}

	const deleted: string[] = [];
	const cutoff = now - PLAN_RETENTION_MS;
	for (const session of sessions) {
		if (!session.isDirectory() || !SAFE_SEGMENT.test(session.name)) continue;
		const sessionDirectory = join(root, session.name);
		let files;
		try {
			files = await readdir(sessionDirectory, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".md")) continue;
			const planId = file.name.slice(0, -3);
			if (!SAFE_SEGMENT.test(planId)) continue;
			const filePath = join(sessionDirectory, file.name);
			if (referenced.has(filePath)) continue;
			const fileInfo = await stat(filePath);
			if (fileInfo.mtimeMs >= cutoff) continue;
			await unlink(filePath);
			deleted.push(filePath);
		}
	}
	return deleted;
}
