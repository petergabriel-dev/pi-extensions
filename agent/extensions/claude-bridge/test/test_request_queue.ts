import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearRequestCache } from "../presence.js";
import { BridgeHealth, cachePaths, clearWithdrawn, HEALTH_RING_SIZE, failureCode, MAX_REQUEST_BYTES, OUTCOME_UNKNOWN, OutcomeUnknownError, processRequestFile, pruneAnswers, recoverInflight, RETENTION_MS, scanRequests, startPolling, type QueueResponse, type RequestQueue } from "../request-queue.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-queue-"));

function setup(name: string, handle: RequestQueue["handle"] = async (fileId) => ({ id: fileId, ok: true, result: {} })) {
	const base = path.join(root, name);
	const paths = {
		requests: path.join(base, "requests"),
		inflight: path.join(base, "inflight"),
		withdrawn: path.join(base, "withdrawn"),
		responses: path.join(base, "responses"),
		processed: path.join(base, "processed"),
		health: path.join(base, "health.jsonl"),
	};
	const dirs = [paths.requests, paths.inflight, paths.withdrawn, paths.responses, paths.processed];
	for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const calls: Array<{ fileId: string; raw: unknown }> = [];
	let afterResponses = 0;
	const queue: RequestQueue = {
		paths,
		isCurrent: () => true,
		dirsArePrivate: () => dirs.every((dir) => {
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

	// Symlinks and non-0600 files are claimed and never parsed, but answered invalid_request.
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
		for (const id of [linkId, loose]) {
			const answer = readJson(path.join(paths.responses, `${id}.json`));
			assert.deepEqual([answer.id, answer.ok, answer.error?.code], [id, false, "invalid_request"]);
		}
		assert.ok(fs.existsSync(target), "symlink target must be untouched");
	}

	// A same-ID duplicate written while the first copy runs is not claimed (that would
	// replace the running file and run it twice); it is answered by replay afterwards.
	{
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { paths, queue, calls } = setup("duplicate", async (fileId) => {
			await gate;
			return { id: fileId, ok: true, result: { ran: calls.length } };
		});
		const id = randomUUID();
		const fileName = `${id}.json`;
		writeRequest(paths.requests, id);
		const first = processRequestFile(queue, fileName);
		writeRequest(paths.requests, id);
		// Not awaited before the check: a regression would block on the same gate.
		const duplicateScan = scanRequests(queue);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const callsWhileRunning = calls.length;
		const waiting = fs.readdirSync(paths.requests);
		release();
		await Promise.all([first, duplicateScan]);
		assert.equal(callsWhileRunning, 1, "duplicate must not run while the first copy runs");
		assert.deepEqual(waiting, [fileName], "duplicate must wait in requests/");
		fs.unlinkSync(path.join(paths.responses, fileName)); // The first client read its answer.
		await scanRequests(queue);
		assert.equal(calls.length, 1, "duplicate must never run");
		assert.deepEqual(readJson(path.join(paths.responses, fileName)), { id, ok: true, result: { ran: 1 } });
		assert.deepEqual(fs.readdirSync(paths.requests), []);
	}

	// A stale listing (the request file is already gone) writes nothing, even with a cached answer.
	{
		const { paths, queue, calls } = setup("stale");
		const health = new BridgeHealth(paths.health, () => true);
		const id = randomUUID();
		fs.writeFileSync(path.join(paths.processed, `${id}.json`), JSON.stringify({ id, ok: true, result: {} }), { mode: 0o600 });
		await processRequestFile({ ...queue, health }, `${id}.json`);
		assert.equal(calls.length, 0);
		assert.deepEqual(fs.readdirSync(paths.responses), []);
		assert.deepEqual(health.entries, []);
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

	// Clean stop: clearing cachePaths leaves only presence.json in the namespace.
	{
		const { paths } = setup("clean-stop");
		const namespace = path.dirname(paths.requests);
		for (const dir of [paths.requests, paths.inflight, paths.withdrawn, paths.responses, paths.processed]) fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), "{}", { mode: 0o600 });
		fs.writeFileSync(paths.health, "{}\n", { mode: 0o600 });
		fs.writeFileSync(path.join(namespace, "presence.json"), "{}", { mode: 0o600 });
		assert.deepEqual(new Set(cachePaths(paths)), new Set(Object.values(paths)), "cachePaths must cover every queue path");
		clearRequestCache(cachePaths(paths));
		assert.deepEqual(fs.readdirSync(namespace), ["presence.json"]);
	}

	// Health: whitelisted fields only, ring capped, counters, survives a restart.
	{
		const { paths, queue } = setup("health");
		const health = new BridgeHealth(paths.health, () => true, 1_000);
		const healthQueue = { ...queue, health };
		// Recorded per answered request, replay and size rejection.
		const id = randomUUID();
		writeRequest(paths.requests, id);
		await scanRequests(healthQueue);
		writeRequest(paths.requests, id);
		await scanRequests(healthQueue);
		const big = randomUUID();
		writeRequest(paths.requests, big, "x".repeat(MAX_REQUEST_BYTES + 1));
		await scanRequests(healthQueue);
		assert.deepEqual(health.entries.map(({ type, outcome, replay }) => ({ type, outcome, replay })), [
			{ type: "recall", outcome: "ok", replay: false },
			{ type: "unknown", outcome: "replay", replay: true },
			{ type: "unknown", outcome: "payload_too_large", replay: false },
		]);
		assert.equal(health.entries[2].reqBytes, MAX_REQUEST_BYTES + 1);
		// Free text never lands in the ring.
		health.record({ type: "../secret plan text", outcome: "Pi said: hello", ms: 5 });
		const keys = ["ts", "type", "outcome", "ms", "reqBytes", "resBytes", "replay", "retry"];
		for (const entry of health.entries) assert.deepEqual(Object.keys(entry), keys);
		assert.deepEqual({ type: health.entries[3].type, outcome: health.entries[3].outcome }, { type: "unknown", outcome: "unknown" });
		// A client re-send is flagged only by an envelope `retry` of literal true.
		for (const retry of [true, "yes", 1]) {
			const retryId = randomUUID();
			writeRequest(paths.requests, retryId, JSON.stringify({ id: retryId, type: "recall", payload: {}, ts: 1, retry }));
			await scanRequests(healthQueue);
		}
		assert.deepEqual(health.entries.slice(-3).map(({ type, retry }) => ({ type, retry })), [
			{ type: "recall", retry: true },
			{ type: "recall", retry: false },
			{ type: "recall", retry: false },
		]);
		assert.ok(health.entries.slice(0, -3).every((entry) => entry.retry === false), "first sends, replays and rejections are never retries");
		const fileText = fs.readFileSync(paths.health, "utf8");
		assert.ok(!fileText.includes("secret") && !fileText.includes(id), "health file must hold no payload text or ids");
		assert.equal(fs.statSync(paths.health).mode & 0o777, 0o600);
		// Slow completions and restart conversions are counted.
		health.record({ type: "save_plan", outcome: "ok", ms: 1_500 });
		assert.equal(health.counters.slowCompletions, 1);
		writeRequest(paths.inflight, randomUUID());
		assert.equal(recoverInflight(healthQueue), 1);
		assert.equal(health.counters.restartConversions, 1);
		// Ring capped at HEALTH_RING_SIZE, file included; a restart reloads it and drops bad lines.
		for (let index = 0; index < HEALTH_RING_SIZE + 10; index++) health.record({ type: "recall", outcome: "ok", ms: index % 100 });
		assert.equal(health.entries.length, HEALTH_RING_SIZE);
		// The last line has the pre-`retry` key shape: an upgrade drops it once (accepted).
		fs.appendFileSync(paths.health, "not json\n{\"ts\":1,\"type\":\"recall\",\"extra\":true}\n{\"ts\":1,\"type\":\"recall\",\"outcome\":\"ok\",\"ms\":1,\"reqBytes\":0,\"resBytes\":0,\"replay\":false}\n");
		const reloaded = new BridgeHealth(paths.health, () => true);
		assert.deepEqual(reloaded.entries, health.entries);
		// Summary: nearest-rank p50/p95 per type, plus counters.
		const seeded = new BridgeHealth(path.join(paths.processed, "seeded.jsonl"), () => false);
		for (let ms = 10; ms <= 100; ms += 10) seeded.record({ type: "recall", outcome: "ok", ms, resBytes: 2_048 });
		seeded.record({ type: "tick_plan_task", outcome: OUTCOME_UNKNOWN, ms: 7 });
		seeded.record({ type: "read_plan_tasks", outcome: "ok", ms: 3, retry: true });
		seeded.counters.withdrawn = 2;
		const summary = seeded.summary();
		assert.match(summary, /recall\s+n=10\s+p50 50ms\s+p95 100ms\s+res p95 2\.0KB\s+errors 0/);
		assert.match(summary, /tick_plan_task\s+n=1\s+p50 7ms\s+p95 7ms\s+res p95 0\.0KB\s+errors 1/);
		assert.match(summary, /not_delivered \(withdrawn\) 2 · outcome_unknown 1 · replays 0 · restart conversions 0 · slow completions 0 · retries 1$/);
		assert.equal(fs.existsSync(path.join(paths.processed, "seeded.jsonl")), false, "no write when the namespace is not private");
		assert.equal(new BridgeHealth(path.join(paths.processed, "none.jsonl"), () => true).summary(), "Bridge health: no requests recorded yet.");
	}

	// The poll counts withdrawn requests before clearing them.
	{
		const { paths, queue } = setup("health-poll");
		const health = new BridgeHealth(paths.health, () => true);
		fs.writeFileSync(path.join(paths.withdrawn, `${randomUUID()}.json`), "{}", { mode: 0o600 });
		const stop = startPolling({ ...queue, health }, () => {}, { intervalMs: 20 });
		const deadline = Date.now() + 2_000;
		while (health.counters.withdrawn === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		stop();
		assert.equal(health.counters.withdrawn, 1);
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
