import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "build-design-prompt-"));
const stubs = join(root, "stubs");
const project = join(root, "project");
await mkdir(join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
await mkdir(join(stubs, "@earendil-works/pi-tui"), { recursive: true });
await writeFile(join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {};\n");
await writeFile(join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");

const source = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import workflowModesExtension, { BUILD_DESIGN_AWARE_PROMPT, composeModeMessage, composeWorkflowPrompt, MODE_ENTRY, MODE_LABELS, MODE_MESSAGE_TYPE, MODE_TRANSITION_MESSAGE_TYPE } from "./index.ts";
const cwd = process.env.TEST_PROJECT;
if (!cwd) throw new Error("TEST_PROJECT missing");
const absent = composeWorkflowPrompt("build", true, undefined, cwd);
if (absent?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("missing manifest injected design block");
mkdirSync(join(cwd, "docs/design"), { recursive: true });
writeFileSync(join(cwd, "docs/design/manifest.json"), "{}");
if (!composeWorkflowPrompt("build", true, undefined, cwd)?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("manifest failed to inject design block");
if (composeWorkflowPrompt("design", true, undefined, cwd)?.includes(BUILD_DESIGN_AWARE_PROMPT)) throw new Error("non-build mode used cwd");
for (const mode of ["discuss", "plan", "build", "review", "design"] as const) {
	const message = composeModeMessage(mode);
	if (message?.customType !== MODE_MESSAGE_TYPE) throw new Error(mode + " mode message customType changed");
	if (message?.content !== "[workflow-modes] Active workflow mode: " + MODE_LABELS[mode] + ".") throw new Error(mode + " mode message content invalid");
	if (message.display !== false) throw new Error(mode + " mode message must be hidden");
	if (message.content.includes("\\n")) throw new Error(mode + " mode message must be one line");
	if (message.content.split(/\\s+/).length > 40) throw new Error(mode + " mode message exceeds token proxy budget");
}
if (composeModeMessage("off") !== undefined) throw new Error("Off injected a mode message");
const handlers = new Map<string, Function>();
const commands = new Map<string, { handler: Function }>();
const operations: Array<{ action: string; type?: string; data?: unknown; message?: unknown }> = [];
let failSend = false;
workflowModesExtension({
	events: { on() {}, emit() {} },
	on(name: string, handler: Function) { handlers.set(name, handler); },
	registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
	appendEntry(type: string, data: unknown) { operations.push({ action: "append", type, data }); },
	sendMessage(message: unknown) {
		operations.push({ action: "send", message });
		if (failSend) throw new Error("send failed");
	},
} as never);
const context = {
	sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY, data: { mode: "build" } }] },
	ui: { setStatus() {}, notify() {} },
};
handlers.get("session_start")?.({}, context);
handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }).then(async (result: unknown) => {
	const value = result as { message?: ReturnType<typeof composeModeMessage>; systemPrompt?: string };
	if (value.message?.content !== "[workflow-modes] Active workflow mode: Build.") throw new Error("before_agent_start omitted active mode message");
	if (!value.systemPrompt?.startsWith("BASE")) throw new Error("before_agent_start omitted system prompt");
	operations.length = 0;
	await commands.get("mode")?.handler("off", context);
	if (operations[0]?.action !== "append" || operations[0]?.type !== MODE_ENTRY || (operations[0]?.data as { mode?: string })?.mode !== "off") throw new Error("Off mode was not persisted first");
	const transition = (operations[1]?.message ?? {}) as { customType?: string; content?: string; display?: boolean };
	if (operations[1]?.action !== "send" || transition.customType !== MODE_TRANSITION_MESSAGE_TYPE) throw new Error("Off transition message missing");
	if (transition.content !== "[workflow-modes] Active workflow mode: OFF." || transition.display !== false) throw new Error("Off transition message invalid");
	if (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }) !== undefined) throw new Error("Off injected per-turn context");
	operations.length = 0;
	await commands.get("mode")?.handler("build", context);
	if (operations.length !== 1 || operations[0]?.action !== "append") throw new Error("active mode was double-announced");
	operations.length = 0;
	failSend = true;
	let failed = false;
	try {
		await commands.get("mode")?.handler("off", context);
	} catch (error) {
		failed = error instanceof Error && error.message === "send failed";
	}
	if (!failed) throw new Error("Off send failure was not surfaced");
	if ((operations[2]?.data as { mode?: string })?.mode !== "build") throw new Error("failed Off send did not restore durable mode");
	const restored = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }) as { message?: { content?: string } };
	if (restored.message?.content !== "[workflow-modes] Active workflow mode: Build.") throw new Error("failed Off send did not restore in-memory mode");
});
`;
try {
	await execFileAsync("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, TEST_PROJECT: project },
	});
	assert.equal(existsSync(join(project, "docs/design/manifest.json")), true);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("build design prompt assertions passed");
