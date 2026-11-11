import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearRequestCache } from "../presence.js";
import { cacheDirs, clearWithdrawn, failureCode, MAX_REQUEST_BYTES, OUTCOME_UNKNOWN, OutcomeUnknownError, processRequestFile, pruneAnswers, recoverInflight, RETENTION_MS, scanRequests, startPolling, type QueueResponse, type RequestQueue } from "../request-queue.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-queue-"));

function setup(name: string, handle: RequestQueue["handle"] = async (fileId) => ({ id: fileId, ok: true, result: {} })) {
	const base = path.join(root, name);
	const paths = {
		requests: path.join(base, "requests"),
		inflight: path.join(base, "inflight"),
		withdrawn: path.join(base, "withdrawn"),
		responses: path.join(base, "responses"),
		processed: path.join(base, "processed"),
	};
	for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const calls: Array<{ fileId: string; raw: unknown }> = [];
	let afterResponses = 0;
	const queue: RequestQueue = {
		paths,
		isCurrent: () => true,
		dirsArePrivate: () => Object.values(paths).every((dir) => {
			const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
			return !!stat && stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700;
		}),
		writeJson: (filePath, value) => {
			const tmp = `${filePath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
			fs.renameSync(tmp, filePath);
		},
		handle: async (fileId, raw) => {
			calls.push({ fileId, raw });
			return handle(fileId, raw);
		},
		afterResponse: () => { afterResponses += 1; },
	};
	return { paths, queue, calls, afterResponses: () => afterResponses };
}

function writeRequest(dir: string, id: string, body: string = JSON.stringify({ id, type: "recall", payload: {}, ts: 1 }), mode = 0o600): string {
	const file = path.join(dir, `${id}.json`);
	fs.writeFileSync(file, body, { mode });
	fs.chmodSync(file, mode);
	return file;
}

function readJson(file: string): QueueResponse {
	return JSON.parse(fs.readFileSync(file, "utf-8")) as QueueResponse;
}

async function main(): Promise<void> {
	// A request moves requests/ -> inflight/ -> processed/ + responses/; the handler runs once.
	{
		const { paths, queue, calls, afterResponses } = setup("happy");
		const id = randomUUID();
		writeRequest(paths.requests, id);
		await scanRequests(queue);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].fileId, id);
		assert.deepEqual(calls[0].raw, { id, type: "recall", payload: {}, ts: 1 });
		assert.deepEqual(readJson(path.join(paths.processed, `${id}.json`)), { id, ok: true, result: {} });
		assert.deepEqual(readJson(path.join(paths.responses, `${id}.json`)), { id, ok: true, result: {} });
		assert.deepEqual(fs.readdirSync(paths.requests), []);
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
		assert.equal(afterResponses(), 1);
	}

	// Overlapping scans: only the scan that wins the rename runs the handler; while it runs the
	// request sits in inflight/, invisible to every later scan.
	{
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { paths, queue, calls } = setup("overlap", async (fileId) => {
			await gate;
			return { id: fileId, ok: true, result: { ran: true } };
		});
		const id = randomUUID();
		writeRequest(paths.requests, id);
		const fileName = `${id}.json`;
		// Both callers already listed the file (the race the claim closes).
		const first = processRequestFile(queue, fileName);
		const second = processRequestFile(queue, fileName);
		const third = scanRequests(queue);
		assert.ok(fs.existsSync(path.join(paths.inflight, fileName)), "claimed request must sit in inflight/");
		await Promise.all([second, third]);
		release();
		await first;
		assert.equal(calls.length, 1, "handler must run exactly once");
		assert.deepEqual(readJson(path.join(paths.responses, fileName)), { id, ok: true, result: { ran: true } });
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
	}

	// Same-ID replay: a processed entry answers a repeated request without running it again.
	{
		const { paths, queue, calls } = setup("replay");
		const id = randomUUID();
		const cached = { id, ok: true, result: { cached: true } };
		fs.writeFileSync(path.join(paths.processed, `${id}.json`), JSON.stringify(cached), { mode: 0o600 });
		writeRequest(paths.requests, id);
		await scanRequests(queue);
		assert.equal(calls.length, 0);
		assert.deepEqual(readJson(path.join(paths.responses, `${id}.json`)), cached);
		assert.deepEqual(fs.readdirSync(paths.requests), []);
		// A response already present short-circuits too.
		writeRequest(paths.requests, id);
		await scanRequests(queue);
		assert.equal(calls.length, 0);
		assert.deepEqual(fs.readdirSync(paths.requests), []);
	}

	// Symlinks and non-0600 files are claimed, dropped and never parsed or answered.
	{
		const { paths, queue, calls } = setup("unsafe");
		const target = path.join(root, "outside.json");
		const linkId = randomUUID();
		fs.writeFileSync(target, JSON.stringify({ id: linkId, type: "recall", payload: {}, ts: 1 }), { mode: 0o600 });
		fs.symlinkSync(target, path.join(paths.requests, `${linkId}.json`));
		const loose = randomUUID();
		writeRequest(paths.requests, loose, undefined, 0o644);
		await scanRequests(queue);
		assert.equal(calls.length, 0);
		assert.deepEqual(fs.readdirSync(paths.requests), []);
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
		assert.deepEqual(fs.readdirSync(paths.responses), []);
		assert.ok(fs.existsSync(target), "symlink target must be untouched");
	}

	// Non-UUID names (including traversal attempts) and temp files are ignored.
	{
		const { paths, queue, calls } = setup("names");
		fs.writeFileSync(path.join(paths.requests, "not-a-uuid.json"), "{}", { mode: 0o600 });
		fs.writeFileSync(path.join(paths.requests, `${randomUUID()}.json.tmp.1.abc`), "{}", { mode: 0o600 });
		await scanRequests(queue);
		await processRequestFile(queue, `../${randomUUID()}.json`);
		assert.equal(calls.length, 0);
		assert.equal(fs.readdirSync(paths.requests).length, 2);
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
	}

	// Invalid JSON and handler throws become invalid_request keyed to the filename id.
	{
		const { paths, queue } = setup("invalid", async () => { throw new Error("Request type must be one of: recall."); });
		const badJson = randomUUID();
		writeRequest(paths.requests, badJson, "{not json");
		const throws = randomUUID();
		writeRequest(paths.requests, throws);
		await scanRequests(queue);
		const badResponse = readJson(path.join(paths.responses, `${badJson}.json`));
		assert.equal(badResponse.ok, false);
		assert.equal(badResponse.error?.code, "invalid_request");
		assert.equal(badResponse.id, badJson);
		assert.deepEqual(readJson(path.join(paths.responses, `${throws}.json`)), {
			id: throws,
			ok: false,
			error: { code: "invalid_request", message: "Request type must be one of: recall." },
		});
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
	}

	// A namespace that is no longer current, or whose dirs lost privacy, is never scanned.
	{
		const { paths, queue, calls } = setup("inactive");
		const id = randomUUID();
		writeRequest(paths.requests, id);
		await scanRequests({ ...queue, isCurrent: () => false });
		fs.chmodSync(paths.inflight, 0o755);
		await scanRequests(queue);
		assert.equal(calls.length, 0);
		assert.deepEqual(fs.readdirSync(paths.requests), [`${id}.json`]);
	}

	// Restart recovery: leftovers in inflight/ are never re-run. Unanswered ones become
	// outcome_unknown; answered ones replay processed/; a second start changes nothing.
	{
		const { paths, queue, calls } = setup("recover");
		const lost = randomUUID();
		const answered = randomUUID();
		const answer = { id: answered, ok: true, result: { saved: true } };
		writeRequest(paths.inflight, lost);
		writeRequest(paths.inflight, answered);
		fs.writeFileSync(path.join(paths.processed, `${answered}.json`), JSON.stringify(answer), { mode: 0o600 });
		fs.writeFileSync(path.join(paths.inflight, "not-a-uuid.json"), "{}", { mode: 0o600 });
		assert.equal(recoverInflight(queue), 1);
		assert.equal(calls.length, 0, "recovery must never run a leftover request");
		const unknown = readJson(path.join(paths.responses, `${lost}.json`));
		assert.equal(unknown.ok, false);
		assert.equal(unknown.error?.code, OUTCOME_UNKNOWN);
		assert.deepEqual(readJson(path.join(paths.processed, `${lost}.json`)), unknown);
		assert.deepEqual(readJson(path.join(paths.responses, `${answered}.json`)), answer);
		assert.deepEqual(fs.readdirSync(paths.inflight), ["not-a-uuid.json"]);
		// A repeated ID now gets the recorded answer instead of running.
		writeRequest(paths.requests, lost);
		await scanRequests(queue);
		assert.equal(calls.length, 0);
		assert.deepEqual(readJson(path.join(paths.responses, `${lost}.json`)), unknown);
		// Idempotent across repeated starts.
		assert.equal(recoverInflight(queue), 0);
		assert.deepEqual(readJson(path.join(paths.processed, `${lost}.json`)), unknown);
		// Non-private namespace: no recovery writes.
		const later = randomUUID();
		writeRequest(paths.inflight, later);
		fs.chmodSync(paths.responses, 0o755);
		assert.equal(recoverInflight(queue), 0);
		assert.ok(fs.existsSync(path.join(paths.inflight, `${later}.json`)));
		fs.chmodSync(paths.responses, 0o700);
	}

	// Clean stop: clearing cacheDirs leaves only presence.json in the namespace.
	{
		const { paths } = setup("clean-stop");
		const namespace = path.dirname(paths.requests);
		for (const dir of cacheDirs(paths)) fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), "{}", { mode: 0o600 });
		fs.writeFileSync(path.join(namespace, "presence.json"), "{}", { mode: 0o600 });
		assert.deepEqual(new Set(cacheDirs(paths)), new Set(Object.values(paths)), "cacheDirs must cover every queue dir");
		clearRequestCache(cacheDirs(paths));
		assert.deepEqual(fs.readdirSync(namespace), ["presence.json"]);
	}

	// Size cap: over MAX_REQUEST_BYTES is answered payload_too_large without parsing;
	// exactly MAX_REQUEST_BYTES is still handled.
	{
		const { paths, queue, calls } = setup("size");
		const big = randomUUID();
		writeRequest(paths.requests, big, "x".repeat(MAX_REQUEST_BYTES + 1));
		const edge = randomUUID();
		const prefix = JSON.stringify({ id: edge, type: "recall", payload: {}, ts: 1, pad: "" }).slice(0, -2);
		writeRequest(paths.requests, edge, `${prefix}${"y".repeat(MAX_REQUEST_BYTES - prefix.length - 2)}"}`);
		assert.equal(fs.statSync(path.join(paths.requests, `${edge}.json`)).size, MAX_REQUEST_BYTES);
		await scanRequests(queue);
		const tooLarge = readJson(path.join(paths.responses, `${big}.json`));
		assert.equal(tooLarge.error?.code, "payload_too_large");
		assert.deepEqual(calls.map((call) => call.fileId), [edge]);
		assert.deepEqual(fs.readdirSync(paths.inflight), []);
	}

	// Poll backstop: with no watcher, a request is still handled; withdrawn/ is cleared;
	// after stop nothing more runs.
	{
		const { paths, queue, calls } = setup("poll");
		const waitFor = async (check: () => boolean, ms = 2_000) => {
			const deadline = Date.now() + ms;
			while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			return check();
		};
		fs.writeFileSync(path.join(paths.withdrawn, `${randomUUID()}.json`), "{}", { mode: 0o600 });
		const stop = startPolling(queue, () => { void scanRequests(queue); }, { intervalMs: 20 });
		const id = randomUUID();
		writeRequest(paths.requests, id);
		assert.ok(await waitFor(() => fs.existsSync(path.join(paths.responses, `${id}.json`))), "poll must handle the request");
		assert.ok(await waitFor(() => fs.readdirSync(paths.withdrawn).length === 0), "poll must clear withdrawn/");
		stop();
		const after = randomUUID();
		writeRequest(paths.requests, after);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(calls.map((call) => call.fileId), [id]);
		assert.deepEqual(fs.readdirSync(paths.requests), [`${after}.json`]);
		// A namespace that is no longer current is not polled.
		const idle = startPolling({ ...queue, isCurrent: () => false }, () => { void scanRequests(queue); }, { intervalMs: 20 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		idle();
		assert.deepEqual(fs.readdirSync(paths.requests), [`${after}.json`]);
	}

	// Retention: answers older than RETENTION_MS are pruned, fresh ones kept.
	{
		const { paths, queue } = setup("retention");
		const now = Date.now();
		const old = new Date(now - RETENTION_MS - 1_000);
		for (const dir of [paths.processed, paths.responses]) {
			fs.writeFileSync(path.join(dir, "old.json"), "{}", { mode: 0o600 });
			fs.utimesSync(path.join(dir, "old.json"), old, old);
			fs.writeFileSync(path.join(dir, "fresh.json"), "{}", { mode: 0o600 });
		}
		pruneAnswers(queue, now);
		assert.deepEqual(fs.readdirSync(paths.processed), ["fresh.json"]);
		assert.deepEqual(fs.readdirSync(paths.responses), ["fresh.json"]);
		assert.equal(clearWithdrawn(queue), 0);
	}

	// Only OutcomeUnknownError maps to outcome_unknown; every other error keeps its code.
	assert.equal(failureCode(new OutcomeUnknownError("timed out"), "save_plan_failed"), OUTCOME_UNKNOWN);
	assert.equal(failureCode(new Error("timed out"), "read_plan_tasks_failed"), "read_plan_tasks_failed");
	assert.equal(failureCode("boom", "capture_failed"), "capture_failed");

	console.log("request-queue tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
}).finally(() => fs.rmSync(root, { recursive: true, force: true }));
