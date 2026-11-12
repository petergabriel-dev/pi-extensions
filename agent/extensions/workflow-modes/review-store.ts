import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

// Append-only review log: <agentDir>/plans/<sessionId>/reviews.jsonl.
// One validated JSON event per line; never rewritten, truncated, or deleted.

export const REVIEW_LOG_NAME = "reviews.jsonl";
export const MAX_REVIEW_LOG_BYTES = 1024 * 1024;
export const MAX_REVIEW_LINE_BYTES = 16 * 1024;
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export const REVIEW_EVENT_TYPES = [
	"bundle_created",
	"attempt_abandoned",
	"review_started",
	"finding_submitted",
	"finding_approved",
	"finding_rejected",
	"finding_resolved",
	"task_approved",
] as const;
export type ReviewEventType = typeof REVIEW_EVENT_TYPES[number];

export interface ReviewEvent {
	ev: ReviewEventType;
	at: number;
	id?: string;
	planId?: string;
	taskId?: string;
	[field: string]: unknown;
}

export interface ReviewLog {
	events: ReviewEvent[];
	warnings: string[];
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINDING_ID = /^F[1-9][0-9]{0,8}$/;
const FINDING_REFERENCE_EVENTS: ReadonlySet<string> = new Set(["finding_approved", "finding_rejected", "finding_resolved"]);
const EVENT_TYPES: ReadonlySet<string> = new Set(REVIEW_EVENT_TYPES);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const queues = new Map<string, Promise<unknown>>();

export function reviewSessionDir(agentDir: string, sessionId: string): string {
	if (typeof sessionId !== "string" || !SAFE_SEGMENT.test(sessionId)) throw new Error("sessionId must be a path-safe identifier");
	return join(agentDir, "plans", sessionId);
}

export function reviewLogPath(agentDir: string, sessionId: string): string {
	return join(reviewSessionDir(agentDir, sessionId), REVIEW_LOG_NAME);
}

function isCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

// Creates (or tightens) a real directory to 0700; symlinks and non-directories are refused.
export async function ensurePrivateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path} is not a private directory`);
	if ((info.mode & 0o777) !== PRIVATE_DIR_MODE) await chmod(path, PRIVATE_DIR_MODE);
}

// Writes a new 0600 file exactly once. An existing regular file is left untouched
// ("exists"); an existing symlink or non-file is an error, never followed.
export async function writeOnce0600(path: string, data: string): Promise<"written" | "exists"> {
	let handle;
	try {
		handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
	} catch (error) {
		if (!isCode(error, "EEXIST")) throw error;
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path} exists and is not a regular file`);
		return "exists";
	}
	try {
		await handle.chmod(PRIVATE_FILE_MODE);
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return "written";
}

async function readLogBytes(path: string): Promise<Buffer | undefined> {
	let handle;
	try {
		handle = await open(path, READ_FLAGS);
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		if (isCode(error, "ELOOP")) throw new Error("review log is a symlink");
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("review log is not a regular file");
		if (info.size > MAX_REVIEW_LOG_BYTES + MAX_REVIEW_LINE_BYTES) throw new Error("review log exceeds its size limit");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

function parseLog(bytes: Buffer | undefined): ReviewLog {
	const events: ReviewEvent[] = [];
	const warnings: string[] = [];
	if (!bytes) return { events, warnings };
	const lines = bytes.toString("utf8").split("\n");
	lines.forEach((line, index) => {
		if (line.trim().length === 0) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			warnings.push(`reviews.jsonl line ${index + 1} is malformed and was skipped`);
			return;
		}
		const event = value as ReviewEvent;
		if (!value || typeof value !== "object" || Array.isArray(value) || !EVENT_TYPES.has(event.ev) || !Number.isFinite(event.at)) {
			warnings.push(`reviews.jsonl line ${index + 1} is not a review event and was skipped`);
			return;
		}
		events.push(event);
	});
	return { events, warnings };
}

export async function readReviewLog(agentDir: string, sessionId: string): Promise<ReviewLog> {
	return parseLog(await readLogBytes(reviewLogPath(agentDir, sessionId)));
}

function nextFindingId(events: readonly ReviewEvent[]): string {
	let max = 0;
	for (const event of events) {
		if (event.ev !== "finding_submitted" || typeof event.id !== "string" || !FINDING_ID.test(event.id)) continue;
		max = Math.max(max, Number(event.id.slice(1)));
	}
	return `F${max + 1}`;
}

function validateEvent(input: Record<string, unknown>, existing: readonly ReviewEvent[]): void {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("review event must be an object");
	if (!EVENT_TYPES.has(input.ev as string)) throw new Error(`unknown review event type ${JSON.stringify(input.ev)}`);
	if ("at" in input) throw new Error("review event time is assigned by the store");
	if (FINDING_REFERENCE_EVENTS.has(input.ev as string)) {
		if (typeof input.id !== "string" || !FINDING_ID.test(input.id)) throw new Error(`${input.ev} requires a finding id`);
		if (!existing.some((event) => event.ev === "finding_submitted" && event.id === input.id)) throw new Error(`unknown finding ${input.id}`);
		return;
	}
	if (input.ev === "finding_submitted" && "id" in input) throw new Error("finding ids are assigned by the store");
	if (typeof input.planId !== "string" || !SAFE_SEGMENT.test(input.planId)) throw new Error(`${input.ev} requires a path-safe planId`);
	if (typeof input.taskId !== "string" || !SAFE_ID.test(input.taskId)) throw new Error(`${input.ev} requires a safe taskId`);
}

async function appendNow(agentDir: string, sessionId: string, input: Record<string, unknown>): Promise<ReviewEvent> {
	const directory = reviewSessionDir(agentDir, sessionId);
	await ensurePrivateDir(directory);
	const path = reviewLogPath(agentDir, sessionId);
	const bytes = await readLogBytes(path);
	const { events } = parseLog(bytes);
	validateEvent(input, events);
	// validateEvent established ev and the required identifiers.
	const event = {
		...input,
		...(input.ev === "finding_submitted" ? { id: nextFindingId(events) } : {}),
		at: Date.now(),
	} as ReviewEvent;
	// A torn last line stays its own (skipped) line; the new event starts fresh.
	const separator = bytes && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? "\n" : "";
	const line = `${separator}${JSON.stringify(event)}\n`;
	const lineBytes = Buffer.byteLength(line, "utf8");
	if (lineBytes > MAX_REVIEW_LINE_BYTES) throw new Error(`review event exceeds ${MAX_REVIEW_LINE_BYTES} bytes`);
	if ((bytes?.length ?? 0) + lineBytes > MAX_REVIEW_LOG_BYTES) throw new Error(`review log is full (${MAX_REVIEW_LOG_BYTES} bytes); no further review events can be recorded this session`);

	let handle;
	try {
		handle = await open(path, APPEND_FLAGS, PRIVATE_FILE_MODE);
	} catch (error) {
		if (isCode(error, "ELOOP")) throw new Error("review log is a symlink");
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("review log is not a regular file");
		if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE);
		await handle.writeFile(line, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return event;
}

// Appends are serialized per log file so finding ids and line order stay consistent.
export function appendReviewEvent(agentDir: string, sessionId: string, input: Record<string, unknown>): Promise<ReviewEvent> {
	let key: string;
	try {
		key = reviewLogPath(agentDir, sessionId);
	} catch (error) {
		return Promise.reject(error);
	}
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(() => appendNow(agentDir, sessionId, input));
	queues.set(key, next);
	void next.finally(() => {
		if (queues.get(key) === next) queues.delete(key);
	}).catch(() => undefined);
	return next;
}
