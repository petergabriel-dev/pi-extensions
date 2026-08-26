import assert from "node:assert/strict";
import browserExtension, { BROWSER_STATE_ENTRY, browserStatus, ensureBrowserPage, formatBrowserLaunchError, isBrowserHeadful, resolveBrowserEnabled, resolveBrowserProfilePath } from "../index.ts";

assert.equal(browserStatus(false), "Browser: OFF");
assert.equal(browserStatus(true), "Browser: ON");
assert.equal(resolveBrowserProfilePath("/agent", {}), "/agent/browser/profile");
assert.equal(resolveBrowserProfilePath("/agent", { PI_BROWSER_PROFILE: "/tmp/pi-browser-test" }), "/tmp/pi-browser-test");
assert.equal(isBrowserHeadful({ PI_BROWSER_HEADFUL: "true" }), true);
assert.equal(isBrowserHeadful({ PI_BROWSER_HEADFUL: "0" }), false);
assert.match(formatBrowserLaunchError(new Error("Executable doesn't exist")), /npx playwright install chromium/);
assert.doesNotMatch(formatBrowserLaunchError(new Error("Executable doesn't exist")), /Error:.*at /);
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
assert.deepEqual(registeredTools.sort(), ["browser_close", "browser_kill"]);
await command.handler("on", ctx);
assert.deepEqual(activeTools, ["read", "browser_close", "browser_kill"]);
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
