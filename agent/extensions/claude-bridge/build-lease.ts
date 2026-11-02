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

export interface WriterClaim {
	piSessionId: string;
	kind: "build" | "lease";
	holder: string | null;
}

export interface WriterClaimSession {
	id: string;
	presence: { mode: string | null; buildLease?: BuildLease | null };
}

// Mirrors parseBuildLease in agent/claude-bridge-client/pi-bridge-mcp.js.
export function parseBuildLease(value: unknown): BuildLease | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const peer = { harness: record.harness as HarnessKind, id: record.id as string };
	if (!isLeasePeer(peer)) return null;
	if (typeof record.planId !== "string" || record.planId.trim().length === 0) return null;
	const { grantedAt, expiresAt } = record;
	if (typeof grantedAt !== "number" || typeof expiresAt !== "number") return null;
	if (!Number.isFinite(grantedAt) || !Number.isFinite(expiresAt) || expiresAt <= grantedAt) return null;
	return { harness: peer.harness, id: peer.id, planId: record.planId, grantedAt, expiresAt };
}

// Project-wide single writer; mirrors hasOtherWriterClaim in
// agent/claude-bridge-client/pi-bridge-mcp.js. Callers pass only live
// (fresh-presence) sessions. Conflicting claims deny every claimant.
export function otherWriterClaims(sessions: readonly WriterClaimSession[], selfId: string, now: number): WriterClaim[] {
	const claims: WriterClaim[] = [];
	for (const { id, presence } of sessions) {
		if (id === selfId) continue;
		if (presence.mode === "build") claims.push({ piSessionId: id, kind: "build", holder: null });
		if (isBuildLeaseActive(presence.buildLease, now)) {
			claims.push({ piSessionId: id, kind: "lease", holder: buildLeaseHolderLabel(presence.buildLease) });
		}
	}
	return claims;
}

export function describeWriterClaims(claims: readonly WriterClaim[]): string {
	return claims
		.map((claim) => `Pi session ${claim.piSessionId.slice(0, 8)} (${claim.kind === "build" ? "Build mode" : `lease ${claim.holder}`})`)
		.join(", ");
}

// Blocker phrases carry their own remediation, so bridge refusals and
// workflow-modes block reasons show the same text and a self-stale session is
// never told to release another session.
export const WRITER_RELEASE_HINT = "release it in that Pi session with /build-lease release or by leaving Build";
export const SELF_PRESENCE_STALE_BLOCKER = "this Pi session's stale bridge presence; fix .pi/memory/bridge permissions (0700 directories, 0600 files) or restart this Pi session";

export function describeWriterBlocker(claims: readonly WriterClaim[]): string {
	return `${describeWriterClaims(claims)}; ${WRITER_RELEASE_HINT}`;
}

export function ownLeaseBlocker(lease: BuildLease): string {
	return `${buildLeaseHolderLabel(lease)} (this session's harness lease); run /build-lease release here`;
}

export function unverifiedWriterBlocker(reason: string): string {
	return `an unverified writer (${reason}); retry, or restart this Pi session if it persists`;
}

export function projectWriterHeldMessage(blockedBy: string): string {
	return `Project writer blocked by ${blockedBy}.`;
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
