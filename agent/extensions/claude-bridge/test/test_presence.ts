import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearRequestCache, LIVE_TTL_MS, restorablePeers, stoppedHeartbeatAt, type PresencePeer } from "../presence.js";

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

console.log("claude bridge presence tests passed");
