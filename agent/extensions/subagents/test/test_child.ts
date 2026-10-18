import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import subagentChildExtension from "../child.ts";
import { resolveSubagentSocketPath, SubagentIpcServer } from "../ipc.ts";
import type { SubagentLoadout } from "../launch.ts";
import { MAX_SUBAGENT_DEPTH } from "../policy.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-child-"));
const socketPath = resolveSubagentSocketPath("child-test", tempDir);
const previous = {
	socket: process.env.PI_SUBAGENT_SOCKET,
	token: process.env.PI_SUBAGENT_TOKEN,
	owner: process.env.PI_SUBAGENT_OWNER,
	child: process.env.PI_SUBAGENT_CHILD_SESSION_ID,
	loadout: process.env.PI_SUBAGENT_LOADOUT,
};
interface RegisteredTool {
	description: string;
	parameters: unknown;
	execute: (...args: any[]) => Promise<unknown>;
}

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const tools = new Map<string, RegisteredTool>();
const requestTypes: string[] = [];
const nestedRequests: unknown[] = [];
const browserCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
let browserCloseCount = 0;
let resolveSlowBrowserStart!: () => void;
let resolveBrowserClose!: () => void;
let resolvePreAbortedBrowserStart!: () => void;
let resolvePreAbortedBrowserClose!: () => void;
const slowBrowserStarted = new Promise<void>((resolve) => { resolveSlowBrowserStart = resolve; });
const browserCloseRequested = new Promise<void>((resolve) => { resolveBrowserClose = resolve; });
const preAbortedBrowserStarted = new Promise<void>((resolve) => { resolvePreAbortedBrowserStart = resolve; });
const preAbortedBrowserCloseRequested = new Promise<void>((resolve) => { resolvePreAbortedBrowserClose = resolve; });

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makePi(
	toolMap = new Map<string, RegisteredTool>(),
	handlerMap = new Map<string, (event: unknown, ctx: unknown) => unknown>(),
) {
	return {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlerMap.set(name, handler);
		},
		registerTool(tool: { name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<unknown> }) {
			toolMap.set(tool.name, tool);
		},
	};
}

const loadoutPath = path.join(tempDir, "loadout.json");
const loadout: SubagentLoadout = {
	version: 1,
	parentSessionId: "child-test",
	childSessionId: "child-session",
	owner: "child-owner",
	role: "worker",
	agentName: "worker",
	cwd: process.cwd(),
	extensionPath: "child.ts",
	tools: ["read", "ask_question", "subagent", "browser_console", "browser_close", "browser_eval"],
	projectTrusted: false,
	appendSystemPrompt: "Agent rules",
	cavemanEnabled: true,
	depth: 0,
	subagentAgents: ["explorer"],
	createdAt: new Date().toISOString(),
};
fs.writeFileSync(loadoutPath, JSON.stringify(loadout));

const server = new SubagentIpcServer({
	socketPath,
	onRequest: async (request) => {
		requestTypes.push(request.type);
		if (request.type === "spawn") {
			nestedRequests.push(request.payload);
			if (isRecord(request.payload) && request.payload.task === "fail") throw new Error("Nested spawn failed.");
			return { owner: "nested-owner", childSessionId: "nested-child", text: "nested result" };
		}
		if (request.type === "browser" && isRecord(request.payload) && typeof request.payload.tool === "string") {
			const tool = request.payload.tool;
			const params = isRecord(request.payload.params) ? request.payload.params : {};
			browserCalls.push({ tool, params });
			if (tool === "browser_eval" && params.expression === "gate-off") throw new Error("Browser gate is off. Run /browser on first.");
			if (tool === "browser_eval") {
				if (params.expression === "pre-aborted") resolvePreAbortedBrowserStart();
				else resolveSlowBrowserStart();
				return new Promise(() => undefined);
			}
			if (tool === "browser_close") {
				if (browserCloseCount++ === 0) resolveBrowserClose();
				else resolvePreAbortedBrowserClose();
				return { accepted: true };
			}
			if (tool === "browser_console") return { content: [{ type: "text", text: "browser result" }], details: { ok: true } };
		}
		return undefined;
	},
});
const childToken = server.registerRun("child-owner");

process.env.PI_SUBAGENT_SOCKET = socketPath;
process.env.PI_SUBAGENT_TOKEN = childToken;
process.env.PI_SUBAGENT_OWNER = "child-owner";
process.env.PI_SUBAGENT_CHILD_SESSION_ID = "child-session";
process.env.PI_SUBAGENT_LOADOUT = loadoutPath;

try {
	const noEnvHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const noEnvTools = new Map<string, RegisteredTool>();
	const noEnvPi = makePi(noEnvTools, noEnvHandlers);
	delete process.env.PI_SUBAGENT_TOKEN;
	subagentChildExtension(noEnvPi as never);
	assert.equal(noEnvHandlers.size, 0);
	assert.equal(noEnvTools.size, 0);
	process.env.PI_SUBAGENT_TOKEN = childToken;

	await server.listen();
	subagentChildExtension(makePi(tools, handlers) as never);
	assert.deepEqual([...tools.keys()].sort(), ["ask_question", "browser_close", "browser_console", "browser_eval", "subagent"]);
	for (const [name, tool] of tools) {
		if (name.startsWith("browser_")) assert.ok(tool.description.includes("/browser on"), `${name} description must name /browser on`);
	}
	assert.equal(handlers.size, 0);
	assert.equal(server.getConnection("child-owner"), undefined);

	const selectCalls: unknown[][] = [];
	const inputCalls: unknown[][] = [];
	const answeringContext = {
		ui: {
			select: async (...args: [string, string[]]) => { selectCalls.push(args); return "yes"; },
			input: async (...args: [string]) => { inputCalls.push(args); return "free answer"; },
		},
	};
	const askQuestion = tools.get("ask_question")!.execute;
	const selected = await askQuestion("question-select", { question: " Choose? ", options: [" yes ", " no "] }, undefined, undefined, answeringContext);
	assert.deepEqual((selected as { content: Array<{ text: string }> }).content[0], { type: "text", text: "yes" });
	const typed = await askQuestion("question-input", { question: " Give details? " }, undefined, undefined, answeringContext);
	assert.deepEqual((typed as { content: Array<{ text: string }> }).content[0], { type: "text", text: "free answer" });
	assert.deepEqual(selectCalls, [["Choose?", ["yes", "no"]]]);
	assert.deepEqual(inputCalls, [["Give details?"]]);
	assert.equal(server.getConnection("child-owner"), undefined);

	await assert.rejects(
		askQuestion("question-cancel-select", { question: "Choose?", options: ["yes"] }, undefined, undefined, { ui: { select: async () => undefined } }),
		/cancelled/,
	);
	await assert.rejects(
		askQuestion("question-cancel-input", { question: "Type?" }, undefined, undefined, { ui: { input: async () => undefined } }),
		/cancelled/,
	);

	const nestedResult = await tools.get("subagent")!.execute("nested-call", { agent: "explorer", task: " inspect " }, undefined, undefined, {});
	assert.deepEqual((nestedResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "nested result" });
	assert.deepEqual(nestedRequests, [{ agent: "explorer", task: "inspect" }]);
	assert.ok(server.getConnection("child-owner"));

	await assert.rejects(
		tools.get("subagent")!.execute("nested-refused", { agent: "worker", task: "inspect" }, undefined, undefined, {}),
		/allowed child agents/,
	);
	await assert.rejects(
		tools.get("subagent")!.execute("nested-failed", { agent: "explorer", task: "fail" }, undefined, undefined, {}),
		/Nested subagent failed: Nested spawn failed\./,
	);
	const browserResult = await tools.get("browser_console")!.execute("browser-call", { clear: false }, undefined, undefined, {});
	assert.deepEqual((browserResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "browser result" });
	await assert.rejects(
		tools.get("browser_eval")!.execute("browser-gate-off", { expression: "gate-off" }, undefined, undefined, {}),
		/browser_eval failed: Browser gate is off/,
	);

	const browserAbort = new AbortController();
	const abortedBrowserCall = tools.get("browser_eval")!.execute("browser-abort", { expression: "1 + 1" }, browserAbort.signal, undefined, {});
	const abortedBrowserRejected = assert.rejects(abortedBrowserCall, /aborted/);
	await slowBrowserStarted;
	browserAbort.abort();
	await abortedBrowserRejected;
	await browserCloseRequested;
	assert.ok(browserCalls.some((call) => call.tool === "browser_close"));
	const preAbortedBrowser = new AbortController();
	preAbortedBrowser.abort();
	const preAbortedBrowserCall = tools.get("browser_eval")!.execute("browser-pre-aborted", { expression: "pre-aborted" }, preAbortedBrowser.signal, undefined, {});
	const preAbortedBrowserRejected = assert.rejects(preAbortedBrowserCall, /aborted/);
	await Promise.all([preAbortedBrowserStarted, preAbortedBrowserCloseRequested, preAbortedBrowserRejected]);
	assert.deepEqual(requestTypes.filter((type) => type === "question" || type === "activity" || type === "result" || type === "message"), []);

	const maxDepthOwner = "max-depth-owner";
	const maxDepthToken = server.registerRun(maxDepthOwner);
	const maxDepthLoadout: SubagentLoadout = {
		...loadout,
		owner: maxDepthOwner,
		childSessionId: "max-depth-child",
		tools: ["read", "ask_question", "browser_console"],
		depth: MAX_SUBAGENT_DEPTH,
	};
	fs.writeFileSync(loadoutPath, JSON.stringify(maxDepthLoadout));
	process.env.PI_SUBAGENT_TOKEN = maxDepthToken;
	process.env.PI_SUBAGENT_OWNER = maxDepthOwner;
	process.env.PI_SUBAGENT_CHILD_SESSION_ID = "max-depth-child";
	const maxDepthTools = new Map<string, RegisteredTool>();
	subagentChildExtension(makePi(maxDepthTools) as never);
	assert.deepEqual([...maxDepthTools.keys()].sort(), ["ask_question", "browser_console"]);
	assert.equal(server.getConnection(maxDepthOwner), undefined);

	console.log("subagent child tests passed");
} finally {
	await server.close();
	for (const [key, value] of Object.entries(previous)) {
		const envKey = key === "socket" ? "PI_SUBAGENT_SOCKET" : key === "token" ? "PI_SUBAGENT_TOKEN" : key === "owner" ? "PI_SUBAGENT_OWNER" : key === "child" ? "PI_SUBAGENT_CHILD_SESSION_ID" : "PI_SUBAGENT_LOADOUT";
		if (value === undefined) delete process.env[envKey];
		else process.env[envKey] = value;
	}
	fs.rmSync(tempDir, { recursive: true, force: true });
}
