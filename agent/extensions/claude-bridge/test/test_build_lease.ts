import assert from "node:assert/strict";

import {
	acquireBuildLease,
	buildLeaseHolderLabel,
	releaseBuildLeaseOnRecall,
	releaseBuildLeaseOnWorkflowChange,
	type BuildLease,
} from "../build-lease.js";
import type { PeerIdentity } from "../mailbox.js";

const claude: PeerIdentity = { harness: "claude", id: "claude-session" };
const cursor: PeerIdentity = { harness: "cursor", id: "cursor-session" };
const opencode: PeerIdentity = { harness: "opencode", id: "opencode-session" };
const workflow = { mode: "plan", planId: "plan-1", progress: { done: 0, total: 2 } };
const grantedAt = 1234;

function expectRefusal(result: ReturnType<typeof acquireBuildLease>, code: string): asserts result is Extract<typeof result, { ok: false }> {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("Expected lease refusal");
	assert.equal(result.code, code);
}

const missingPlan = acquireBuildLease(null, claude, { mode: "plan" }, grantedAt);
expectRefusal(missingPlan, "build_lease_no_plan");
assert.match(missingPlan.message, /No active saved plan/);

const piBuilding = acquireBuildLease(null, claude, { ...workflow, mode: "build" }, grantedAt);
expectRefusal(piBuilding, "build_lease_pi_building");
assert.match(piBuilding.message, /Pi is in Build mode/);

const missingPeer = acquireBuildLease(null, undefined, workflow, grantedAt);
expectRefusal(missingPeer, "build_lease_peer_kind");
const piPeer = acquireBuildLease(null, { harness: "pi", id: "pi-session" }, workflow, grantedAt);
expectRefusal(piPeer, "build_lease_peer_kind");
const invalidPeer = acquireBuildLease(null, { harness: "claude", id: "../bad" }, workflow, grantedAt);
expectRefusal(invalidPeer, "build_lease_peer_kind");

const acquired = acquireBuildLease(null, claude, workflow, grantedAt);
assert.deepEqual(acquired, {
	ok: true,
	lease: { harness: "claude", id: claude.id, planId: workflow.planId, grantedAt },
	granted: true,
});
if (!acquired.ok) throw new Error("Expected lease grant");
const current: BuildLease = acquired.lease;
assert.equal(buildLeaseHolderLabel(current), "claude:claude-session");
assert.equal(buildLeaseHolderLabel(null), null);

const repeated = acquireBuildLease(current, claude, workflow, grantedAt + 100);
assert.deepEqual(repeated, { ok: true, lease: current, granted: false });

const held = acquireBuildLease(current, cursor, workflow, grantedAt + 100);
expectRefusal(held, "build_lease_held");
assert.match(held.message, /claude:claude-session/);
assert.match(held.message, /\/build-lease release/);

const sameHolderNewPlan = acquireBuildLease(current, claude, { ...workflow, planId: "plan-2" }, grantedAt + 100);
assert.deepEqual(sameHolderNewPlan, {
	ok: true,
	lease: { harness: "claude", id: claude.id, planId: "plan-2", grantedAt: grantedAt + 100 },
	granted: true,
});
assert.deepEqual(acquireBuildLease(null, opencode, workflow, grantedAt), {
	ok: true,
	lease: { harness: "opencode", id: opencode.id, planId: workflow.planId, grantedAt },
	granted: true,
});

for (const mode of ["discuss", "plan"]) {
	assert.equal(releaseBuildLeaseOnRecall(current, claude, mode), null);
	assert.equal(releaseBuildLeaseOnRecall(current, cursor, mode), current);
}
assert.equal(releaseBuildLeaseOnRecall(current, claude, "build"), current);
assert.equal(releaseBuildLeaseOnRecall(null, claude, "discuss"), null);

assert.equal(releaseBuildLeaseOnWorkflowChange(current, { mode: "plan" }), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(current, { mode: "plan", planId: "plan-2" }), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(current, { mode: "plan", planId: "plan-1", progress: { done: 2, total: 2 } }), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(current, { mode: "build", planId: "plan-1" }), null);
assert.equal(releaseBuildLeaseOnWorkflowChange(current, workflow), current);
assert.equal(releaseBuildLeaseOnWorkflowChange(null, workflow), null);

console.log("claude bridge build lease tests passed");
