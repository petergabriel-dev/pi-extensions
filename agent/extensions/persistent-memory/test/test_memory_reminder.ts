import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory from "../index.js";

console.log("Running test_memory_reminder...");

type Handler = (data: unknown) => unknown;

function makeEvents() {
	const handlers = new Map<string, Handler[]>();
	return {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		emit: (name: string, data?: unknown) => { for (const handler of handlers.get(name) ?? []) void handler(data); },
	};
}

async function setup(root: string, branch: unknown[], confirmValue = false) {
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	const handlers = new Map<string, Function>();
	const events = makeEvents();
	let confirmCount = 0;
	const notifications: string[] = [];
	persistentMemory({
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: () => undefined,
		appendEntry: () => undefined,
		events,
		ui: {},
	} as any);
	const ctx = {
		cwd: root,
		hasUI: true,
		ui: {
			confirm: async () => { confirmCount += 1; return confirmValue; },
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
		sessionManager: { getBranch: () => branch },
	} as any;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return { events, notifications, getConfirmCount: () => confirmCount };
}

async function testReminderOnceWhenLeavingWorkMode() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reminder-"));
	try {
		const branch = [{ type: "custom", customType: "discussion-notes", data: { schemaVersion: 1, added: [{ id: 1, type: "lesson", text: "Persist this." }] } }];
		const { events, notifications, getConfirmCount } = await setup(root, branch, false);
		events.emit("workflow-modes:changed", { mode: "build", hasPlan: true });
		events.emit("workflow-modes:changed", { mode: "off", hasPlan: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(getConfirmCount(), 1, "leaving work mode shows reminder");
		assert.ok(notifications.some((message) => message.includes("snoozed")));
		events.emit("workflow-modes:changed", { mode: "build", hasPlan: true });
		events.emit("workflow-modes:changed", { mode: "off", hasPlan: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(getConfirmCount(), 1, "second transition does not re-nag");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function testNoReminderWithoutHighValueContent() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reminder-empty-"));
	try {
		const { events, getConfirmCount } = await setup(root, [{ role: "user", content: "hello" }]);
		events.emit("workflow-modes:changed", { mode: "plan", hasPlan: false });
		events.emit("workflow-modes:changed", { mode: "off", hasPlan: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(getConfirmCount(), 0, "no high-value branch content means no reminder");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

await testReminderOnceWhenLeavingWorkMode();
await testNoReminderWithoutHighValueContent();
console.log("test_memory_reminder passed!");
