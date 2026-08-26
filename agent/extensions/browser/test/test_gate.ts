import assert from "node:assert/strict";
import browserExtension, { BROWSER_EVAL_GUIDANCE, BROWSER_REQUEST_EVENT, BROWSER_RESULT_EVENT, BROWSER_STATE_ENTRY, BROWSER_TOOL_NAMES, BrowserEventBus, BrowserPageRegistry, MAX_BROWSER_PAGES, PARENT_BROWSER_OWNER, RingBuffer, browserStatus, buildBrowserEvalScript, buildBrowserScreenshotPath, classifyBrowserEval, createBrowserPageState, ensureBrowserPage, filterHeaders, formatBrowserLaunchError, headersToShow, isBrowserHeadful, locateBrowserSelector, normalizeHeaderNames, parseBrowserChannelRequest, parseBrowserSelector, requestBrowserTool, resolveBrowserEnabled, resolveBrowserProfilePath, runBrowserOperation, serializeBrowserEvalResult, validateBrowserChannelTimeout, validateBrowserFillValue, validateBrowserOwner, validateBrowserSelector, validateBrowserTimeout, validateBrowserUrl } from "../index.ts";

assert.equal(browserStatus(false), "Browser: OFF");
assert.equal(browserStatus(true), "Browser: ON");
assert.equal(resolveBrowserProfilePath("/agent", {}), "/agent/extensions/browser/.profile");
assert.equal(resolveBrowserProfilePath("/agent", { PI_BROWSER_PROFILE: "/tmp/pi-browser-test" }), "/tmp/pi-browser-test");
assert.equal(isBrowserHeadful({ PI_BROWSER_HEADFUL: "true" }), true);
assert.equal(isBrowserHeadful({ PI_BROWSER_HEADFUL: "0" }), false);
assert.match(formatBrowserLaunchError(new Error("Executable doesn't exist")), /npx playwright install chromium/);
assert.doesNotMatch(formatBrowserLaunchError(new Error("Executable doesn't exist")), /Error:.*at /);
assert.equal(validateBrowserTimeout(undefined), 30_000);
assert.equal(validateBrowserTimeout(100), 100);
assert.throws(() => validateBrowserTimeout(99), /integer from 100 to 120000/);
assert.throws(() => validateBrowserTimeout(120_001), /integer from 100 to 120000/);
assert.equal(validateBrowserUrl("http://localhost:3000/"), "http://localhost:3000/");
assert.throws(() => validateBrowserUrl("ftp://localhost/file"), /http or https/);
assert.throws(() => validateBrowserUrl("x".repeat(2_049)), /at most 2048/);
assert.equal(classifyBrowserEval("document.title"), "expression");
assert.equal(classifyBrowserEval("() => document.title"), "function");
assert.equal(classifyBrowserEval("(() => document.title)()"), "iife");
assert.throws(() => classifyBrowserEval("return document.title"), new RegExp(BROWSER_EVAL_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.throws(() => classifyBrowserEval("const value = 1; value"), /multiple statements/);
assert.equal(buildBrowserEvalScript("document.title").includes("document.title"), true);
assert.equal(serializeBrowserEvalResult(undefined), null);
assert.equal(serializeBrowserEvalResult({ nodeType: 1, nodeName: "BODY" }), "ref: <Node>");
assert.deepEqual(serializeBrowserEvalResult({ value: undefined, node: { nodeType: 1, nodeName: "DIV" } }), { value: null, node: "ref: <Node>" });
const ring = new RingBuffer<number>(3);
assert.deepEqual(ring.drain(), []);
ring.push(1);
ring.push(2);
ring.push(3);
ring.push(4);
assert.deepEqual(ring.peek(), [2, 3, 4]);
assert.deepEqual(ring.drain(), [2, 3, 4]);
assert.equal(ring.length, 0);
const fullRing = new RingBuffer<number>();
for (let index = 0; index <= 1_000; index += 1) fullRing.push(index);
assert.equal(fullRing.length, 1_000);
assert.deepEqual(fullRing.peek().slice(0, 2), [1, 2]);
assert.equal(validateBrowserOwner(PARENT_BROWSER_OWNER), PARENT_BROWSER_OWNER);
assert.throws(() => validateBrowserOwner(""), /non-empty string/);
assert.throws(() => validateBrowserOwner("x".repeat(257)), /at most 256/);
assert.equal(MAX_BROWSER_PAGES, 4);
const fakePages = new Map<string, { closed: boolean; closeCount: number }>();
function fakePage(name: string) {
	const state = { closed: false, closeCount: 0 };
	fakePages.set(name, state);
	return { isClosed: () => state.closed, close: async () => { state.closed = true; state.closeCount += 1; } } as never;
}
const pageRegistry = new BrowserPageRegistry(2);
const firstPage = createBrowserPageState(fakePage("first"));
const secondPage = createBrowserPageState(fakePage("second"));
firstPage.consoleBuffer.push({ ts: 1, type: "log", text: "first" });
firstPage.networkBuffer.push({ ts: 1, method: "GET", url: "https://first.test", resourceType: "document" });
secondPage.consoleBuffer.push({ ts: 2, type: "log", text: "second" });
secondPage.networkBuffer.push({ ts: 2, method: "GET", url: "https://second.test", resourceType: "document" });
pageRegistry.set("first", firstPage);
pageRegistry.set("second", secondPage);
assert.equal(pageRegistry.size, 2);
assert.throws(() => pageRegistry.set("third", createBrowserPageState(fakePage("third"))), /cap reached/);
assert.deepEqual(firstPage.consoleBuffer.drain().map((entry) => entry.text), ["first"]);
assert.deepEqual(firstPage.networkBuffer.drain().map((entry) => entry.url), ["https://first.test"]);
assert.deepEqual(secondPage.consoleBuffer.drain().map((entry) => entry.text), ["second"]);
assert.deepEqual(secondPage.networkBuffer.drain().map((entry) => entry.url), ["https://second.test"]);
await pageRegistry.close("first");
assert.equal(pageRegistry.size, 1);
assert.equal(fakePages.get("first")?.closeCount, 1);
await pageRegistry.close("second");
assert.equal(pageRegistry.size, 0);
assert.equal(fakePages.get("second")?.closeCount, 1);
const timedOutOwners: string[] = [];
await assert.rejects(
	runBrowserOperation("child-timeout", "browser_eval", 10, () => new Promise<never>(() => undefined), undefined, async () => { timedOutOwners.push("child-timeout"); }),
	/browser_eval timed out after 10 milliseconds/,
);
assert.deepEqual(timedOutOwners, ["child-timeout"]);
const abortController = new AbortController();
const abortedOwners: string[] = [];
const aborted = runBrowserOperation("child-abort", "browser_eval", 10_000, () => new Promise<never>(() => undefined), abortController.signal, async () => { abortedOwners.push("child-abort"); });
abortController.abort();
await assert.rejects(aborted, /browser_eval aborted/);
assert.deepEqual(abortedOwners, ["child-abort"]);
assert.deepEqual(normalizeHeaderNames([" Cookie ", "AUTHORIZATION"]), ["cookie", "authorization"]);
assert.equal(headersToShow(["Cookie"], false).has("authorization"), false);
assert.equal(headersToShow(["Cookie"], false).has("apikey"), false);
assert.equal(headersToShow(["Cookie"], false).has("cookie"), true);
assert.deepEqual(filterHeaders({ Authorization: "secret", Cookie: "session" }, headersToShow(["cookie"], false)), { Cookie: "session" });
assert.equal(headersToShow(undefined, false).size, 0);
assert.equal(headersToShow(undefined, true).has("authorization"), true);
assert.equal(headersToShow(undefined, true).has("apikey"), true);
assert.equal(headersToShow(["authorization"], false).has("authorization"), true);
assert.equal(validateBrowserSelector("#submit"), "#submit");
assert.throws(() => validateBrowserSelector("x".repeat(2_049)), /at most 2048/);
assert.equal(validateBrowserFillValue("hello"), "hello");
assert.equal(parseBrowserSelector("#submit").kind, "css");
assert.deepEqual(parseBrowserSelector("text=Submit"), { kind: "text", value: "Submit" });
assert.deepEqual(parseBrowserSelector("role=button[name=Submit]"), { kind: "role", value: "button[name=Submit]" });
assert.equal(buildBrowserScreenshotPath("/tmp/pi-browser-test"), "/tmp/pi-browser-test/screenshot.png");
const selectorCalls: string[] = [];
const locator = { click: async () => undefined, fill: async () => undefined };
const selectorPage = {
	locator: (selector: string) => { selectorCalls.push(`locator:${selector}`); return locator; },
	getByText: (text: string) => { selectorCalls.push(`text:${text}`); return locator; },
};
assert.equal(locateBrowserSelector(selectorPage, "#submit"), locator);
assert.equal(locateBrowserSelector(selectorPage, "text=Submit"), locator);
assert.equal(locateBrowserSelector(selectorPage, "role=button"), locator);
assert.deepEqual(selectorCalls, ["locator:#submit", "text:Submit", "locator:role=button"]);
assert.equal(resolveBrowserEnabled([]), false);
assert.equal(resolveBrowserEnabled([
	{ type: "custom", customType: BROWSER_STATE_ENTRY, data: { enabled: true } },
	{ type: "custom", customType: BROWSER_STATE_ENTRY, data: { enabled: false } },
]), false);
assert.equal(resolveBrowserEnabled([
	{ type: "custom", customType: BROWSER_STATE_ENTRY, data: { enabled: true } },
	{ type: "custom", customType: "other", data: { enabled: false } },
]), true);

let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
const eventBus: BrowserEventBus = {
	on: (event, handler) => { const listeners = eventHandlers.get(event) ?? new Set(); listeners.add(handler); eventHandlers.set(event, listeners); },
	off: (event, handler) => { eventHandlers.get(event)?.delete(handler); },
	emit: (event, data) => { for (const handler of eventHandlers.get(event) ?? []) handler(data); },
};
const entries: Array<{ type: string; data: unknown }> = [];
const branch: unknown[] = [];
const notices: string[] = [];
const registeredTools: string[] = [];
let activeTools = ["read"];
const ctx = {
	hasUI: true,
	ui: {
		setStatus: () => undefined,
		notify: (message: string) => notices.push(message),
	},
	sessionManager: { getBranch: () => branch },
};

browserExtension({
	registerCommand: (_name: string, options: typeof command) => { command = options as typeof command; },
	registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
	getActiveTools: () => activeTools,
	getAllTools: () => registeredTools.map((name) => ({ name })),
	setActiveTools: (names: string[]) => { activeTools = names; },
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(event, handler); },
	events: eventBus,
	appendEntry: (type: string, data: unknown) => {
		entries.push({ type, data });
		branch.push({ type: "custom", customType: type, data });
	},
} as never);

assert.ok(command);
assert.deepEqual(registeredTools.sort(), ["browser_click", "browser_close", "browser_console", "browser_eval", "browser_fill", "browser_goto", "browser_kill", "browser_network", "browser_screenshot"]);
assert.equal(BROWSER_TOOL_NAMES.includes("browser_network"), true);
assert.equal(BROWSER_TOOL_NAMES.includes("browser_screenshot"), true);
await command.handler("on", ctx);
assert.deepEqual(activeTools, ["read", "browser_goto", "browser_eval", "browser_console", "browser_network", "browser_fill", "browser_click", "browser_screenshot", "browser_close", "browser_kill"]);
assert.equal(validateBrowserChannelTimeout(undefined), 1_500);
assert.throws(() => validateBrowserChannelTimeout(0), /integer from 1 to 10000/);
assert.throws(() => parseBrowserChannelRequest({ owner: "child", tool: "browser_console", params: {} }), /requestId/);
assert.throws(() => parseBrowserChannelRequest({ requestId: "bad-tool", owner: "child", tool: "unknown", params: {} }), /unknown/);
const mismatchedResult = (data: unknown) => {
	if ((data as { requestId?: unknown })?.requestId === "channel-match") eventBus.emit(BROWSER_RESULT_EVENT, { requestId: "wrong-id", owner: "child", ok: true, result: "wrong" });
};
eventBus.on(BROWSER_REQUEST_EVENT, mismatchedResult);
const channelResponse = await requestBrowserTool(eventBus, { requestId: "channel-match", owner: "child", tool: "browser_console", params: {} }, 100);
eventBus.off?.(BROWSER_REQUEST_EVENT, mismatchedResult);
assert.equal(channelResponse.requestId, "channel-match");
assert.equal(channelResponse.owner, "child");
assert.equal(channelResponse.ok, true);
const malformedResultPromise = new Promise<Record<string, unknown>>((resolve) => {
	const listener = (data: unknown) => {
		if ((data as { requestId?: unknown })?.requestId !== "malformed-tool") return;
		eventBus.off?.(BROWSER_RESULT_EVENT, listener);
		resolve(data as Record<string, unknown>);
	};
	eventBus.on(BROWSER_RESULT_EVENT, listener);
	eventBus.emit(BROWSER_REQUEST_EVENT, { requestId: "malformed-tool", owner: "child", tool: "unknown", params: {} });
});
const malformedResult = await malformedResultPromise;
assert.equal(malformedResult.ok, false);
assert.match(String(malformedResult.error), /Malformed browser request/);
await command.handler("off", ctx);
const gateOffResponse = await requestBrowserTool(eventBus, { requestId: "gate-off", owner: "child", tool: "browser_console", params: {} }, 100);
assert.equal(gateOffResponse.ok, false);
assert.match(gateOffResponse.error ?? "", /Browser gate is off/);
const silentBus: BrowserEventBus = { on: () => undefined, off: () => undefined, emit: () => undefined };
await assert.rejects(requestBrowserTool(silentBus, { requestId: "channel-timeout", owner: "child", tool: "browser_console", params: {} }, 10), /timed out after 10 milliseconds/);
await command.handler("on", ctx);
assert.equal(entries[0]?.type, BROWSER_STATE_ENTRY);
assert.equal((entries[0]?.data as { enabled?: unknown }).enabled, true);
assert.equal(typeof (entries[0]?.data as { at?: unknown }).at, "number");
assert.equal(notices.at(-1), "Browser: ON");

await handlers.get("session_tree")?.({}, ctx);
await command.handler("status", ctx);
assert.equal(notices.at(-1), "Browser: ON");

await handlers.get("session_start")?.({ reason: "new" }, ctx);
assert.deepEqual(activeTools, ["read"]);
await command.handler("status", ctx);
assert.equal(notices.at(-1), "Browser: OFF");
await assert.rejects(ensureBrowserPage, /Browser gate is off/);

console.log("browser gate assertions passed");
