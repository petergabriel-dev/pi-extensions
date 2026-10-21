import assert from "node:assert/strict";

import {
	BUILD_LEASE_TTL_MS,
	approveBuildLease,
	buildLeaseHolderLabel,
	canTickPlanTask,
	isBuildLeaseActive,
	pruneBuildLeaseRequests,
	releaseBuildLeaseOnRecall,
	releaseBuildLeaseOnWorkflowChange,
	requestBuildLease,
	type BuildLease,
	type BuildLeasePeer,
	type BuildLeaseRequest,
} from "../build-lease.js";

const claude: BuildLeasePeer = { harness: "claude", id: "claude-session" };
const cursor: BuildLeasePeer = { harness: "cursor", id: "cursor-session" };
const opencode: BuildLeasePeer = { harness: "opencode", id: "opencode-session" };
const workflow = { mode: "plan", planId: "plan-1", progress: { done: 0, total: 2 } };
const now = 1_700_000_000_000;

function expectRefusal<T extends { ok: boolean; code?: string; message?: string }>(
	result: T,
	code: string,
): asserts result is T & { ok: false; code: string; message: string } {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected lease refusal");
	assert.equal(result.code, code);
}

function makeLease(peer: BuildLeasePeer, planId = "plan-1", grantedAt = now): BuildLease {
	return {
		harness: peer.harness as BuildLease["harness"],
		id: peer.id,
		planId,
		grantedAt,
		expiresAt: grantedAt + BUILD_LEASE_TTL_MS,
	};
}

function makeRequest(peer: BuildLeasePeer, planId = "plan-1", requestedAt = now): BuildLeaseRequest {
	return { peer, planId, requestedAt };
}

// TTL is exactly four hours.
assert.equal(BUILD_LEASE_TTL_MS, 4 * 60 * 60 * 1000);

// Request refusals.
expectRefusal(requestBuildLease(null, null, undefined, workflow, now), "build_lease_peer_kind");
expectRefusal(requestBuildLease(null, null, { harness: "pi", id: "pi-session" }, workflow, now), "build_lease_peer_kind");
expectRefusal(requestBuildLease(null, null, { harness: "claude", id: "../bad" }, workflow, now), "build_lease_peer_kind");
expectRefusal(requestBuildLease(null, null, claude, { mode: "plan" }, now), "build_lease_no_plan");
expectRefusal(requestBuildLease(null, null, claude, { ...workflow, mode: "build" }, now), "build_lease_pi_building");

// Request creates a pending entry and never a lease.
const firstRequest = requestBuildLease(null, null, claude, workflow, now);
assert.deepEqual(firstRequest, {
	ok: true,
	status: "pending",
	entry: { peer: { harness: "claude", id: claude.id }, planId: "plan-1", requestedAt: now },
	isNew: true,
});
if (!firstRequest.ok || firstRequest.status !== "pending") throw new Error("Expected pending request");
assert.equal("lease" in firstRequest, false);

// Repeat request refreshes the entry without reporting it as new.
const repeatRequest = requestBuildLease(null, firstRequest.entry, claude, workflow, now + 500);
assert.equal(repeatRequest.ok, true);
if (!repeatRequest.ok || repeatRequest.status !== "pending") throw new Error("Expected pending request");
assert.equal(repeatRequest.isNew, false);
assert.equal(repeatRequest.entry.requestedAt, now + 500);
assert.equal(repeatRequest.entry.planId, "plan-1");

// A changed plan for the same peer is a new pending entry.
const changedPlan = requestBuildLease(null, firstRequest.entry, claude, { ...workflow, planId: "plan-2" }, now + 500);
if (!changedPlan.ok || changedPlan.status !== "pending") throw new Error("Expected pending request");
assert.equal(changedPlan.isNew, true);
assert.equal(changedPlan.entry.planId, "plan-2");

// Active same-plan holder is told it already holds the lease.
const activeLease = makeLease(claude);
const held = requestBuildLease(activeLease, null, claude, workflow, now + 100);
assert.deepEqual(held, { ok: true, status: "held", lease: activeLease });

// Another paired peer cannot supersede an active holder.
const heldByOther = requestBuildLease(activeLease, null, cursor, workflow, now + 100);
expectRefusal(heldByOther, "build_lease_held");
assert.match(heldByOther.message, /claude:claude-session/);

// A same-peer lease for another plan does not block a fresh request.
const samePeerOtherPlan = requestBuildLease(activeLease, null, claude, { ...workflow, planId: "plan-2" }, now + 100);
if (!samePeerOtherPlan.ok || samePeerOtherPlan.status !== "pending") throw new Error("Expected pending request");
assert.equal(samePeerOtherPlan.entry.planId, "plan-2");

// Expiry helpers fail closed.
assert.equal(isBuildLeaseActive(activeLease, now), true);
assert.equal(isBuildLeaseActive(activeLease, activeLease.expiresAt), false);
assert.equal(isBuildLeaseActive(activeLease, activeLease.expiresAt + 1), false);
assert.equal(isBuildLeaseActive(null, now), false);
const legacyLease = { harness: "claude", id: claude.id, planId: "plan-1", grantedAt: now - 1000 } as unknown as BuildLease;
assert.equal(isBuildLeaseActive(legacyLease, now), false);
assert.equal(isBuildLeaseActive({ ...activeLease, expiresAt: activeLease.grantedAt }, now), false);

// Expired and legacy leases are inactive and replaceable.
const expiredLease = makeLease(claude, "plan-1", now - BUILD_LEASE_TTL_MS - 1);
const replaceExpired = requestBuildLease(expiredLease, null, claude, workflow, now);
if (!replaceExpired.ok || replaceExpired.status !== "pending") throw new Error("Expected pending request");
assert.equal(replaceExpired.isNew, true);
const replaceLegacy = requestBuildLease(legacyLease, null, claude, workflow, now);
if (!replaceLegacy.ok || replaceLegacy.status !== "pending") throw new Error("Expected pending request");

// Approve is the only path that yields a lease.
const request = makeRequest(claude);
const approved = approveBuildLease(null, request, workflow, true, now);
assert.deepEqual(approved, {
	ok: true,
	lease: { harness: "claude", id: claude.id, planId: "plan-1", grantedAt: now, expiresAt: now + BUILD_LEASE_TTL_MS },
});
if (!approved.ok) throw new Error("Expected approved lease");
assert.equal(approved.lease.expiresAt - approved.lease.grantedAt, BUILD_LEASE_TTL_MS);
assert.equal(approved.lease.expiresAt, now + 4 * 60 * 60 * 1000);

// Approve re-validates pairing, plan identity, Pi mode, and other holders.
expectRefusal(approveBuildLease(null, request, workflow, false, now), "build_lease_peer_kind");
expectRefusal(approveBuildLease(null, request, { mode: "plan" }, true, now), "build_lease_no_plan");
expectRefusal(approveBuildLease(null, request, { ...workflow, planId: "plan-2" }, true, now), "build_lease_no_plan");
expectRefusal(approveBuildLease(null, request, { ...workflow, mode: "build" }, true, now), "build_lease_pi_building");
expectRefusal(approveBuildLease(activeLease, { ...request, peer: cursor }, workflow, true, now), "build_lease_held");
expectRefusal(approveBuildLease(activeLease, { ...request, peer: { harness: "pi", id: "pi-session" } }, workflow, true, now), "build_lease_peer_kind");

// Re-approving the active holder is idempotent and does not extend the expiry.
const reapproved = approveBuildLease(activeLease, request, workflow, true, now + 1000);
assert.deepEqual(reapproved, { ok: true, lease: activeLease });

// An expired lease is replaced with a fresh TTL.
const replaced = approveBuildLease(expiredLease, request, workflow, true, now);
if (!replaced.ok) throw new Error("Expected approved lease");
assert.equal(replaced.lease.grantedAt, now);
assert.equal(replaced.lease.expiresAt, now + BUILD_LEASE_TTL_MS);
assert.notEqual(replaced.lease, expiredLease);

// Tick is holder-only and fail-closed.
assert.equal(canTickPlanTask(activeLease, claude, now), true);
assert.equal(canTickPlanTask(activeLease, claude, activeLease.expiresAt), false);
assert.equal(canTickPlanTask(activeLease, { harness: "claude", id: "other-session" }, now), false);
assert.equal(canTickPlanTask(activeLease, cursor, now), false);
assert.equal(canTickPlanTask(activeLease, { harness: "pi", id: "pi-session" }, now), false);
assert.equal(canTickPlanTask(null, claude, now), false);
assert.equal(canTickPlanTask(legacyLease, claude, now), false);

// Prune keeps only paired entries for the active plan.
const entries = new Map<string, BuildLeaseRequest>([
	["claude:claude-session", makeRequest(claude)],
	["cursor:cursor-session", makeRequest(cursor)],
	["opencode:opencode-session", makeRequest(opencode, "plan-2")],
]);
const pruned = pruneBuildLeaseRequests(entries, workflow, (peer) => peer.harness !== "cursor");
assert.deepEqual([...pruned.keys()], ["claude:claude-session"]);
assert.equal(pruneBuildLeaseRequests(entries, { ...workflow, mode: "build" }, () => true).size, 0);
assert.equal(pruneBuildLeaseRequests(entries, { mode: "plan" }, () => true).size, 0);
assert.equal(pruneBuildLeaseRequests(entries, { ...workflow, planId: "plan-2" }, () => true).size, 1);
assert.equal(pruneBuildLeaseRequests(entries, workflow, () => false).size, 0);

// Holder labels.
assert.equal(buildLeaseHolderLabel(activeLease), "claude:claude-session");
assert.equal(buildLeaseHolderLabel(null), null);

// Discuss/Plan recall releases only the holder's lease.
for (const mode of ["discuss", "plan"]) {
	assert.equal(releaseBuildLeaseOnRecall(activeLease, claude, mode), null);
	assert.equal(releaseBuildLeaseOnRecall(activeLease, cursor, mode), activeLease);
}
assert.equal(releaseBuildLeaseOnRecall(activeLease, claude, "build"), activeLease);
assert.equal(releaseBuildLeaseOnRecall(null, claude, "discuss"), null);

// Workflow changes drop expired, old-format, switched, complete, and Build-mode leases.
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, workflow, now), activeLease);
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, workflow, activeLease.expiresAt), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(legacyLease, workflow, now), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, { mode: "plan" }, now), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, { ...workflow, planId: "plan-2" }, now), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, { ...workflow, mode: "build" }, now), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(activeLease, { ...workflow, progress: { done: 2, total: 2 } }, now), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(null, workflow, now), null);

console.log("claude bridge build lease tests passed");
