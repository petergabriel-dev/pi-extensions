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
