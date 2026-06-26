import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory from "../index.js";
import { listDeadLetterFiles, listStagingFiles, readStaging, writeStaging } from "../consolidation/staging.js";
import type { StagingFile } from "../types.js";

console.log("Running test_memory_recover...");

async function setup(root: string, notifications: string[]) {
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	persistentMemory({
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command.handler); },
		appendEntry: () => undefined,
		ui: {},
	} as any);
	const ctx = {
		cwd: root,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWidget: () => undefined },
		modelRegistry: { getAvailable: () => [], getAll: () => [], hasConfiguredAuth: () => false },
	} as any;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return { ctx, memoryCommand: commands.get("memory")!, mem: path.join(root, ".pi", "memory") };
}

function writeDead(mem: string, name: string, data: unknown) {
	const dir = path.join(mem, "deadletter");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), "utf8");
}

function lessonCandidate(summary = "Recovered lesson") {
	return {
		summary,
		detail: "Recovered detail.",
		scope_suggestion: "testproj",
		triggers: [{ type: "topic" as const, value: "recover" }],
		source_evidence: { discussion_note_ids: [42] },
	};
}

async function testRecoverRequeuesAndDeletesDeadLetters() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-recover-"));
	const notifications: string[] = [];
	try {
		const { ctx, memoryCommand, mem } = await setup(root, notifications);
		writeDead(mem, "lesson.json", {
			session_id: "s1",
			produced_at: "2026-06-10T00:00:00.000Z",
			attempts: 0,
			last_gate_reason: "legacy transient",
			category: "lessons",
			candidate: lessonCandidate(),
		});

		await memoryCommand("recover", ctx);
		assert.equal(listDeadLetterFiles(mem).length, 0, "deadletter deleted after successful staging write");
		const stagedFiles = listStagingFiles(mem);
		assert.equal(stagedFiles.length, 1);
		const staging = readStaging(stagedFiles[0]);
		assert.ok(staging);
		assert.equal(staging.candidates.lessons.length, 1);
		assert.equal(staging.candidates.lessons[0].reconcile_attempts, 0);
		assert.ok(notifications.some((message) => message.includes("1 re-queued")));

		await memoryCommand("recover", ctx);
		assert.equal((readStaging(stagedFiles[0])?.candidates.lessons ?? []).length, 1, "second run is no-op");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testRecoverSkipsMalformedAndLeavesFile() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-recover-bad-"));
	const notifications: string[] = [];
	try {
		const { ctx, memoryCommand, mem } = await setup(root, notifications);
		writeDead(mem, "bad.json", {
			session_id: "s1",
			produced_at: "2026-06-10T00:00:00.000Z",
			attempts: 0,
			last_gate_reason: "bad",
			category: "lessons",
			candidate: { summary: "missing fields" },
		});
		await memoryCommand("recover", ctx);
		assert.equal(listDeadLetterFiles(mem).length, 1, "malformed deadletter left in place");
		assert.equal(listStagingFiles(mem).length, 0);
		assert.ok(notifications.some((message) => message.includes("1 malformed")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testRecoverDoesNotDuplicateExistingStaging() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-recover-dupe-"));
	const notifications: string[] = [];
	try {
		const { ctx, memoryCommand, mem } = await setup(root, notifications);
		const staging: StagingFile = {
			schemaVersion: 1,
			session_id: "s1",
			produced_at: "2026-06-10T00:00:00.000Z",
			project_root: root,
			candidates: { lessons: [{ ...lessonCandidate(), reconcile_attempts: 0 }], preferences: [], decisions: [], domain: [] },
		};
		writeStaging(path.join(mem, "staging", "s1.json"), staging);
		writeDead(mem, "dupe.json", {
			session_id: "s1",
			produced_at: "2026-06-10T00:00:00.000Z",
			attempts: 0,
			last_gate_reason: "legacy transient",
			category: "lessons",
			candidate: lessonCandidate(),
		});
		await memoryCommand("recover", ctx);
		assert.equal(readStaging(path.join(mem, "staging", "s1.json"))?.candidates.lessons.length, 1);
		assert.equal(listDeadLetterFiles(mem).length, 0, "duplicate deadletter consumed as already queued");
		assert.ok(notifications.some((message) => message.includes("1 duplicate")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

await testRecoverRequeuesAndDeletesDeadLetters();
await testRecoverSkipsMalformedAndLeavesFile();
await testRecoverDoesNotDuplicateExistingStaging();
console.log("test_memory_recover passed!");
