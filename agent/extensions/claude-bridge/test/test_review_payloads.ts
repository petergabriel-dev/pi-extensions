import assert from "node:assert/strict";
import { normalizeReadTaskEvidencePayload, normalizeResolveFindingPayload, normalizeSubmitFindingsPayload, reviewerIdentity } from "../review-payloads.js";

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

// Submit: shape and size only; identity and classification fields are refused.
const finding = { planId: "p", taskId: "t", commit: "abcdef1", severity: "low", text: "x" };
assert.deepEqual(normalizeSubmitFindingsPayload({ findings: [finding] }), { findings: [finding] });
for (const [label, payload, message] of [
	["no findings", {}, /1-20/],
	["empty", { findings: [] }, /1-20/],
	["too many", { findings: Array.from({ length: 21 }, () => finding) }, /1-20/],
	["not object", { findings: ["x"] }, /must be an object/],
	["finding author", { findings: [{ ...finding, by: "claude:forged" }] }, /unsupported field/],
	["finding classification", { findings: [{ ...finding, classification: "verified" }] }, /unsupported field/],
	["payload reviewer", { findings: [finding], reviewer: "claude:forged" }, /accepts only findings/],
	["oversized", { findings: [{ ...finding, text: "x".repeat(140 * 1024) }] }, /exceeds/],
] as const) {
	assert.throws(() => normalizeSubmitFindingsPayload(payload as Record<string, unknown>), message, label);
}

// Resolve: finding id and commit only.
assert.deepEqual(normalizeResolveFindingPayload({ id: "F3", commit: "ABCDEF1" }), { id: "F3", commit: "ABCDEF1" });
for (const [label, payload, message] of [
	["bad id", { id: "3", commit: "abcdef1" }, /finding id/],
	["zero id", { id: "F0", commit: "abcdef1" }, /finding id/],
	["bad commit", { id: "F1", commit: "xyz" }, /hexadecimal/],
	["payload resolver", { id: "F1", commit: "abcdef1", resolver: "codex:x" }, /accepts only id and commit/],
	["payload lease holder", { id: "F1", commit: "abcdef1", leaseHolder: "codex:x" }, /accepts only id and commit/],
] as const) {
	assert.throws(() => normalizeResolveFindingPayload(payload as Record<string, unknown>), message, label);
}

console.log("test_review_payloads passed");
