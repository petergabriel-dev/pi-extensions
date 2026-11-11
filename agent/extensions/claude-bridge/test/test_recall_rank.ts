import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { RANKED_FLOOR_BYTES, rankRecall, SECTION_TEXT_CAP_BYTES, splitSections, type RankedRecall, type RecallDoc } from "../recall-rank.js";

const corpusRoot = path.join(__dirname, "fixtures", "recall-corpus");
const docPaths = [
	"docs/engineering/architecture.md",
	"docs/engineering/decisions/ADR-0099-request-lifecycle.md",
	"docs/engineering/invariants.md",
	"docs/engineering/traps.md",
];
const docs: RecallDoc[] = docPaths.map((docPath) => ({ path: docPath, text: fs.readFileSync(path.join(corpusRoot, docPath), "utf8") }));
const memory = fs.readFileSync(path.join(corpusRoot, "memory-index.md"), "utf8").split("\n").filter((line) => line.startsWith("- "));
const KB = 1024;

function rank(query: string, budgetBytes = 32 * KB, fixedBytes = 0, input: { docs?: RecallDoc[]; memory?: string[] } = {}): RankedRecall {
	return rankRecall({ query, docs: input.docs ?? docs, memory: input.memory ?? memory, budgetBytes, fixedBytes });
}

function rankedBytes(result: RankedRecall): number {
	return Buffer.byteLength(JSON.stringify({ docIndex: result.docIndex, sections: result.sections, memory: result.memory }), "utf8");
}

// Pointers are real: each section's line range holds exactly its text (or its prefix when capped).
function assertPointers(result: RankedRecall, sourceDocs: RecallDoc[]): void {
	for (const section of result.sections) {
		const source = sourceDocs.find((doc) => doc.path === section.path);
		assert.ok(source, `unknown section path ${section.path}`);
		const lines = source.text.split("\n").slice(section.startLine - 1, section.endLine).join("\n");
		if (section.truncated) assert.ok(lines.startsWith(section.text), `${section.path}:${section.startLine} truncated text is not a prefix`);
		else assert.equal(section.text, lines, `${section.path}:${section.startLine} pointer mismatch`);
	}
}

// Regression table: query -> expected top section.
const expectations: Array<{ query: string; path: string; heading: string }> = [
	{ query: "fs.watch missed events poll", path: "docs/engineering/traps.md", heading: "Bridge IPC" },
	{ query: "build lease human approval", path: "docs/engineering/invariants.md", heading: "Build lease" },
	{ query: "plan file 256 KiB atomic writes", path: "docs/engineering/invariants.md", heading: "Plan storage" },
	{ query: "outcome unknown after restart", path: "docs/engineering/decisions/ADR-0099-request-lifecycle.md", heading: "Decision" },
	{ query: "subagent watchdog stderr", path: "docs/engineering/traps.md", heading: "Subagents" },
	{ query: "non-ASCII UTF-8 byte budgets", path: "docs/engineering/traps.md", heading: "Résumé of encoding traps" },
];
for (const { query, path: expectedPath, heading } of expectations) {
	const result = rank(query);
	assert.deepEqual({ path: result.sections[0]?.path, heading: result.sections[0]?.heading }, { path: expectedPath, heading }, `query ${JSON.stringify(query)}`);
	assertPointers(result, docs);
}
assert.equal(rank("commit attribution trailer").memory[0], memory[0]);
assert.equal(rank("stdlib dependencies hooks").memory[0], memory[1]);

// Doc index: one line per doc; ADR frontmatter title wins over the H1.
assert.deepEqual(rank("anything").docIndex, [
	{ path: "docs/engineering/architecture.md", title: "Architecture" },
	{ path: "docs/engineering/decisions/ADR-0099-request-lifecycle.md", title: "Bridge request lifecycle" },
	{ path: "docs/engineering/invariants.md", title: "Invariants" },
	{ path: "docs/engineering/traps.md", title: "Traps" },
]);

// A "## " line inside a code fence is not a heading.
const traps = splitSections(docs[3]);
assert.ok(!traps.sections.some((section) => section.heading.includes("fake heading")));
assert.ok(traps.sections.find((section) => section.heading === "Bridge IPC")!.text.includes("## fake heading inside a fence"));

// Empty query: doc index plus invariants sections in doc order; no memory.
const empty = rank("");
assert.ok(empty.sections.length > 0);
assert.ok(empty.sections.every((section) => section.path === "docs/engineering/invariants.md"));
assert.deepEqual(empty.sections.map((section) => section.startLine), [...empty.sections.map((section) => section.startLine)].sort((a, b) => a - b));
assert.deepEqual(empty.memory, []);
assert.equal(empty.meta.omittedMemory, memory.length);

assert.equal(empty.meta.fallback, true);

// No match: the invariants sections are the fallback, flagged; no memory.
const none = rank("zzzz qqqq");
assert.deepEqual(none.sections, empty.sections);
assert.deepEqual([none.memory, none.meta.fallback, none.meta.omittedMemory], [[], true, 0]);
assert.equal(rank("build lease human approval").meta.fallback, false);

// Deterministic.
assert.deepEqual(rank("bridge plan lease"), rank("bridge plan lease"));

// H2 over the split size is split at H3; small H2s are not, even with H3s.
const filler = (label: string) => Array.from({ length: 40 }, (_, line) => `- ${label} detail line ${line} about request queues and recall budgets.`).join("\n");
const bigDoc: RecallDoc = {
	path: "docs/engineering/big.md",
	text: ["# Big", "", "## Large section", "Intro.", "", "### Alpha", filler("alpha"), "", "### Beta", filler("beta"), "", "## Small section", "### Only child", "short", ""].join("\n"),
};
const big = splitSections(bigDoc);
assert.deepEqual(big.sections.map((section) => section.heading), ["Big", "Large section", "Large section › Alpha", "Large section › Beta", "Small section"]);
assertPointers({ docIndex: [], sections: big.sections, memory: [], meta: rank("").meta }, [bigDoc]);

// A section without H3s over the text cap is capped at a UTF-8 boundary; the range still covers all of it.
const longDoc: RecallDoc = { path: "docs/engineering/long.md", text: `# Long\n\n## Wide\n${"é漢".repeat(4_000)}\n` };
const wide = splitSections(longDoc).sections.find((section) => section.heading === "Wide")!;
assert.equal(wide.truncated, true);
assert.ok(Buffer.byteLength(wide.text, "utf8") <= SECTION_TEXT_CAP_BYTES);
assert.ok(!wide.text.includes("�"));
assert.equal(wide.endLine, 4);
assertPointers({ docIndex: [], sections: [wide], memory: [], meta: rank("").meta }, [longDoc]);

// Budget: across budgets and fixed sizes the ranked part never exceeds max(budget - fixed, floor);
// meta.bytes is fixed + ranked and budgetExceeded says when the total is over.
const largeCorpus: RecallDoc[] = Array.from({ length: 60 }, (_, index) => ({
	path: `docs/engineering/generated-${String(index).padStart(2, "0")}.md`,
	text: `# Generated ${index}\n\n${docs.map((doc) => doc.text.replace(/^# .*$/m, "")).join("\n")}\n## Extra ${index}\n${filler(`generated ${index}`)}\n`.repeat(4),
}));
const corpusBytes = largeCorpus.reduce((sum, doc) => sum + Buffer.byteLength(doc.text, "utf8"), 0);
assert.ok(corpusBytes > 600 * KB, `generated corpus is only ${corpusBytes} bytes`);
for (const budgetBytes of [1 * KB, 8 * KB, 16 * KB, 32 * KB]) {
	for (const fixedBytes of [0, 5 * KB, 30 * KB, 40 * KB]) {
		const result = rank("bridge request lease plan recall budget", budgetBytes, fixedBytes, { docs: largeCorpus });
		const ranked = rankedBytes(result);
		const allowed = Math.max(budgetBytes - fixedBytes, RANKED_FLOOR_BYTES);
		assert.ok(ranked <= allowed, `ranked ${ranked} > ${allowed} (budget ${budgetBytes}, fixed ${fixedBytes})`);
		assert.equal(result.meta.bytes, fixedBytes + ranked);
		assert.equal(result.meta.budgetExceeded, result.meta.bytes > budgetBytes);
		assert.equal(result.meta.budget, budgetBytes);
		assert.ok(result.meta.omittedSections > 0, "budget must bind on the large corpus");
		assertPointers(result, largeCorpus);
	}
}
// A full section budget cannot starve the best memory entries: hundreds of uniform small
// sections leave less room than one memory line once they fill the budget.
const tinyDoc: RecallDoc = { path: "t.md", text: ["# Tiny", ...Array.from({ length: 400 }, (_, index) => `## L${1000 + index}\nlease plan`)].join("\n") };
const crowded = rank("commit attribution lease plan", 8 * KB, 0, { docs: [tinyDoc] });
assert.ok(crowded.meta.omittedSections > 0, "sections must overflow the budget here");
assert.ok(Buffer.byteLength(JSON.stringify(memory[0])) > Buffer.byteLength(JSON.stringify(crowded.sections[0])), "memory line must be larger than one section");
assert.equal(crowded.memory[0], memory[0]);

// A repo-sized doc index (61 docs, ~8 KB) must not starve sections and memory when a
// build-mode fixed part leaves only the 8 KB floor; with an ample budget it stays complete.
const repoDocs: RecallDoc[] = Array.from({ length: 61 }, (_, index) => ({
	path: `docs/engineering/decisions/ADR-${String(index).padStart(4, "0")}-bridge-request-decision-${index}.md`,
	text: `---\ntitle: Bridge request lifecycle decision ${index}\n---\n\n## Decision\n- Lease ${index} claims requests by rename.\n`,
}));
const repoIndexBytes = Buffer.byteLength(JSON.stringify(repoDocs.map((doc) => ({ path: doc.path, title: splitSections(doc).title }))), "utf8");
assert.ok(repoIndexBytes > 7 * KB && repoIndexBytes < RANKED_FLOOR_BYTES, `index fixture is ${repoIndexBytes} bytes`);
const buildSized = rank("commit attribution lease claims", 32 * KB, 37 * KB, { docs: repoDocs });
assert.ok(rankedBytes(buildSized) <= RANKED_FLOOR_BYTES);
assert.ok(buildSized.sections.length > 0, "doc index must not starve sections");
assert.equal(buildSized.memory[0], memory[0], "doc index must not starve memory");
assert.ok(buildSized.meta.omittedDocs > 0 && buildSized.docIndex.length > 0);
assert.deepEqual(buildSized.docIndex.map((entry) => entry.path), repoDocs.map((doc) => doc.path).filter((docPath) => buildSized.docIndex.some((entry) => entry.path === docPath)), "partial index keeps doc order");
assert.equal(buildSized.docIndex[0].path, repoDocs[0].path, "partial index keeps the first docs");
const ample = rank("commit attribution lease claims", 32 * KB, 4 * KB, { docs: repoDocs });
assert.equal(ample.meta.omittedDocs, 0);
assert.equal(ample.docIndex.length, repoDocs.length);
assert.ok(ample.sections.length > buildSized.sections.length);

// Floor: a large fixed part still leaves 8 KB for ranked content and is reported over budget.
const floored = rank("bridge request lease", 32 * KB, 30 * KB, { docs: largeCorpus });
assert.ok(rankedBytes(floored) > 2 * KB && rankedBytes(floored) <= RANKED_FLOOR_BYTES);
assert.equal(floored.meta.budgetExceeded, true);

// Performance on a corpus larger than today's docs (~635 KB). Generous bound for slow CI;
// the measured time is printed.
const started = performance.now();
rank("bridge request lease plan recall budget", 32 * KB, 0, { docs: largeCorpus });
const elapsed = performance.now() - started;
assert.ok(elapsed < 2_000, `ranking took ${elapsed.toFixed(0)} ms`);

console.log(`recall-rank tests passed (${(corpusBytes / KB).toFixed(0)} KB corpus ranked in ${elapsed.toFixed(0)} ms)`);
