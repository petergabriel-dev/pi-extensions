import assert from "node:assert/strict";
import { normalizeReadTaskEvidencePayload, reviewerIdentity } from "../review-payloads.js";

console.log("Running test_review_payloads...");

const bundleId = "a".repeat(64);
assert.deepEqual(normalizeReadTaskEvidencePayload({ bundleId }), { bundleId, section: "summary", page: 0 });
assert.deepEqual(normalizeReadTaskEvidencePayload({ bundleId, section: "hunks", page: 3 }), { bundleId, section: "hunks", page: 3 });
for (const [label, payload, message] of [
	["missing id", {}, /bundleId/],
	["short id", { bundleId: "abc" }, /bundleId/],
	["upper id", { bundleId: "A".repeat(64) }, /bundleId/],
	["path id", { bundleId: `../${"a".repeat(61)}` }, /bundleId/],
	["bad section", { bundleId, section: "secrets" }, /section/],
	["negative page", { bundleId, page: -1 }, /page/],
	["fraction page", { bundleId, page: 1.5 }, /page/],
	["huge page", { bundleId, page: 10_001 }, /page/],
	["string page", { bundleId, page: "2" }, /page/],
	["payload reviewer", { bundleId, reviewer: "claude:forged" }, /accepts only/],
] as const) {
	assert.throws(() => normalizeReadTaskEvidencePayload(payload as Record<string, unknown>), message, label);
}

assert.equal(reviewerIdentity({ harness: "cursor", id: "conv-1" }), "cursor:conv-1");
assert.throws(() => reviewerIdentity(undefined), /host-stamped peer/);

console.log("test_review_payloads passed");
