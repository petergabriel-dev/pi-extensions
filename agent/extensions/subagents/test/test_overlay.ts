import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import type { SubagentItem } from "../launch.ts";
import {
	formatSubagentItemLines,
	orderSubagentTree,
	SubagentOverlayComponent,
	type SubagentOverlayRecord,
	type SubagentOverlaySource,
} from "../overlay.ts";

function record(overrides: Partial<SubagentOverlayRecord> = {}): SubagentOverlayRecord {
	return {
		owner: "subagent-1",
		agentName: "worker",
		status: "running",
		depth: 0,
		startedAt: Date.now() - 2_000,
		effort: "medium",
		sessionFile: "/tmp/child.jsonl",
		...overrides,
	};
}

function makeHarness(current: SubagentOverlayRecord, initialItems: readonly SubagentItem[] = []) {
	let itemListener: ((items: readonly SubagentItem[]) => void) | undefined;
	let unsubscribeCount = 0;
	let doneCount = 0;
	let renderRequests = 0;
	const answers: Array<{ questionId: string; answer: string }> = [];
	const steers: string[] = [];
	const notes: string[] = [];
	let items = initialItems;
	let questionNotice: string | undefined;
	const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => { renderRequests += 1; } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
	const source: SubagentOverlaySource = {
		getRecord: () => current,
		getQuestionNotice: () => questionNotice,
		readItems: () => items,
		subscribeItems: (listener) => {
			itemListener = listener;
			listener(items);
			return () => { unsubscribeCount += 1; };
		},
		redactText: (text) => text.replaceAll("ipc-secret", "[REDACTED]"),
		answerQuestion: (questionId, answer) => {
			answers.push({ questionId, answer });
			current.question = undefined;
			current.status = "running";
			return true;
		},
		steer: async (message) => {
			steers.push(message);
			notes.push(`User told ${current.owner}: ${message}`);
		},
	};
	const component = new SubagentOverlayComponent(tui, theme, current, source, () => { doneCount += 1; });
	return {
		component,
		answers,
		steers,
		notes,
		get unsubscribeCount() { return unsubscribeCount; },
		get doneCount() { return doneCount; },
		get renderRequests() { return renderRequests; },
		updateItems(next: readonly SubagentItem[]) {
			items = next;
			itemListener?.(next);
		},
		setQuestionNotice(next: string | undefined) {
			questionNotice = next;
			component.refresh();
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

const wideItem: SubagentItem = { kind: "text", text: "Wide chars 界🙂 and ipc-secret" };
for (const width of [40, 80, 120]) {
	const lines = formatSubagentItemLines([wideItem], width);
	assert.ok(lines.length > 0);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `formatted line exceeds ${width} columns`);
}

const largeText = "界🙂 abc ".repeat(150);
const largeItems: SubagentItem[] = Array.from({ length: 200 }, () => ({ kind: "text", text: largeText }));
assert.ok(largeItems.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") <= 2 * 1024));
const benchmarkStart = performance.now();
const renderedLines = formatSubagentItemLines(largeItems, 80);
const benchmarkMs = performance.now() - benchmarkStart;
assert.ok(renderedLines.length >= 200);
assert.ok(benchmarkMs < 16, `formatting 200 bounded items took ${benchmarkMs.toFixed(2)} ms`);

const tree = orderSubagentTree([
	record({ owner: "root-b", startedAt: 20 }),
	record({ owner: "child-b", parentOwner: "root-b", depth: 1, startedAt: 30 }),
	record({ owner: "root-a", startedAt: 10 }),
	record({ owner: "child-a", parentOwner: "root-a", depth: 1, startedAt: 40 }),
]);
assert.deepEqual(tree.map((child) => child.owner), ["root-a", "child-a", "root-b", "child-b"]);

const pending = record({ status: "waiting", question: { questionId: "question-1", question: "Choose?", options: ["red", "blue"] } });
const answerHarness = makeHarness(pending, [{ kind: "question", text: "Question includes ipc-secret" }]);
const safeLines = answerHarness.component.render(80).join("\n");
assert.match(safeLines, /\[REDACTED\]/);
assert.doesNotMatch(safeLines, /ipc-secret/);
assert.match(safeLines, /Question: Choose\?/);
assert.match(safeLines, /Options: red \| blue/);
assert.match(safeLines, /Esc closes \/agents only; question stays pending/);
for (const character of "blue") answerHarness.component.handleInput(character);
answerHarness.component.handleInput("\r");
await flush();
assert.deepEqual(answerHarness.answers, [{ questionId: "question-1", answer: "blue" }]);
assert.deepEqual(answerHarness.steers, []);
assert.match(answerHarness.component.render(80).join("\n"), /Answer sent to subagent-1/);
answerHarness.component.handleInput("\u001b");
assert.equal(answerHarness.unsubscribeCount, 1);
assert.equal(answerHarness.doneCount, 1);
answerHarness.component.handleInput("\u001b");
assert.equal(answerHarness.unsubscribeCount, 1);

const escapePending = record({ status: "waiting", question: { questionId: "question-esc", question: "Still pending?" } });
const escapeHarness = makeHarness(escapePending);
escapeHarness.component.handleInput("\u001b");
assert.deepEqual(escapeHarness.answers, []);
assert.equal(escapePending.question?.questionId, "question-esc", "Esc closes overlay without dismissing pending question");
assert.equal(escapeHarness.doneCount, 1);
assert.equal(escapeHarness.unsubscribeCount, 1);

const externalQuestionHarness = makeHarness(record());
externalQuestionHarness.setQuestionNotice("explorer subagent-2 (via worker subagent-1) has a question; press Esc to answer it.");
const externalQuestionText = externalQuestionHarness.component.render(80).join(" ").replace(/\s+/g, " ");
assert.ok(externalQuestionText.includes("explorer subagent-2 (via worker subagent-1) has a question; press Esc to answer it"));
externalQuestionHarness.component.handleInput("\u001b");
assert.deepEqual(externalQuestionHarness.answers, []);
assert.equal(externalQuestionHarness.doneCount, 1);

const steerHarness = makeHarness(record());
for (const character of "check logs") steerHarness.component.handleInput(character);
steerHarness.component.handleInput("\r");
await flush();
assert.deepEqual(steerHarness.steers, ["check logs"]);
assert.deepEqual(steerHarness.notes, ["User told subagent-1: check logs"]);
steerHarness.component.dispose();
assert.equal(steerHarness.unsubscribeCount, 1);

const finishedHarness = makeHarness(record({ status: "done", finishedAt: Date.now() }));
finishedHarness.component.handleInput("x");
finishedHarness.component.handleInput("\r");
await flush();
assert.deepEqual(finishedHarness.steers, []);
assert.match(finishedHarness.component.render(80).join("\n"), /Finished child is read-only/);
finishedHarness.component.dispose();

const navigationItems: SubagentItem[] = Array.from({ length: 30 }, (_, index) => ({ kind: "text", text: `event ${index}` }));
const navigationHarness = makeHarness(record(), navigationItems);
assert.match(navigationHarness.component.render(80).join("\n"), /event 29/);
navigationHarness.component.handleInput("\u001b[5~");
const scrolledUp = navigationHarness.component.render(80).join("\n");
assert.match(scrolledUp, /event 0/);
assert.doesNotMatch(scrolledUp, /event 29/);
navigationHarness.component.handleInput("\u001b[6~");
assert.match(navigationHarness.component.render(80).join("\n"), /event 29/);
navigationHarness.component.dispose();

const throttleHarness = makeHarness(record());
const beforeBurst = throttleHarness.renderRequests;
for (let index = 0; index < 50; index++) throttleHarness.updateItems([{ kind: "text", text: `delta ${index}` }]);
assert.ok(throttleHarness.renderRequests <= beforeBurst + 1, "delta burst should trigger at most one immediate redraw");
await new Promise((resolve) => setTimeout(resolve, 110));
assert.ok(throttleHarness.renderRequests <= beforeBurst + 2, "delta burst should be throttled to 10 redraws per second");
throttleHarness.component.dispose();

console.log("subagent overlay tests passed");
