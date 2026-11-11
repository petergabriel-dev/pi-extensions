import * as fs from "node:fs";
import * as path from "node:path";

// File-IPC request queue. A request moves requests/ -> inflight/ (claim by atomic
// rename) -> processed/ + responses/. The directory a request is in is its state;
// only the scan that wins the rename runs the handler, so overlapping scans never
// execute one request twice.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_REQUEST_BYTES = 1024 * 1024;
// Backstop for missed fs.watch events: a lost event costs at most one poll interval.
export const POLL_MS = 500;
// Old answers are kept long enough to replay a repeated ID (clients wait ~32 s at most).
export const RETENTION_MS = 10 * 60_000;
export const PRUNE_EVERY_MS = 60_000;

// The operation may or may not have been applied (crash mid-request, or a write whose
// owner did not answer in time). Never report it as a plain failure.
export const OUTCOME_UNKNOWN = "outcome_unknown";

export class OutcomeUnknownError extends Error {}

export function failureCode(error: unknown, fallback: string): string {
	return error instanceof OutcomeUnknownError ? OUTCOME_UNKNOWN : fallback;
}

export interface QueuePaths {
	requests: string;
	inflight: string;
	withdrawn: string;
	responses: string;
	processed: string;
}

/** Every request-cache directory; a clean stop removes all of them (presence.json stays). */
export function cacheDirs(paths: QueuePaths): string[] {
	return [paths.requests, paths.inflight, paths.withdrawn, paths.responses, paths.processed];
}

export interface QueueResponse {
	id: string;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: { code: string; message: string };
}

export interface RequestQueue {
	paths: QueuePaths;
	/** False once this namespace is no longer the active one; scans and claims stop. */
	isCurrent(): boolean;
	/** Whether every namespace directory is still a real 0700 directory. */
	dirsArePrivate(): boolean;
	/** Atomic, 0600 JSON write. */
	writeJson(filePath: string, value: unknown): void;
	/** Validates and runs one parsed request; a throw becomes an invalid_request response. */
	handle(fileId: string, raw: unknown): Promise<QueueResponse>;
	afterResponse(): void;
}

function readJson(filePath: string): unknown | null {
	try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function safeUnlink(filePath: string): void {
	try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function errorResponse(id: string, code: string, message: string): QueueResponse {
	return { id, ok: false, error: { code, message } };
}

function writeResponse(queue: RequestQueue, response: QueueResponse): void {
	if (!queue.dirsArePrivate()) return;
	// processed/ first: it is the replay cache that keeps a repeated ID from running again.
	queue.writeJson(path.join(queue.paths.processed, `${response.id}.json`), response);
	queue.writeJson(path.join(queue.paths.responses, `${response.id}.json`), response);
}

function replayProcessedResponse(queue: RequestQueue, id: string): boolean {
	const responseFile = path.join(queue.paths.responses, `${id}.json`);
	if (fs.existsSync(responseFile)) return true;
	const processed = readJson(path.join(queue.paths.processed, `${id}.json`));
	if (!processed) return false;
	queue.writeJson(responseFile, processed);
	return true;
}

export async function processRequestFile(queue: RequestQueue, fileName: string): Promise<void> {
	if (!queue.isCurrent() || !fileName.endsWith(".json")) return;
	const fileId = fileName.slice(0, -".json".length);
	if (!UUID_RE.test(fileId)) return;
	const requestFile = path.join(queue.paths.requests, fileName);
	if (replayProcessedResponse(queue, fileId)) {
		safeUnlink(requestFile);
		return;
	}

	// Claim: only one scan can move the file. ENOENT means another scan claimed it or
	// the client withdrew it; either way this scan must not run it.
	const claimed = path.resolve(queue.paths.inflight, fileName);
	if (path.dirname(claimed) !== path.resolve(queue.paths.inflight)) {
		writeResponse(queue, errorResponse(fileId, "path_traversal", "Request path escaped bridge inflight directory."));
		return;
	}
	try { fs.renameSync(requestFile, claimed); } catch { return; }

	// rename moves a symlink itself, so lstat sees exactly what was claimed.
	let stat: fs.Stats;
	try { stat = fs.lstatSync(claimed); } catch { return; }
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
		safeUnlink(claimed);
		return;
	}
	if (stat.size > MAX_REQUEST_BYTES) {
		writeResponse(queue, errorResponse(fileId, "payload_too_large", `Bridge request exceeds ${MAX_REQUEST_BYTES} bytes.`));
		safeUnlink(claimed);
		queue.afterResponse();
		return;
	}

	let response: QueueResponse;
	try {
		response = await queue.handle(fileId, JSON.parse(fs.readFileSync(claimed, "utf-8")));
	} catch (error) {
		response = errorResponse(fileId, "invalid_request", error instanceof Error ? error.message : String(error));
	}
	writeResponse(queue, response);
	safeUnlink(claimed);
	queue.afterResponse();
}

// Startup: a request left in inflight/ was claimed by a Pi that stopped before
// answering, so it may or may not have run. It is never re-run: an existing processed/
// answer is replayed, otherwise outcome_unknown is recorded so a repeated ID gets the
// same answer. Returns how many requests were converted to outcome_unknown.
export function recoverInflight(queue: RequestQueue): number {
	if (!queue.dirsArePrivate()) return 0;
	let fileNames: string[];
	try { fileNames = fs.readdirSync(queue.paths.inflight); } catch { return 0; }
	let converted = 0;
	for (const fileName of fileNames) {
		if (!fileName.endsWith(".json")) continue;
		const fileId = fileName.slice(0, -".json".length);
		if (!UUID_RE.test(fileId)) continue;
		if (!replayProcessedResponse(queue, fileId)) {
			writeResponse(queue, errorResponse(fileId, OUTCOME_UNKNOWN, "Pi stopped while handling this request; it may or may not have been applied."));
			converted += 1;
		}
		safeUnlink(path.join(queue.paths.inflight, fileName));
	}
	return converted;
}

function removeEntries(dir: string, shouldRemove: (stat: fs.Stats) => boolean): number {
	let fileNames: string[];
	try { fileNames = fs.readdirSync(dir); } catch { return 0; }
	let removed = 0;
	for (const fileName of fileNames) {
		const filePath = path.join(dir, fileName);
		let stat: fs.Stats;
		try { stat = fs.lstatSync(filePath); } catch { continue; }
		if (stat.isDirectory() || !shouldRemove(stat)) continue;
		safeUnlink(filePath);
		removed += 1;
	}
	return removed;
}

/** Removes requests the client withdrew (never run). Returns how many were removed. */
export function clearWithdrawn(queue: RequestQueue): number {
	if (!queue.dirsArePrivate()) return 0;
	return removeEntries(queue.paths.withdrawn, () => true);
}

/** Removes processed/ and responses/ entries older than RETENTION_MS. */
export function pruneAnswers(queue: RequestQueue, now = Date.now()): void {
	if (!queue.dirsArePrivate()) return;
	for (const dir of [queue.paths.processed, queue.paths.responses]) removeEntries(dir, (stat) => now - stat.mtimeMs > RETENTION_MS);
}

// Every tick: clear withdrawn/ and request a scan; prune old answers once per
// PRUNE_EVERY_MS. Unref'd, never throws, and idle once the namespace is not current.
export function startPolling(queue: RequestQueue, scan: () => void, { intervalMs = POLL_MS, pruneEveryMs = PRUNE_EVERY_MS }: { intervalMs?: number; pruneEveryMs?: number } = {}): () => void {
	let lastPruneAt = 0;
	const timer = setInterval(() => {
		try {
			if (!queue.isCurrent()) return;
			clearWithdrawn(queue);
			const now = Date.now();
			if (now - lastPruneAt >= pruneEveryMs) {
				lastPruneAt = now;
				pruneAnswers(queue, now);
			}
			scan();
		} catch { /* best-effort backstop; the next tick retries */ }
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

export async function scanRequests(queue: RequestQueue): Promise<void> {
	if (!queue.isCurrent() || !queue.dirsArePrivate()) return;
	let fileNames: string[];
	try { fileNames = fs.readdirSync(queue.paths.requests); } catch { return; }
	for (const fileName of fileNames) await processRequestFile(queue, fileName);
}
