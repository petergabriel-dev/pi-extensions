import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory, { __resetCallCarefulModelImplForTest, setCallCarefulModelImplForTest } from "../index.js";
import { clearFiringLog, getSessionFiringLog, logFiring } from "../retrieval/firing-log.js";
import { parseLessonsFile, serializeLessonsFile } from "../storage/markdown.js";
import { openIndex, rebuildIndex } from "../storage/sqlite.js";
import type { Lesson } from "../types.js";

console.log("Running test_memory_consolidate...");

const sessionModel = { provider: "session", id: "test-model", name: "Test Model" };

function makeCtx(root: string, notifications: string[], branch: unknown[]) {
	return {
		cwd: root,
		hasUI: true,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => branch,
		},
		model: sessionModel,
		modelRegistry: { getAvailable: () => [], getAll: () => [], hasConfiguredAuth: () => false },
	} as any;
}

async function setupExtension(root: string, notifications: string[], branch: unknown[]) {
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	persistentMemory({
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command.handler); },
		appendEntry: () => undefined,
		ui: {},
	} as any);
	const ctx = makeCtx(root, notifications, branch);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return { ctx, memoryCommand: commands.get("memory")! };
}

async function testConsolidateExtractsAndReconciles() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-consolidate-"));
	const notifications: string[] = [];
	const branch = [{
		type: "custom",
		customType: "discussion-notes",
		data: { schemaVersion: 1, added: [{ id: 1, type: "lesson", text: "Use /healthz for health checks." }] },
	}];
	setCallCarefulModelImplForTest(async (_system, _user, options) => {
		assert.strictEqual((options as { model?: unknown }).model, sessionModel);
		return JSON.stringify({
			candidates: {
				lessons: [{ summary: "Health endpoint", detail: "Use /healthz for health checks.", scope_suggestion: path.basename(root), triggers: [{ type: "topic", value: "health" }], source_evidence: { discussion_note_ids: [1] } }],
				preferences: [],
				decisions: [],
				domain: [],
			},
		});
	});
	try {
		const { ctx, memoryCommand } = await setupExtension(root, notifications, branch);
		await memoryCommand("consolidate", ctx);
		const mem = path.join(root, ".pi", "memory");
		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		assert.equal(lessons.length, 1);
		assert.equal(lessons[0].summary, "Health endpoint");
		assert.equal(fs.existsSync(path.join(mem, "canonical-writer.lock")), false, "lock released");
		assert.ok(notifications.some((message) => message.includes("Memory consolidation completed") && message.includes("Extracted: 1")));
	} finally {
		__resetCallCarefulModelImplForTest();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function existingLesson(root: string): Lesson {
	return {
		id: "lsn_01",
		summary: "Existing lesson",
		detail: "Existing detail.",
		meta: {
			project_scope: path.basename(root),
			status: "active",
			session_level: false,
			reinforcement_count: 0,
			last_seen_at: null,
			source_session: "s0",
			created_at: "2026-01-01T00:00:00.000Z",
			supersedes: null,
			triggers: [{ type: "topic", value: "existing" }],
		},
	};
}

async function testConsolidateAppliesReinforcementAndClearsFirings() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-consolidate-reinforce-"));
	const notifications: string[] = [];
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(mem, { recursive: true });
	fs.writeFileSync(path.join(mem, "lessons.md"), serializeLessonsFile([existingLesson(root)]), "utf8");
	for (const name of ["preferences.md", "decisions.md", "domain.md"]) fs.writeFileSync(path.join(mem, name), "", "utf8");
	const index = openIndex(path.join(mem, "index.db"));
	rebuildIndex(index, { projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem });
	index.close();
	const branch = [{ type: "custom", customType: "discussion-notes", data: { schemaVersion: 1, added: [{ id: 1, type: "lesson", text: "Add another memory." }] } }];
	setCallCarefulModelImplForTest(async () => JSON.stringify({
		candidates: {
			lessons: [{ summary: "Another lesson", detail: "Another detail.", scope_suggestion: path.basename(root), triggers: [{ type: "topic", value: "another" }], source_evidence: { discussion_note_ids: [1] } }],
			preferences: [],
			decisions: [],
			domain: [],
		},
	}));
	try {
		const { ctx, memoryCommand } = await setupExtension(root, notifications, branch);
		logFiring({ lesson_id: "lsn_01", trigger: { type: "topic", value: "existing" }, fired_at: new Date().toISOString(), context_summary: "test", tier: 1 });
		await memoryCommand("consolidate", ctx);
		const lessons = parseLessonsFile(path.join(mem, "lessons.md"));
		const reinforced = lessons.find((lesson) => lesson.id === "lsn_01");
		assert.ok(reinforced);
		assert.equal(reinforced.meta.reinforcement_count, 1, "fired lesson reinforced during consolidate");
		assert.equal(getSessionFiringLog().length, 0, "firing log cleared after reinforcement");
		assert.ok(notifications.some((message) => message.includes("Reinforcement: 1 reinforced")));
	} finally {
		__resetCallCarefulModelImplForTest();
		clearFiringLog();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testConsolidateRequiresSessionModel() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-consolidate-nomodel-"));
	const notifications: string[] = [];
	const branch = [{
		type: "custom",
		customType: "discussion-notes",
		data: { schemaVersion: 1, added: [{ id: 1, type: "lesson", text: "Use session model." }] },
	}];
	try {
		const { ctx, memoryCommand } = await setupExtension(root, notifications, branch);
		delete ctx.model;
		await memoryCommand("consolidate", ctx);
		assert.ok(notifications.some((message) => message.includes("requires an active session model")));
		assert.equal(fs.existsSync(path.join(root, ".pi", "memory", "canonical-writer.lock")), false, "lock released");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testConsolidateRequiresBranch() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-consolidate-nobranch-"));
	const notifications: string[] = [];
	try {
		const { ctx, memoryCommand } = await setupExtension(root, notifications, []);
		delete ctx.sessionManager.getBranch;
		await memoryCommand("consolidate", ctx);
		assert.ok(notifications.some((message) => message.includes("getBranch")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testConsolidateLockFailsFast() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-consolidate-lock-"));
	const notifications: string[] = [];
	try {
		const { ctx, memoryCommand } = await setupExtension(root, notifications, []);
		const lockPath = path.join(root, ".pi", "memory", "canonical-writer.lock");
		fs.writeFileSync(lockPath, "locked", "utf8");
		await memoryCommand("consolidate", ctx);
		assert.ok(notifications.some((message) => message.includes("canonical writer already running")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

await testConsolidateExtractsAndReconciles();
await testConsolidateAppliesReinforcementAndClearsFirings();
await testConsolidateRequiresSessionModel();
await testConsolidateRequiresBranch();
await testConsolidateLockFailsFast();
console.log("test_memory_consolidate passed!");
