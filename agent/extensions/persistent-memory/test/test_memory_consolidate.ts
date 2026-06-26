import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory, { __resetCallCarefulModelImplForTest, setCallCarefulModelImplForTest } from "../index.js";
import { parseLessonsFile } from "../storage/markdown.js";

console.log("Running test_memory_consolidate...");

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
	setCallCarefulModelImplForTest(async () => JSON.stringify({
		candidates: {
			lessons: [{ summary: "Health endpoint", detail: "Use /healthz for health checks.", scope_suggestion: path.basename(root), triggers: [{ type: "topic", value: "health" }], source_evidence: { discussion_note_ids: [1] } }],
			preferences: [],
			decisions: [],
			domain: [],
		},
	}));
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
await testConsolidateRequiresBranch();
await testConsolidateLockFailsFast();
console.log("test_memory_consolidate passed!");
