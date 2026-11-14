// Pure validation for review bridge requests. The reviewer identity always comes from
// the host-stamped request peer, never from the payload.

export const EVIDENCE_SECTIONS = ["summary", "files", "hunks", "commands", "subagents", "warnings"] as const;
export type EvidenceSection = typeof EVIDENCE_SECTIONS[number];

export interface ReadTaskEvidencePayload {
	bundleId: string;
	section: EvidenceSection;
	page: number;
}

const BUNDLE_ID = /^[0-9a-f]{64}$/;
const MAX_PAGE = 10_000;

export function normalizeReadTaskEvidencePayload(payload: Record<string, unknown>): ReadTaskEvidencePayload {
	const extra = Object.keys(payload).filter((key) => !["bundleId", "section", "page"].includes(key));
	if (extra.length > 0) throw new Error("read_task_evidence accepts only bundleId, section, and page.");
	if (typeof payload.bundleId !== "string" || !BUNDLE_ID.test(payload.bundleId)) throw new Error("read_task_evidence bundleId must be a 64-character hexadecimal id.");
	const section = payload.section === undefined ? "summary" : payload.section;
	if (typeof section !== "string" || !(EVIDENCE_SECTIONS as readonly string[]).includes(section)) throw new Error(`read_task_evidence section must be one of: ${EVIDENCE_SECTIONS.join(", ")}.`);
	const page = payload.page === undefined ? 0 : payload.page;
	if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw new Error(`read_task_evidence page must be an integer from 0 to ${MAX_PAGE}.`);
	return { bundleId: payload.bundleId, section: section as EvidenceSection, page };
}

export function reviewerIdentity(peer: { harness: string; id: string } | undefined): string {
	if (!peer) throw new Error("review requests require a host-stamped peer identity.");
	return `${peer.harness}:${peer.id}`;
}

const FINDING_KEYS = new Set(["planId", "taskId", "commit", "file", "line", "severity", "text", "fix", "repro", "evidenceRefs"]);
const MAX_FINDINGS = 20;
const MAX_SUBMIT_BYTES = 128 * 1024;

// Shape and size only; Pi's workflow owner validates content, plan tasks, and references.
export function normalizeSubmitFindingsPayload(payload: Record<string, unknown>): { findings: Array<Record<string, unknown>> } {
	if (Object.keys(payload).some((key) => key !== "findings")) throw new Error("submit_review_findings accepts only findings.");
	const findings = payload.findings;
	if (!Array.isArray(findings) || findings.length === 0 || findings.length > MAX_FINDINGS) throw new Error(`submit_review_findings requires 1-${MAX_FINDINGS} findings.`);
	for (const [index, finding] of findings.entries()) {
		if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error(`finding ${index + 1} must be an object.`);
		const extra = Object.keys(finding).filter((key) => !FINDING_KEYS.has(key));
		if (extra.length > 0) throw new Error(`finding ${index + 1} has unsupported field(s): ${extra.slice(0, 5).join(", ")}.`);
	}
	if (Buffer.byteLength(JSON.stringify(findings), "utf8") > MAX_SUBMIT_BYTES) throw new Error(`submit_review_findings payload exceeds ${MAX_SUBMIT_BYTES} bytes.`);
	return { findings: findings as Array<Record<string, unknown>> };
}

export function normalizeResolveFindingPayload(payload: Record<string, unknown>): { id: string; commit: string } {
	if (Object.keys(payload).some((key) => key !== "id" && key !== "commit")) throw new Error("resolve_review_finding accepts only id and commit.");
	if (typeof payload.id !== "string" || !/^F[1-9][0-9]{0,8}$/.test(payload.id)) throw new Error("resolve_review_finding id must be a finding id such as F3.");
	if (typeof payload.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(payload.commit)) throw new Error("resolve_review_finding commit must be a 7-64 character hexadecimal SHA.");
	return { id: payload.id, commit: payload.commit };
}
