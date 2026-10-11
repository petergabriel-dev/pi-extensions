import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "../index.ts";

const REQUEST = "ask-user-question:request";
const ACK = "ask-user-question:ack";
const RESULT = "ask-user-question:result";
const CANCEL = "ask-user-question:cancel";

type EventHandler = (data: unknown) => void;
type UIComponent = { render?: (width: number) => string[]; handleInput?: (data: string) => void };
interface UIInstance {
	component: UIComponent;
	resolve: (value: unknown) => void;
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function createHarness(hasUI = true) {
	const eventHandlers = new Map<string, Set<EventHandler>>();
	const lifecycleHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const uiInstances: UIInstance[] = [];
	const acknowledgements: Array<Record<string, unknown>> = [];
	const results: Array<Record<string, unknown>> = [];
	const events = {
		on(name: string, handler: EventHandler) {
			const handlers = eventHandlers.get(name) ?? new Set<EventHandler>();
			handlers.add(handler);
			eventHandlers.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of eventHandlers.get(name) ?? []) handler(data);
		},
	};
	const pi = {
		events,
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			lifecycleHandlers.set(name, handler);
		},
		registerEntryRenderer() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		appendEntry() {},
		sendUserMessage() {},
	};
	// ponytail: fake TUI covers protocol and key handling; installed-TUI fidelity stays in live acceptance.
	const tui = { terminal: { cols: 80, rows: 24 }, requestRender() {} };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ui = {
		custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown): Promise<T> {
			return new Promise<T>((resolve) => {
				const component = factory(tui, theme, {}, resolve) as UIComponent;
				uiInstances.push({ component, resolve: (value) => resolve(value as T) });
			});
		},
	};
	const ctx = {
		hasUI,
		ui,
		mode: "tui",
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
		abort() {},
	} as unknown as ExtensionContext;

	askUserQuestion(pi as unknown as ExtensionAPI);
	lifecycleHandlers.get("session_start")?.({}, ctx);
	events.on(ACK, (value) => acknowledgements.push(value as Record<string, unknown>));
	events.on(RESULT, (value) => results.push(value as Record<string, unknown>));

	return { events, uiInstances, acknowledgements, results, tools, lifecycleHandlers, ctx };
}

function last<T>(items: T[]): T {
	const value = items.at(-1);
	assert.ok(value, "expected at least one item");
	return value;
}

async function main(): Promise<void> {
	{
		const harness = createHarness();
		let emitting = true;
		harness.events.on(ACK, () => {
			assert.equal(emitting, true, "ack must be emitted before request emit returns");
		});
		harness.events.emit(REQUEST, { requestId: "sync-ack", title: "Child question" });
		emitting = false;
		assert.deepEqual(harness.acknowledgements[0], { requestId: "sync-ack", accepted: true });
		await flush();
		assert.equal(harness.uiInstances.length, 1);
		harness.uiInstances[0]!.resolve("child answer");
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "sync-ack", status: "answered", answer: "child answer" }]);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "dismiss", title: "Pick one", options: ["Green", "Blue"] });
		await flush();
		const ui = harness.uiInstances[0]!;
		const rendered = ui.component.render?.(80).join("\n") ?? "";
		assert.match(rendered, /Other/);
		assert.doesNotMatch(rendered, /Skip this question/);
		ui.component.handleInput?.("\u001b");
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "dismiss", status: "dismissed" }]);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "choose", title: "Pick one", options: ["Green", "Blue"] });
		await flush();
		harness.uiInstances[0]!.component.handleInput?.("\r");
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "choose", status: "answered", answer: "Green" }]);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "cancel-open", title: "Child question" });
		await flush();
		harness.events.emit(CANCEL, { requestId: "cancel-open" });
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "cancel-open", status: "cancelled" }]);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "shutdown-open", title: "Child question" });
		await flush();
		harness.lifecycleHandlers.get("session_shutdown")?.({}, harness.ctx);
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "shutdown-open", status: "cancelled" }]);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "active", title: "First question" });
		await flush();
		harness.events.emit(REQUEST, { requestId: "queued", title: "Second question" });
		harness.events.emit(CANCEL, { requestId: "queued" });
		assert.deepEqual(last(harness.results), { requestId: "queued", status: "cancelled" });
		assert.equal(harness.uiInstances.length, 1, "queued request must not render before active UI finishes");
		harness.uiInstances[0]!.resolve("first answer");
		await flush();
		assert.equal(harness.uiInstances.length, 1, "cancelled queued request must never render");
		assert.equal(harness.results.filter((result) => result.requestId === "queued").length, 1);
	}

	{
		const harness = createHarness();
		harness.events.emit(REQUEST, { requestId: "duplicate", title: "First" });
		await flush();
		harness.events.emit(REQUEST, { requestId: "duplicate", title: "Second" });
		assert.deepEqual(last(harness.acknowledgements), {
			requestId: "duplicate",
			accepted: false,
			reason: "requestId is already pending.",
		});
		assert.equal(harness.uiInstances.length, 1);
		const malformedRequests = [
			{ requestId: "", title: "empty id" },
			{ requestId: "x".repeat(201), title: "long id" },
			{ requestId: "empty-title", title: "   " },
			{ requestId: "long-title", title: "x".repeat(4_001) },
			{ requestId: "too-many-options", title: "Question", options: Array.from({ length: 51 }, (_, index) => `option ${index}`) },
			{ requestId: "empty-option", title: "Question", options: ["   "] },
			{ requestId: "long-option", title: "Question", options: ["x".repeat(501)] },
		];
		for (const request of malformedRequests) {
			harness.events.emit(REQUEST, request);
			assert.equal(last(harness.acknowledgements).accepted, false, `malformed request ${request.requestId || "<invalid id>"} must be rejected`);
		}
		const throwingRequest = Object.defineProperty({}, "requestId", { get: () => { throw new Error("malformed payload"); } });
		harness.events.emit(REQUEST, throwingRequest);
		assert.deepEqual(last(harness.acknowledgements), {
			requestId: "",
			accepted: false,
			reason: "request payload is malformed.",
		});
		assert.equal(harness.uiInstances.length, 1, "malformed requests must never render");
		harness.uiInstances[0]!.resolve("done");
		await flush();
	}

	{
		const harness = createHarness(false);
		harness.events.emit(REQUEST, { requestId: "no-ui", title: "Child question" });
		assert.deepEqual(harness.acknowledgements, [{ requestId: "no-ui", accepted: true }]);
		assert.deepEqual(harness.results, [{ requestId: "no-ui", status: "unavailable" }]);
		assert.equal(harness.uiInstances.length, 0);
	}

	{
		const harness = createHarness();
		const modelTool = harness.tools.get("ask_user_question");
		assert.ok(modelTool);
		const modelQuestion = modelTool.execute("model", { question: "Model question" }, undefined, undefined, harness.ctx);
		await flush();
		assert.equal(harness.uiInstances.length, 1);
		harness.events.emit(REQUEST, { requestId: "child-after-model", title: "Child question" });
		await flush();
		assert.equal(harness.uiInstances.length, 1, "child question must wait behind model UI");
		harness.uiInstances[0]!.resolve("model answer");
		await modelQuestion;
		await flush();
		assert.equal(harness.uiInstances.length, 2);
		harness.uiInstances[1]!.resolve("child answer");
		await flush();
		assert.deepEqual(harness.results, [{ requestId: "child-after-model", status: "answered", answer: "child answer" }]);
	}

	{
		const harness = createHarness();
		const modelTool = harness.tools.get("ask_user_question");
		assert.ok(modelTool);
		const activeModel = modelTool.execute("active", { question: "Active model question" }, undefined, undefined, harness.ctx);
		await flush();
		harness.events.emit(REQUEST, { requestId: "child-after-escape", title: "Child question" });
		const queuedModel = modelTool.execute("queued", { question: "Queued model question" }, undefined, undefined, harness.ctx);
		await flush();
		assert.equal(harness.uiInstances.length, 1);
		harness.uiInstances[0]!.component.handleInput?.("\u001b");
		await activeModel;
		await flush();
		assert.equal(harness.uiInstances.length, 2, "model Escape must preserve queued child UI");
		harness.uiInstances[1]!.resolve("child answer");
		const queuedModelResult = await queuedModel;
		await flush();
		assert.equal((queuedModelResult as { details: { status: string } }).details.status, "cancelled");
		assert.equal(harness.uiInstances.length, 2, "model Escape must cancel queued model UI");
		assert.deepEqual(harness.results, [{ requestId: "child-after-escape", status: "answered", answer: "child answer" }]);
	}

	console.log("ask-user-question relay tests passed");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
