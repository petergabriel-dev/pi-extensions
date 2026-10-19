import { isSafeId, type HarnessKind } from "./mailbox.js";

export type BuildLeaseHarness = Exclude<HarnessKind, "pi">;

export interface BuildLeasePeer {
	harness: HarnessKind;
	id: string;
}

export interface BuildLease {
	harness: BuildLeaseHarness;
	id: string;
	planId: string;
	grantedAt: number;
}

export interface BuildLeaseWorkflowState {
	mode?: string | null;
	planId?: string;
	progress?: { done: number; total: number };
}

export type BuildLeaseErrorCode =
	| "build_lease_no_plan"
	| "build_lease_pi_building"
	| "build_lease_held"
	| "build_lease_peer_kind";

export type AcquireBuildLeaseResult =
	| { ok: true; lease: BuildLease; granted: boolean }
	| { ok: false; code: BuildLeaseErrorCode; message: string };

const LEASE_HARNESSES = new Set<BuildLeaseHarness>(["claude", "cursor", "opencode"]);

function isLeasePeer(peer: BuildLeasePeer | null | undefined): peer is BuildLeasePeer & { harness: BuildLeaseHarness } {
	return !!peer && LEASE_HARNESSES.has(peer.harness as BuildLeaseHarness) && isSafeId(peer.id);
}

export function buildLeaseHolderLabel(lease: BuildLease | null | undefined): string | null {
	return lease ? `${lease.harness}:${lease.id}` : null;
}

export function acquireBuildLease(
	current: BuildLease | null,
	peer: BuildLeasePeer | null | undefined,
	workflow: BuildLeaseWorkflowState,
	now: number,
): AcquireBuildLeaseResult {
	if (!isLeasePeer(peer)) {
		return {
			ok: false,
			code: "build_lease_peer_kind",
			message: "A paired Claude, Cursor, or OpenCode peer is required; Pi cannot hold a build lease.",
		};
	}
	if (typeof workflow.planId !== "string" || workflow.planId.length === 0) {
		return { ok: false, code: "build_lease_no_plan", message: "No active saved plan; save a plan in Pi before starting /build." };
	}
	if (workflow.mode === "build") {
		return { ok: false, code: "build_lease_pi_building", message: "Pi is in Build mode; switch Pi to another mode before using the harness lease." };
	}

	if (current && current.harness === peer.harness && current.id === peer.id && current.planId === workflow.planId) {
		return { ok: true, lease: current, granted: false };
	}
	if (current && (current.harness !== peer.harness || current.id !== peer.id)) {
		const holder = buildLeaseHolderLabel(current);
		return {
			ok: false,
			code: "build_lease_held",
			message: `Build lease held by ${holder}; ask that holder to run /build-lease release.`,
		};
	}

	return {
		ok: true,
		lease: { harness: peer.harness, id: peer.id, planId: workflow.planId, grantedAt: now },
		granted: true,
	};
}

export function releaseBuildLeaseOnRecall(
	lease: BuildLease | null,
	peer: BuildLeasePeer | null | undefined,
	mode: string,
): BuildLease | null {
	if (!lease || !peer || (mode !== "discuss" && mode !== "plan")) return lease;
	return lease.harness === peer.harness && lease.id === peer.id ? null : lease;
}

export function releaseBuildLeaseOnWorkflowChange(
	lease: BuildLease | null,
	workflow: BuildLeaseWorkflowState,
): BuildLease | null {
	if (!lease) return null;
	if (workflow.mode === "build" || !workflow.planId || workflow.planId !== lease.planId) return null;
	const progress = workflow.progress;
	if (
		progress
		&& Number.isFinite(progress.total)
		&& progress.total > 0
		&& Number.isFinite(progress.done)
		&& progress.done >= progress.total
	) return null;
	return lease;
}
