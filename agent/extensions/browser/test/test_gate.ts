import assert from "node:assert/strict";
import browserExtension, { BROWSER_EVAL_GUIDANCE, BROWSER_STATE_ENTRY, BROWSER_TOOL_NAMES, RingBuffer, browserStatus, buildBrowserEvalScript, classifyBrowserEval, ensureBrowserPage, filterHeaders, formatBrowserLaunchError, headersToShow, isBrowserHeadful, normalizeHeaderNames, resolveBrowserEnabled, resolveBrowserProfilePath, serializeBrowserEvalResult, validateBrowserTimeout, validateBrowserUrl } from "../index.ts";

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
assert.deepEqual(normalizeHeaderNames([" Cookie ", "AUTHORIZATION"]), ["cookie", "authorization"]);
assert.equal(headersToShow(["Cookie"], false).has("authorization"), true);
assert.equal(headersToShow(["Cookie"], false).has("cookie"), true);
assert.deepEqual(filterHeaders({ Authorization: "secret", Cookie: "session" }, headersToShow(["cookie"], false)), { Authorization: "secret", Cookie: "session" });
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
	appendEntry: (type: string, data: unknown) => {
		entries.push({ type, data });
		branch.push({ type: "custom", customType: type, data });
	},
} as never);

assert.ok(command);
assert.deepEqual(registeredTools.sort(), ["browser_close", "browser_console", "browser_eval", "browser_goto", "browser_kill", "browser_network"]);
assert.equal(BROWSER_TOOL_NAMES.includes("browser_network"), true);
await command.handler("on", ctx);
assert.deepEqual(activeTools, ["read", "browser_goto", "browser_eval", "browser_console", "browser_network", "browser_close", "browser_kill"]);
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
