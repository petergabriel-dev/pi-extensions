import assert from "node:assert/strict";
import browserExtension, { BROWSER_STATE_ENTRY, browserStatus, resolveBrowserEnabled } from "../index.ts";

assert.equal(browserStatus(false), "Browser: OFF");
assert.equal(browserStatus(true), "Browser: ON");
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
	on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(event, handler); },
	appendEntry: (type: string, data: unknown) => {
		entries.push({ type, data });
		branch.push({ type: "custom", customType: type, data });
	},
} as never);

assert.ok(command);
await command.handler("on", ctx);
assert.equal(entries[0]?.type, BROWSER_STATE_ENTRY);
assert.equal((entries[0]?.data as { enabled?: unknown }).enabled, true);
assert.equal(typeof (entries[0]?.data as { at?: unknown }).at, "number");
assert.equal(notices.at(-1), "Browser: ON");

await handlers.get("session_tree")?.({}, ctx);
await command.handler("status", ctx);
assert.equal(notices.at(-1), "Browser: ON");

await handlers.get("session_start")?.({ reason: "new" }, ctx);
await command.handler("status", ctx);
assert.equal(notices.at(-1), "Browser: OFF");

console.log("browser gate assertions passed");
