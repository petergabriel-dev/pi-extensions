import * as fs from "node:fs";
import * as path from "node:path";

// File-IPC request queue. A request moves requests/ -> inflight/ (claim by atomic
// rename) -> processed/ + responses/. The directory a request is in is its state;
// only the scan that wins the rename runs the handler, so overlapping scans never
// execute one request twice.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface QueuePaths {
	requests: string;
	inflight: string;
	responses: string;
	processed: string;
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

export async function scanRequests(queue: RequestQueue): Promise<void> {
	if (!queue.isCurrent() || !queue.dirsArePrivate()) return;
	let fileNames: string[];
	try { fileNames = fs.readdirSync(queue.paths.requests); } catch { return; }
	for (const fileName of fileNames) await processRequestFile(queue, fileName);
}
