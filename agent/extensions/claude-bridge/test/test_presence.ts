import assert from "node:assert/strict";
import { LIVE_TTL_MS, restorablePeers, stoppedHeartbeatAt, type PresencePeer } from "../presence.js";

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

console.log("claude bridge presence tests passed");
