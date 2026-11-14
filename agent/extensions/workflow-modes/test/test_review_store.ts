import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendReviewEvent,
	appendReviewEvents,
	ensurePrivateDir,
	MAX_REVIEW_LINE_BYTES,
	MAX_REVIEW_LOG_BYTES,
	readReviewLog,
	ReviewLogFullError,
	reviewLogPath,
	writeOnce0600,
} from "../review-store.js";

console.log("Running test_review_store...");

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-review-store-"));
const mode = async (target: string) => (await fs.stat(target)).mode & 0o777;
const submit = (sessionId: string, extra: Record<string, unknown> = {}) => appendReviewEvent(agentDir, sessionId, { ev: "finding_submitted", planId: "plan-1", taskId: "task-abc", text: "finding", ...extra });

try {
	// Path safety.
	assert.throws(() => reviewLogPath(agentDir, "../escape"), /path-safe/);
	await assert.rejects(() => appendReviewEvent(agentDir, "a/b", { ev: "review_started", planId: "p", taskId: "t" }), /path-safe/);

	// Missing log reads empty; first append creates 0700 dir and 0600 file.
	assert.deepEqual(await readReviewLog(agentDir, "s1"), { events: [], warnings: [] });
	const first = await submit("s1");
	assert.equal(first.id, "F1");
	assert.equal(typeof first.at, "number");
	const logPath = reviewLogPath(agentDir, "s1");
	assert.equal(await mode(logPath), 0o600);
	assert.equal(await mode(path.dirname(logPath)), 0o700);

	// Concurrent appends serialize: unique sequential ids, one line each, prefix-preserving.
	const before = await fs.readFile(logPath);
	const many = await Promise.all(Array.from({ length: 20 }, (_, index) => submit("s1", { text: `n${index}` })));
	assert.deepEqual(many.map((event) => event.id).sort((a, b) => Number(a!.slice(1)) - Number(b!.slice(1))), Array.from({ length: 20 }, (_, index) => `F${index + 2}`));
	const after = await fs.readFile(logPath);
	assert.ok(after.subarray(0, before.length).equals(before), "appends never rewrite earlier bytes");
	const log = await readReviewLog(agentDir, "s1");
	assert.equal(log.events.length, 21);
	assert.deepEqual(log.warnings, []);
	assert.deepEqual(log.events.map((event) => event.id), Array.from({ length: 21 }, (_, index) => `F${index + 1}`), "file order matches id order");

	// Reference events must name an existing finding; ids and times are store-assigned.
	await appendReviewEvent(agentDir, "s1", { ev: "finding_approved", id: "F3", classification: "suspected" });
	await assert.rejects(() => appendReviewEvent(agentDir, "s1", { ev: "finding_resolved", id: "F99" }), /unknown finding F99/);
	await assert.rejects(() => appendReviewEvent(agentDir, "s1", { ev: "finding_rejected" }), /requires a finding id/);
	await assert.rejects(() => submit("s1", { id: "F500" }), /assigned by the store/);
	await assert.rejects(() => submit("s1", { at: 1 }), /assigned by the store/);
	await assert.rejects(() => appendReviewEvent(agentDir, "s1", { ev: "made_up", planId: "p", taskId: "t" }), /unknown review event type/);
	await assert.rejects(() => appendReviewEvent(agentDir, "s1", { ev: "review_started", planId: "../p", taskId: "t" }), /planId/);
	await assert.rejects(() => appendReviewEvent(agentDir, "s1", { ev: "review_started", planId: "p", taskId: "" }), /taskId/);

	// Oversized line is refused.
	await assert.rejects(() => submit("s1", { text: "x".repeat(MAX_REVIEW_LINE_BYTES) }), /exceeds/);

	// Torn last line: skipped with a warning; the next event lands on its own line.
	await fs.appendFile(logPath, '{"ev":"finding_submitted","pla');
	const afterTorn = await submit("s1");
	assert.equal(afterTorn.id, "F22", "ids continue after a torn line");
	const torn = await readReviewLog(agentDir, "s1");
	assert.equal(torn.warnings.length, 1);
	assert.match(torn.warnings[0], /malformed/);
	assert.equal(torn.events.at(-1)?.id, "F22");
	await fs.appendFile(logPath, '["not", "an", "event"]\n');
	assert.match((await readReviewLog(agentDir, "s1")).warnings.at(-1)!, /not a review event/);

	// Size cap: an append that would pass 1 MiB is refused and writes nothing.
	const capPath = reviewLogPath(agentDir, "s-cap");
	await ensurePrivateDir(path.dirname(capPath));
	await fs.writeFile(capPath, `${" ".repeat(MAX_REVIEW_LOG_BYTES - 50)}\n`, { mode: 0o600 });
	const capBefore = (await fs.stat(capPath)).size;
	await assert.rejects(() => submit("s-cap"), (error) => error instanceof ReviewLogFullError && /review log is full/.test(error.message));
	assert.equal((await fs.stat(capPath)).size, capBefore);

	// Existing log with loose permissions is tightened on append.
	await fs.chmod(logPath, 0o644);
	await submit("s1");
	assert.equal(await mode(logPath), 0o600);

	// Symlinked log is refused for read and append; the target is untouched.
	const target = path.join(agentDir, "target.jsonl");
	await fs.writeFile(target, "keep\n");
	const linkPath = reviewLogPath(agentDir, "s-link");
	await ensurePrivateDir(path.dirname(linkPath));
	await fs.symlink(target, linkPath);
	await assert.rejects(() => readReviewLog(agentDir, "s-link"), /symlink/);
	await assert.rejects(() => submit("s-link"), /symlink/);
	assert.equal(await fs.readFile(target, "utf8"), "keep\n");

	// ID sequence continues from an existing file (fresh process: state comes from the file).
	const seqPath = reviewLogPath(agentDir, "s-seq");
	await ensurePrivateDir(path.dirname(seqPath));
	await fs.writeFile(seqPath, `${JSON.stringify({ ev: "finding_submitted", id: "F7", at: 1, planId: "p", taskId: "t" })}\n`, { mode: 0o600 });
	assert.equal((await submit("s-seq")).id, "F8");

	// Batch append: one write, consecutive ids, all or nothing, serialized with single appends.
	const batch = await appendReviewEvents(agentDir, "s-batch", [
		{ ev: "finding_submitted", planId: "p", taskId: "t", text: "one" },
		{ ev: "finding_submitted", planId: "p", taskId: "t", text: "two" },
		{ ev: "finding_submitted", planId: "p", taskId: "t", text: "three" },
	]);
	assert.deepEqual(batch.map((event) => event.id), ["F1", "F2", "F3"]);
	await assert.rejects(() => appendReviewEvents(agentDir, "s-batch", [
		{ ev: "finding_submitted", planId: "p", taskId: "t", text: "valid" },
		{ ev: "made_up", planId: "p", taskId: "t" },
	]), /unknown review event type/);
	assert.equal((await readReviewLog(agentDir, "s-batch")).events.length, 3, "an invalid event rejects the whole batch");
	const [mixedBatch, single] = await Promise.all([
		appendReviewEvents(agentDir, "s-batch", [{ ev: "finding_submitted", planId: "p", taskId: "t" }, { ev: "finding_submitted", planId: "p", taskId: "t" }]),
		submit("s-batch"),
	]);
	assert.deepEqual([...mixedBatch.map((event) => event.id), single.id], ["F4", "F5", "F6"], "batch ids stay consecutive beside a concurrent single append");
	const batchCapPath = reviewLogPath(agentDir, "s-batch-cap");
	await ensurePrivateDir(path.dirname(batchCapPath));
	const oneLine = JSON.stringify({ ev: "finding_submitted", planId: "p", taskId: "t", text: "x", id: "F1", at: Date.now() }).length + 1;
	await fs.writeFile(batchCapPath, `${" ".repeat(MAX_REVIEW_LOG_BYTES - oneLine * 2 - 1)}\n`, { mode: 0o600 });
	const capSize = (await fs.stat(batchCapPath)).size;
	await assert.rejects(() => appendReviewEvents(agentDir, "s-batch-cap", Array.from({ length: 3 }, () => ({ ev: "finding_submitted", planId: "p", taskId: "t", text: "x" }))), ReviewLogFullError);
	assert.equal((await fs.stat(batchCapPath)).size, capSize, "a batch that would cross the cap writes nothing, even though one event would fit");
	assert.equal((await submit("s-batch-cap", { text: "x" })).id, "F1", "a single event that fits still lands");
	await assert.rejects(() => appendReviewEvents(agentDir, "s-batch", []), /empty/);

	// writeOnce0600: writes once with 0600, never overwrites, refuses symlinks.
	const bundlePath = path.join(agentDir, "once.json");
	assert.equal(await writeOnce0600(bundlePath, "first"), "written");
	assert.equal(await mode(bundlePath), 0o600);
	assert.equal(await writeOnce0600(bundlePath, "second"), "exists");
	assert.equal(await fs.readFile(bundlePath, "utf8"), "first");
	const onceLink = path.join(agentDir, "once-link.json");
	await fs.symlink(path.join(agentDir, "nowhere.json"), onceLink);
	await assert.rejects(() => writeOnce0600(onceLink, "x"), /not a regular file/);
	await assert.rejects(() => fs.access(path.join(agentDir, "nowhere.json")), "symlink target must not be created");

	// ensurePrivateDir: tightens mode, refuses a symlinked directory.
	const loose = path.join(agentDir, "loose");
	await fs.mkdir(loose, { mode: 0o755 });
	await ensurePrivateDir(loose);
	assert.equal(await mode(loose), 0o700);
	const dirLink = path.join(agentDir, "dir-link");
	await fs.symlink(loose, dirLink);
	await assert.rejects(() => ensurePrivateDir(dirLink), /not a private directory/);
} finally {
	await fs.rm(agentDir, { recursive: true, force: true });
}

console.log("test_review_store passed");
