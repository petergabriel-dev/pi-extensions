import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ABANDONED_NAMESPACE_MS, clearRequestCache, failureStreakReporter, isAbandonedNamespace, LIVE_TTL_MS, restorablePeers, stoppedHeartbeatAt, type PresencePeer } from "../presence.js";
import { findProjectRoot } from "../project-root.js";

const now = Date.parse("2025-01-02T03:04:05.000Z");
const stoppedAt = Date.parse(stoppedHeartbeatAt(now));
const stoppedAge = now - stoppedAt;
assert.ok(stoppedAge > LIVE_TTL_MS);
assert.ok(stoppedAge < 10 * 60_000);
assert.equal(stoppedAge <= LIVE_TTL_MS, false);

const previous: PresencePeer[] = [
	{ harness: "claude", id: "shared" },
	{ harness: "cursor", id: "keep-first" },
	{ harness: "claude", id: "keep-same-id" },
	{ harness: "cursor", id: "shared" },
];
const otherLive = [
	{ peers: [{ harness: "claude", id: "shared" }] },
	{ peers: [{ harness: "cursor", id: "keep-first" }] },
];
assert.deepEqual(restorablePeers(previous, otherLive), [
	{ harness: "claude", id: "keep-same-id" },
	{ harness: "cursor", id: "shared" },
]);
assert.deepEqual(restorablePeers([], otherLive), []);
assert.deepEqual(
	restorablePeers([{ harness: "claude", id: "same-id" }], [{ peers: [{ harness: "cursor", id: "same-id" }] }]),
	[{ harness: "claude", id: "same-id" }],
);

const namespace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-presence-"));
try {
	const cacheDirs = ["requests", "responses", "processed"].map((dir) => path.join(namespace, dir));
	for (const dir of cacheDirs) {
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "entry.json"), "cached");
	}
	const presencePath = path.join(namespace, "presence.json");
	const presenceBytes = Buffer.from('{"schemaVersion":2}\n');
	fs.writeFileSync(presencePath, presenceBytes);

	clearRequestCache(cacheDirs);
	assert.deepEqual(cacheDirs.map(fs.existsSync), [false, false, false]);
	assert.equal(fs.existsSync(presencePath), true);
	assert.deepEqual(fs.readFileSync(presencePath), presenceBytes);
	assert.doesNotThrow(() => clearRequestCache([path.join(namespace, "missing")]));
} finally {
	fs.rmSync(namespace, { recursive: true, force: true });
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-home-"));
const previousHome = process.env.HOME;
try {
	fs.mkdirSync(path.join(fakeHome, ".pi"), { recursive: true });
	process.env.HOME = fakeHome;
	assert.equal(findProjectRoot(path.join(fakeHome, "od-ws")), null);
	const project = path.join(fakeHome, "proj");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	assert.equal(findProjectRoot(project), fs.realpathSync(project));
	assert.equal(findProjectRoot(path.join(project, "nested", "dir")), fs.realpathSync(project));
} finally {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	fs.rmSync(fakeHome, { recursive: true, force: true });
}

// A namespace with no readable presence is abandoned only after its directory has
// been unchanged for over a minute; live owners refresh it every heartbeat.
assert.equal(ABANDONED_NAMESPACE_MS, 60_000);
assert.equal(isAbandonedNamespace(false, now - ABANDONED_NAMESPACE_MS - 1, now), true, "old namespace without presence is abandoned");
assert.equal(isAbandonedNamespace(false, now - ABANDONED_NAMESPACE_MS, now), false, "exactly the threshold is not abandoned");
assert.equal(isAbandonedNamespace(false, now - 2_000, now), false, "a fresh namespace is still initializing");
assert.equal(isAbandonedNamespace(true, now - 10 * ABANDONED_NAMESPACE_MS, now), false, "readable presence is never abandoned");
assert.equal(isAbandonedNamespace(false, now + 30_000, now), false, "a future mtime is not abandoned");
assert.equal(isAbandonedNamespace(false, Number.NaN, now), false, "an unknown mtime is not abandoned");

// Heartbeat failures warn once per streak, and again after a success.
const reported: unknown[] = [];
const streak = failureStreakReporter((error) => reported.push(error));
streak.failed(new Error("ENOSPC 1"));
streak.failed(new Error("ENOSPC 2"));
streak.failed(new Error("ENOSPC 3"));
assert.equal(reported.length, 1, "a failure streak warns once");
streak.succeeded();
streak.succeeded();
streak.failed(new Error("EACCES"));
assert.equal(reported.length, 2, "a new streak after a success warns again");
assert.equal((reported[1] as Error).message, "EACCES");

console.log("claude bridge presence tests passed");
