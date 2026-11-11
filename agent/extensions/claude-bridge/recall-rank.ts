// Budgeted, query-ranked recall. Pure and dependency-free: docs are split into sections,
// sections and personal-memory index lines are scored with BM25, and the best matches
// are packed into the ranked budget. Every section keeps its source line range so a
// client can read the full text with its own file Read.

export const DEFAULT_RECALL_BUDGET_BYTES = 32 * 1024;
export const RANKED_FLOOR_BYTES = 8 * 1024;
// An H2 section larger than this is split at its H3 headings.
export const SECTION_SPLIT_BYTES = 4 * 1024;
// Section text is capped; the line range points at the rest.
export const SECTION_TEXT_CAP_BYTES = 4 * 1024;

const HEADING_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;
const STOPWORDS = new Set("a an and are as at be but by can do does for from has have how if in into is it its no not of on or so such that the their then there these they this to was what when where which who why will with you your".split(" "));

export interface RecallDoc {
	path: string;
	text: string;
}

export interface RecallSection {
	path: string;
	heading: string;
	startLine: number;
	endLine: number;
	text: string;
	truncated?: true;
}

export interface RankedRecall {
	docIndex: Array<{ path: string; title: string }>;
	sections: RecallSection[];
	memory: string[];
	meta: {
		bytes: number;
		budget: number;
		budgetExceeded: boolean;
		omittedDocs: number;
		omittedSections: number;
		omittedMemory: number;
	};
}

export interface RankRecallInput {
	query: string;
	docs: readonly RecallDoc[];
	memory: readonly string[];
	budgetBytes: number;
	/** Bytes of the never-cut part (mode prompt, plan template, saved plan). */
	fixedBytes: number;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function capBytes(text: string, cap: number): string {
	if (byteLength(text) <= cap) return text;
	// Cutting mid-character leaves a replacement character; drop it.
	return Buffer.from(text, "utf8").subarray(0, cap).toString("utf8").replace(/�+$/, "");
}

interface RawSection {
	heading: string;
	start: number; // 0-based line index, inclusive
	end: number; // 0-based line index, inclusive
}

/** Title plus sections split at H2 (and at H3 inside an H2 over SECTION_SPLIT_BYTES). */
export function splitSections(doc: RecallDoc): { title: string; sections: RecallSection[] } {
	const lines = doc.text.split("\n");
	let first = 0;
	let title = "";
	if (lines[0]?.trim() === "---") {
		const close = lines.indexOf("---", 1);
		if (close > 0) {
			const titleLine = lines.slice(1, close).find((line) => line.startsWith("title:"));
			if (titleLine) title = titleLine.slice("title:".length).trim();
			first = close + 1;
		}
	}
	const h2: RawSection[] = [];
	const h3ByH2 = new Map<number, Array<{ heading: string; line: number }>>();
	let fence: string | null = null;
	let current: RawSection = { heading: "", start: first, end: lines.length - 1 };
	for (let index = first; index < lines.length; index++) {
		const line = lines[index];
		const fenceMatch = /^\s*(```|~~~)/.exec(line);
		if (fenceMatch) {
			if (fence === null) fence = fenceMatch[1];
			else if (fenceMatch[1] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		if (!title && /^# \S/.test(line)) title = line.slice(2).trim();
		if (/^## \S/.test(line)) {
			current.end = index - 1;
			h2.push(current);
			current = { heading: line.slice(3).trim(), start: index, end: lines.length - 1 };
		} else if (/^### \S/.test(line)) {
			const list = h3ByH2.get(h2.length) ?? [];
			list.push({ heading: line.slice(4).trim(), line: index });
			h3ByH2.set(h2.length, list);
		}
	}
	h2.push(current);
	if (!title) title = doc.path.split("/").pop() ?? doc.path;

	const raw: RawSection[] = [];
	h2.forEach((section, position) => {
		const heading = section.heading || title;
		const text = lines.slice(section.start, section.end + 1).join("\n");
		const h3 = h3ByH2.get(position) ?? [];
		if (byteLength(text) <= SECTION_SPLIT_BYTES || h3.length === 0) {
			raw.push({ ...section, heading });
			return;
		}
		if (h3[0].line > section.start) raw.push({ heading, start: section.start, end: h3[0].line - 1 });
		h3.forEach((sub, index) => {
			raw.push({ heading: `${heading} › ${sub.heading}`, start: sub.line, end: index + 1 < h3.length ? h3[index + 1].line - 1 : section.end });
		});
	});

	const sections: RecallSection[] = [];
	for (const section of raw) {
		// Trailing blank lines are not part of the pointer.
		let end = section.end;
		while (end >= section.start && lines[end].trim() === "") end--;
		if (end < section.start) continue;
		const text = lines.slice(section.start, end + 1).join("\n");
		const capped = capBytes(text, SECTION_TEXT_CAP_BYTES);
		sections.push({
			path: doc.path,
			heading: section.heading,
			startLine: section.start + 1,
			endLine: end + 1,
			text: capped,
			...(capped !== text ? { truncated: true as const } : {}),
		});
	}
	return { title, sections };
}

/** BM25 scores for each document (an array of tokens) against the query terms. */
function bm25(documents: string[][], queryTerms: string[]): number[] {
	const count = documents.length;
	if (count === 0 || queryTerms.length === 0) return documents.map(() => 0);
	const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / count || 1;
	const frequencies = documents.map((tokens) => {
		const map = new Map<string, number>();
		for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
		return map;
	});
	const idf = new Map<string, number>();
	for (const term of queryTerms) {
		const df = frequencies.filter((map) => map.has(term)).length;
		idf.set(term, Math.log(1 + (count - df + 0.5) / (df + 0.5)));
	}
	return frequencies.map((map, index) => {
		const length = documents[index].length;
		let score = 0;
		for (const term of queryTerms) {
			const tf = map.get(term) ?? 0;
			if (tf === 0) continue;
			score += idf.get(term)! * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * length / averageLength));
		}
		return score;
	});
}

export function rankRecall(input: RankRecallInput): RankedRecall {
	const budget = input.budgetBytes;
	const rankedBudget = Math.max(budget - input.fixedBytes, RANKED_FLOOR_BYTES);
	const queryTerms = [...new Set(tokenize(input.query))];

	const split = input.docs.map((doc) => ({ path: doc.path, ...splitSections(doc) }));
	const allSections = split.flatMap((doc, docOrder) => doc.sections.map((section) => ({ section, docOrder })));
	let sectionOrder: typeof allSections;
	if (queryTerms.length === 0) {
		sectionOrder = allSections.filter(({ section }) => section.path.endsWith("invariants.md"));
	} else {
		const sectionTokens = allSections.map(({ section }) => {
			const heading = tokenize(section.heading);
			return [...Array.from({ length: HEADING_WEIGHT }, () => heading).flat(), ...tokenize(section.text)];
		});
		const scores = bm25(sectionTokens, queryTerms);
		sectionOrder = allSections
			.map((entry, index) => ({ ...entry, score: scores[index] }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || a.docOrder - b.docOrder || a.section.startLine - b.section.startLine);
	}
	const memoryScores = bm25(input.memory.map(tokenize), queryTerms);
	const memoryOrder = queryTerms.length === 0 ? [] : input.memory
		.map((line, index) => ({ line, index, score: memoryScores[index] }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);

	// Exact upper bound on the compact JSON of { docIndex, sections, memory }: the empty
	// containers plus each item and one separator.
	const result: Pick<RankedRecall, "docIndex" | "sections" | "memory"> = { docIndex: [], sections: [], memory: [] };
	let used = byteLength(JSON.stringify(result));
	const tryAdd = <T>(list: T[], item: T): boolean => {
		const size = byteLength(JSON.stringify(item)) + 1;
		if (used + size > rankedBudget) return false;
		list.push(item);
		used += size;
		return true;
	};
	let omittedDocs = 0;
	for (const doc of split) if (!tryAdd(result.docIndex, { path: doc.path, title: doc.title })) omittedDocs++;
	let omittedSections = 0;
	for (const { section } of sectionOrder) if (!tryAdd(result.sections, section)) omittedSections++;
	let omittedMemory = queryTerms.length === 0 ? input.memory.length : 0;
	for (const { line } of memoryOrder) if (!tryAdd(result.memory, line)) omittedMemory++;

	const bytes = input.fixedBytes + byteLength(JSON.stringify(result));
	return {
		...result,
		meta: { bytes, budget, budgetExceeded: bytes > budget, omittedDocs, omittedSections, omittedMemory },
	};
}
