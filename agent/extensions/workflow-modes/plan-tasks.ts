import { createHash } from "node:crypto";

export const MAX_PLAN_TASKS = 1000;

export interface PlanTaskMetadata {
	given?: string;
	when?: string;
	then?: string;
	nfrs?: string;
	verificationGate?: string;
	checkpoint?: string;
}

export interface PlanTask {
	id: string;
	title: string;
	metadata: PlanTaskMetadata;
}

const SECTION_4_HEADING = /^##\s+Section\s+4(?:\s*[—-].*)?\s*$/i;
const SECTION_HEADING = /^##\s+/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CHECKBOX = /^-\s+\[([ xX])\](?:\s+(.+?))?\s*$/;
const METADATA = /^\s+-\s+\*\*(Given|When|Then|NFRs|Verification Gate|Checkpoint):?\*\*\s*(.*)$/i;

export function parsePlanTasks(planText: string): PlanTask[] {
	if (typeof planText !== "string" || planText.length === 0) return [];

	const lines = planText.replace(/\r\n?/g, "\n").split("\n");
	const tasks: PlanTask[] = [];
	const occurrences = new Map<string, number>();
	let inSection4 = false;
	let fence: "`" | "~" | undefined;
	let current: PlanTask | undefined;

	for (const line of lines) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as "`" | "~";
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;

		if (SECTION_HEADING.test(line)) {
			if (SECTION_4_HEADING.test(line)) {
				inSection4 = true;
				current = undefined;
				continue;
			}
			if (inSection4) break;
			continue;
		}
		if (!inSection4) continue;

		const checkbox = CHECKBOX.exec(line);
		if (checkbox) {
			current = undefined;
			if (checkbox[1] !== " " || !checkbox[2] || tasks.length >= MAX_PLAN_TASKS) continue;
			const title = checkbox[2].trim();
			const normalized = title.replace(/\s+/g, " ");
			const occurrence = occurrences.get(normalized) ?? 0;
			occurrences.set(normalized, occurrence + 1);
			current = { id: stableTaskId(normalized, occurrence), title, metadata: {} };
			tasks.push(current);
			continue;
		}

		if (current) attachMetadata(current.metadata, line);
	}

	return tasks;
}

function stableTaskId(title: string, occurrence: number): string {
	const digest = createHash("sha256").update(`${title}\u0000${occurrence}`).digest("hex").slice(0, 16);
	return `task-${digest}`;
}

function attachMetadata(metadata: PlanTaskMetadata, line: string): void {
	const match = METADATA.exec(line);
	if (!match) return;
	const key = metadataKey(match[1]);
	if (key === "given" || key === "when" || key === "then") {
		const parts = splitGivenWhenThen(match[1], match[2]);
		if (parts.given) metadata.given = parts.given;
		if (parts.when) metadata.when = parts.when;
		if (parts.then) metadata.then = parts.then;
		return;
	}
	const value = match[2].trim();
	if (value) metadata[key] = value;
}

function splitGivenWhenThen(label: string, value: string): PlanTaskMetadata {
	const normalized = label.toLowerCase();
	if (normalized === "given") {
		const match = /^(.*?)\s+\*\*When\*\*\s*(.*?)\s+\*\*Then\*\*\s*(.*)$/i.exec(value);
		if (match) return { given: match[1].trim(), when: match[2].trim(), then: match[3].trim() };
		return { given: value.trim() };
	}
	if (normalized === "when") {
		const match = /^(.*?)\s+\*\*Then\*\*\s*(.*)$/i.exec(value);
		if (match) return { when: match[1].trim(), then: match[2].trim() };
		return { when: value.trim() };
	}
	return { then: value.trim() };
}

function metadataKey(label: string): keyof PlanTaskMetadata {
	const normalized = label.toLowerCase();
	if (normalized === "nfrs") return "nfrs";
	if (normalized === "verification gate") return "verificationGate";
	return normalized as "given" | "when" | "then" | "checkpoint";
}
