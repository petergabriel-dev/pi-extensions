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
	/** health.jsonl ring file. */
	health: string;
}

/** Every request-cache path; a clean stop removes all of them (presence.json stays). */
export function cachePaths(paths: QueuePaths): string[] {
	return [paths.requests, paths.inflight, paths.withdrawn, paths.responses, paths.processed, paths.health];
}

// Health: timings, sizes and outcome codes only. Never payloads, query or plan text,
// peer ids or session ids; type and outcome are reduced to a short [a-z_] code.
export const HEALTH_RING_SIZE = 500;
export const DEFAULT_SLOW_COMPLETION_MS = 30_000;

export interface HealthEntry {
	ts: number;
	type: string;
	outcome: string;
	ms: number;
	reqBytes: number;
	resBytes: number;
	replay: boolean;
	/** The client's one re-send of a read after outcome_unknown (envelope `retry: true`). */
	retry: boolean;
}

function code(value: unknown): string {
	return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "unknown";
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

// Raw values are sanitized here; anything not a short code or a count is dropped.
type HealthInput = { [Key in keyof HealthEntry]?: unknown };

function healthEntry(value: HealthInput): HealthEntry {
	return { ts: count(value.ts), type: code(value.type), outcome: code(value.outcome), ms: count(value.ms), reqBytes: count(value.reqBytes), resBytes: count(value.resBytes), replay: value.replay === true, retry: value.retry === true };
}

/** Slow-completion threshold: Pi's PI_BRIDGE_COMPLETION_TIMEOUT_MS when valid, else 30 s. */
export function slowCompletionMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = Number(env.PI_BRIDGE_COMPLETION_TIMEOUT_MS);
	return Number.isInteger(value) && value > 0 && value <= 10 * 60_000 ? value : DEFAULT_SLOW_COMPLETION_MS;
}

function percentile(sorted: number[], fraction: number): number {
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

export class BridgeHealth {
	entries: HealthEntry[] = [];
	counters = { restartConversions: 0, withdrawn: 0, slowCompletions: 0 };

	constructor(private readonly file: string, private readonly canWrite: () => boolean, private readonly slowMs = slowCompletionMs()) {
		// Survives a crash: reload the ring, keeping only well-formed whitelisted entries.
		let raw = "";
		try { raw = fs.readFileSync(file, "utf-8"); } catch { return; }
		const keys = JSON.stringify(Object.keys(healthEntry({})));
		for (const line of raw.split("\n")) {
			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === "object" && JSON.stringify(Object.keys(parsed)) === keys) this.entries.push(healthEntry(parsed));
			} catch { /* skip malformed line */ }
		}
		this.entries = this.entries.slice(-HEALTH_RING_SIZE);
	}

	record(value: HealthInput): void {
		const entry = healthEntry({ ts: Date.now(), ...value });
		this.entries.push(entry);
		if (this.entries.length > HEALTH_RING_SIZE) this.entries = this.entries.slice(-HEALTH_RING_SIZE);
		if (entry.ms > this.slowMs) this.counters.slowCompletions += 1;
		if (!this.canWrite()) return;
		const tmp = `${this.file}.tmp.${process.pid}`;
		try {
			fs.writeFileSync(tmp, `${this.entries.map((item) => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
			fs.chmodSync(tmp, 0o600);
			fs.renameSync(tmp, this.file);
		} catch {
			safeUnlink(tmp); // Diagnostics are best-effort; never fail a request over them.
		}
	}

	summary(): string {
		if (this.entries.length === 0 && Object.values(this.counters).every((value) => value === 0)) return "Bridge health: no requests recorded yet.";
		const byType = new Map<string, HealthEntry[]>();
		for (const entry of this.entries) byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
		const lines = [`Bridge health: last ${this.entries.length} request(s)${this.entries[0] ? ` since ${new Date(this.entries[0].ts).toISOString()}` : ""}`];
		for (const [type, items] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
			const ms = items.map((item) => item.ms).sort((a, b) => a - b);
			const res = items.map((item) => item.resBytes).sort((a, b) => a - b);
			const errors = items.filter((item) => item.outcome !== "ok" && item.outcome !== "replay").length;
			lines.push(`${type.padEnd(16)} n=${items.length}  p50 ${percentile(ms, 0.5)}ms  p95 ${percentile(ms, 0.95)}ms  res p95 ${(percentile(res, 0.95) / 1024).toFixed(1)}KB  errors ${errors}`);
		}
		const outcomeUnknown = this.entries.filter((entry) => entry.outcome === OUTCOME_UNKNOWN).length;
		const replays = this.entries.filter((entry) => entry.replay).length;
		const retries = this.entries.filter((entry) => entry.retry).length;
		lines.push(`not_delivered (withdrawn) ${this.counters.withdrawn} · outcome_unknown ${outcomeUnknown} · replays ${replays} · restart conversions ${this.counters.restartConversions} · slow completions ${this.counters.slowCompletions} · retries ${retries}`);
		return lines.join("\n");
	}
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
	health?: BridgeHealth | null;
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
	// A stale directory listing: another scan already handled it, or the client withdrew it.
	if (!fs.lstatSync(requestFile, { throwIfNoEntry: false })) return;
	if (replayProcessedResponse(queue, fileId)) {
		safeUnlink(requestFile);
		queue.health?.record({ type: "unknown", outcome: "replay", replay: true });
		return;
	}

	// Claim: only one scan can move the file. ENOENT means another scan claimed it or
	// the client withdrew it; either way this scan must not run it.
	const claimed = path.resolve(queue.paths.inflight, fileName);
	if (path.dirname(claimed) !== path.resolve(queue.paths.inflight)) {
		writeResponse(queue, errorResponse(fileId, "path_traversal", "Request path escaped bridge inflight directory."));
		return;
	}
	// The same ID is still running: rename would replace it and run it twice. Leave the
	// duplicate in requests/; once the first answer lands it is replayed.
	if (fs.lstatSync(claimed, { throwIfNoEntry: false })) return;
	try { fs.renameSync(requestFile, claimed); } catch { return; }

	// rename moves a symlink itself, so lstat sees exactly what was claimed.
	let stat: fs.Stats;
	try { stat = fs.lstatSync(claimed); } catch { return; }
	const started = Date.now();
	const reqBytes = stat.size;
	const finish = (response: QueueResponse, envelope: { type?: unknown; retry?: unknown } = {}): void => {
		writeResponse(queue, response);
		safeUnlink(claimed);
		queue.health?.record({
			type: envelope.type ?? "unknown",
			outcome: response.ok ? "ok" : response.error?.code,
			ms: Date.now() - started,
			reqBytes,
			resBytes: Buffer.byteLength(JSON.stringify(response), "utf-8"),
			replay: false,
			retry: envelope.retry,
		});
		queue.afterResponse();
	};
	// Never parsed, but answered, so the client is not left waiting for an outcome.
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
		finish(errorResponse(fileId, "invalid_request", "Bridge request file must be a regular 0600 file."));
		return;
	}
	if (reqBytes > MAX_REQUEST_BYTES) {
		finish(errorResponse(fileId, "payload_too_large", `Bridge request exceeds ${MAX_REQUEST_BYTES} bytes.`));
		return;
	}

	let raw: unknown;
	let response: QueueResponse;
	try {
		raw = JSON.parse(fs.readFileSync(claimed, "utf-8"));
		response = await queue.handle(fileId, raw);
	} catch (error) {
		response = errorResponse(fileId, "invalid_request", error instanceof Error ? error.message : String(error));
	}
	finish(response, raw && typeof raw === "object" ? raw as { type?: unknown; retry?: unknown } : {});
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
	if (queue.health) queue.health.counters.restartConversions += converted;
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
			const withdrawn = clearWithdrawn(queue);
			if (queue.health) queue.health.counters.withdrawn += withdrawn;
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
