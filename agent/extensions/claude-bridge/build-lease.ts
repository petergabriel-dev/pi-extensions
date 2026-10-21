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
	expiresAt: number;
}

export interface BuildLeaseRequest {
	peer: BuildLeasePeer;
	planId: string;
	requestedAt: number;
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

export interface BuildLeaseRefusal {
	ok: false;
	code: BuildLeaseErrorCode;
	message: string;
}

export type RequestBuildLeaseResult =
	| { ok: true; status: "held"; lease: BuildLease }
	| { ok: true; status: "pending"; entry: BuildLeaseRequest; isNew: boolean }
	| BuildLeaseRefusal;

export type ApproveBuildLeaseResult =
	| { ok: true; lease: BuildLease }
	| BuildLeaseRefusal;

export const BUILD_LEASE_TTL_MS = 4 * 60 * 60 * 1000;

const LEASE_HARNESSES = new Set<BuildLeaseHarness>(["claude", "cursor", "opencode"]);

function isLeasePeer(peer: BuildLeasePeer | null | undefined): peer is BuildLeasePeer & { harness: BuildLeaseHarness } {
	return !!peer && LEASE_HARNESSES.has(peer.harness as BuildLeaseHarness) && isSafeId(peer.id);
}

function refusal(code: BuildLeaseErrorCode, message: string): BuildLeaseRefusal {
	return { ok: false, code, message };
}

function peerKindRefusal(): BuildLeaseRefusal {
	return refusal(
		"build_lease_peer_kind",
		"A paired Claude, Cursor, or OpenCode peer is required; Pi cannot hold a build lease.",
	);
}

function noPlanRefusal(message = "No active saved plan; save a plan in Pi before starting /build."): BuildLeaseRefusal {
	return refusal("build_lease_no_plan", message);
}

function piBuildingRefusal(): BuildLeaseRefusal {
	return refusal(
		"build_lease_pi_building",
		"Pi is in Build mode; switch Pi to another mode before using the harness lease.",
	);
}

function heldRefusal(lease: BuildLease): BuildLeaseRefusal {
	return refusal(
		"build_lease_held",
		`Build lease held by ${buildLeaseHolderLabel(lease)}; ask that holder to run /build-lease release.`,
	);
}

export function buildLeaseHolderLabel(lease: BuildLease | null | undefined): string | null {
	return lease ? `${lease.harness}:${lease.id}` : null;
}

export function isBuildLeaseActive(lease: BuildLease | null | undefined, now: number): lease is BuildLease {
	if (!lease) return false;
	if (!Number.isFinite(lease.grantedAt) || !Number.isFinite(lease.expiresAt)) return false;
	return lease.expiresAt > lease.grantedAt && now < lease.expiresAt;
}

function holdsActiveLease(
	lease: BuildLease | null,
	peer: BuildLeasePeer,
	planId: string,
	now: number,
): boolean {
	if (!lease || !isBuildLeaseActive(lease, now)) return false;
	return lease.harness === peer.harness
		&& lease.id === peer.id
		&& lease.planId === planId;
}

export function requestBuildLease(
	current: BuildLease | null,
	pending: BuildLeaseRequest | null | undefined,
	peer: BuildLeasePeer | null | undefined,
	workflow: BuildLeaseWorkflowState,
	now: number,
): RequestBuildLeaseResult {
	if (!isLeasePeer(peer)) return peerKindRefusal();
	if (typeof workflow.planId !== "string" || workflow.planId.length === 0) return noPlanRefusal();
	if (workflow.mode === "build") return piBuildingRefusal();

	if (isBuildLeaseActive(current, now)) {
		if (holdsActiveLease(current, peer, workflow.planId, now)) {
			return { ok: true, status: "held", lease: current };
		}
		if (current.harness !== peer.harness || current.id !== peer.id) return heldRefusal(current);
	}

	const isRepeat = !!pending
		&& pending.peer.harness === peer.harness
		&& pending.peer.id === peer.id
		&& pending.planId === workflow.planId;
	const entry: BuildLeaseRequest = {
		peer: { harness: peer.harness, id: peer.id },
		planId: workflow.planId,
		requestedAt: now,
	};
	return { ok: true, status: "pending", entry, isNew: !isRepeat };
}

export function approveBuildLease(
	current: BuildLease | null,
	entry: BuildLeaseRequest,
	workflow: BuildLeaseWorkflowState,
	isPaired: boolean,
	now: number,
): ApproveBuildLeaseResult {
	if (!isLeasePeer(entry.peer)) return peerKindRefusal();
	if (!isPaired) {
		return refusal(
			"build_lease_peer_kind",
			"The requesting peer is no longer paired; ask it to pair again and rerun /pi-build.",
		);
	}
	if (typeof workflow.planId !== "string" || workflow.planId.length === 0) return noPlanRefusal();
	if (workflow.planId !== entry.planId) {
		return noPlanRefusal("The active plan changed after the request; ask the peer to rerun /pi-build.");
	}
	if (workflow.mode === "build") return piBuildingRefusal();

	if (isBuildLeaseActive(current, now)) {
		if (holdsActiveLease(current, entry.peer, workflow.planId, now)) {
			return { ok: true, lease: current };
		}
		if (current.harness !== entry.peer.harness || current.id !== entry.peer.id) return heldRefusal(current);
	}

	return {
		ok: true,
		lease: {
			harness: entry.peer.harness,
			id: entry.peer.id,
			planId: workflow.planId,
			grantedAt: now,
			expiresAt: now + BUILD_LEASE_TTL_MS,
		},
	};
}

export function pruneBuildLeaseRequests(
	entries: ReadonlyMap<string, BuildLeaseRequest>,
	workflow: BuildLeaseWorkflowState,
	isPaired: (peer: BuildLeasePeer) => boolean,
): Map<string, BuildLeaseRequest> {
	const kept = new Map<string, BuildLeaseRequest>();
	if (workflow.mode === "build") return kept;
	const planId = workflow.planId;
	if (typeof planId !== "string" || planId.length === 0) return kept;

	for (const [peerKey, entry] of entries) {
		if (entry.planId !== planId) continue;
		if (!isLeasePeer(entry.peer)) continue;
		if (!isPaired(entry.peer)) continue;
		kept.set(peerKey, entry);
	}
	return kept;
}

export function canTickPlanTask(
	lease: BuildLease | null,
	peer: BuildLeasePeer | null | undefined,
	now: number,
): boolean {
	if (!lease || !isLeasePeer(peer)) return false;
	return isBuildLeaseActive(lease, now)
		&& lease.harness === peer.harness
		&& lease.id === peer.id;
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
	now: number,
): BuildLease | null {
	if (!lease || !isBuildLeaseActive(lease, now)) return null;
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
