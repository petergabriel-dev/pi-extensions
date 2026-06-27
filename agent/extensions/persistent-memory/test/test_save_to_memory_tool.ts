import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory from "../index.js";
import { listStagingFiles } from "../consolidation/staging.js";
import { parseLessonsFile } from "../storage/markdown.js";

console.log("Running test_save_to_memory_tool...");

function candidate(root: string) {
	return {
		summary: "Health endpoint",
		detail: "Use /healthz for backend health checks.",
		scope_suggestion: path.basename(root),
		triggers: [{ type: "topic", value: "health" }],
		source_evidence: { discussion_note_ids: [1] },
	};
}

async function setup(root: string) {
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	persistentMemory({
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: () => undefined,
		registerTool: (tool: any) => { tools.set(tool.name, tool); },
		appendEntry: () => undefined,
		ui: {},
	} as any);
	const notifications: string[] = [];
	const ctx = {
		cwd: root,
		hasUI: true,
		model: { provider: "session", id: "test-model", name: "Test Model" },
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWidget: () => undefined },
	} as any;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return { ctx, tool: tools.get("save_to_memory"), mem: path.join(root, ".pi", "memory"), notifications };
}

async function testSaveToMemoryWritesStagesReconcilesAndReportsOutcomes() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-save-tool-"));
	try {
		const { ctx, tool, mem } = await setup(root);
		assert.ok(tool, "tool registered");
		const updates: unknown[] = [];
		const result = await tool.execute("call-save", {
			session_id: "agent-save",
			candidates: { lessons: [candidate(root)], preferences: [], decisions: [], domain: [] },
		}, undefined, (update: unknown) => updates.push(update), ctx);

		assert.equal(result.details.ok, true);
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.outcomes.add, 1);
		assert.ok(result.details.candidateOutcomes.some((row: any) => row.outcome === "add"));
		assert.ok(updates.length >= 2, "progress updates emitted");
		assert.equal(listStagingFiles(mem).length, 0, "staging consumed by reconcile");
		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		assert.equal(lessons.length, 1);
		assert.equal(lessons[0].summary, "Health endpoint");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testSaveToMemoryRejectsMalformedWithoutPartialWrite() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-save-tool-bad-"));
	try {
		const { ctx, tool, mem } = await setup(root);
		const result = await tool.execute("call-bad", {
			session_id: "bad-save",
			candidates: {
				lessons: [{ summary: "Missing detail", scope_suggestion: path.basename(root), triggers: [{ type: "topic", value: "bad" }], source_evidence: { discussion_note_ids: [2] } }],
				preferences: [],
				decisions: [],
				domain: [],
			},
		}, undefined, undefined, ctx);

		assert.equal(result.details.ok, false);
		assert.equal(result.details.status, "rejected");
		assert.equal(listStagingFiles(mem).length, 0, "no staging written");
		assert.equal(parseLessonsFile(path.join(mem, "lessons.md")).length, 0, "no canonical write");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

await testSaveToMemoryWritesStagesReconcilesAndReportsOutcomes();
await testSaveToMemoryRejectsMalformedWithoutPartialWrite();
console.log("test_save_to_memory_tool passed!");
