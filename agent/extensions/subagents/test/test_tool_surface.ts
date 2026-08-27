import assert from "node:assert/strict";

import subagentsExtension from "../index.ts";
import {
	SubagentLaunchHost,
	type SubagentLaunchHandle,
	type SubagentLaunchOptions,
} from "../launch.ts";

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
const sentMessages: Array<{ content: string; options?: unknown }> = [];
const registeredTools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
const registeredCommands: string[] = [];
const widgetRenders: unknown[] = [];

const events = {
	on(name: string, handler: (data: unknown) => void) {
		const listeners = eventHandlers.get(name) ?? new Set();
		listeners.add(handler);
		eventHandlers.set(name, listeners);
		return () => listeners.delete(handler);
	},
	emit(name: string, data: unknown) {
		if (name === "workflow-modes:get") {
			for (const listener of eventHandlers.get("workflow-modes:state") ?? []) listener({ mode: "build", cavemanEnabled: true });
		}
		for (const listener of eventHandlers.get(name) ?? []) listener(data);
	},
};

const fakePi = {
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
		handlers.set(name, handler);
	},
	events,
	getThinkingLevel: () => "medium",
	sendUserMessage(content: string, options?: unknown) {
		sentMessages.push({ content, options });
	},
	registerCommand(name: string) {
		registeredCommands.push(name);
	},
	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) {
		registeredTools.set(tool.name, tool);
	},
};

const context = {
	cwd: process.cwd(),
	mode: "tui",
	hasUI: true,
	ui: {
		setWidget(_key: string, content: unknown) {
			widgetRenders.push(content);
		},
	},
	sessionManager: { getSessionId: () => "surface-test-session" },
	modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
};

const originalLaunch = SubagentLaunchHost.prototype.launch;
const originalResume = SubagentLaunchHost.prototype.resume;
const originalClose = SubagentLaunchHost.prototype.close;
let launched: SubagentLaunchOptions | undefined;
let resumedTask: string | undefined;
SubagentLaunchHost.prototype.launch = async function (options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
	launched = options;
	const result = Promise.resolve({ owner: options.owner, childSessionId: "child-surface", text: "surface result" });
	queueMicrotask(() => { void options.onResult?.("surface result"); });
	return {
		owner: options.owner,
		childSessionId: "child-surface",
		pid: 123,
		loadoutPath: "/tmp/surface-loadout.json",
		result,
		request: async () => undefined,
		kill: () => undefined,
	};
};
SubagentLaunchHost.prototype.resume = async function (loadoutPath, task, options): Promise<SubagentLaunchHandle> {
	resumedTask = task;
	const result = Promise.resolve({ owner: "subagent-1", childSessionId: "child-resumed", text: "resumed result" });
	queueMicrotask(() => { void options.onResult?.("resumed result"); });
	return {
		owner: "subagent-1",
		childSessionId: "child-resumed",
		pid: 124,
		loadoutPath,
		result,
		request: async () => undefined,
		kill: () => undefined,
	};
};
SubagentLaunchHost.prototype.close = async function (): Promise<void> {};

try {
	subagentsExtension(fakePi as never);
	assert.deepEqual([...registeredTools.keys()].sort(), ["subagent", "subagent_message", "subagents_list"]);
	assert.deepEqual(registeredCommands.sort(), ["subagent-effort", "subagent-model"]);
	await handlers.get("session_start")?.({}, context);

	const launchResult = await registeredTools.get("subagent")!.execute("call-1", { task: "surface task", agentScope: "project" }, new AbortController().signal, undefined, context);
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously/);
	assert.equal(launched?.owner, "subagent-1");
	assert.deepEqual(launched?.tools, ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question", "subagent"]);

	await new Promise((resolve) => setImmediate(resolve));
	const listResult = await registeredTools.get("subagents_list")!.execute("call-2", {}, new AbortController().signal, undefined, context);
	const listDetails = (listResult as { details: { agents: Array<{ status: string; result?: string }> } }).details;
	assert.equal(listDetails.agents[0]?.status, "done");
	assert.equal(listDetails.agents[0]?.result, "surface result");
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0]!.content, /surface result/);
	assert.ok(widgetRenders.length > 0);

	const resumeResult = await registeredTools.get("subagent_message")!.execute("call-3", { owner: "subagent-1", message: "resume task" }, new AbortController().signal, undefined, context);
	assert.match((resumeResult as { content: Array<{ text: string }> }).content[0]!.text, /resumed asynchronously/);
	assert.equal(resumedTask, "resume task");
	await new Promise((resolve) => setImmediate(resolve));
	const resumedList = await registeredTools.get("subagents_list")!.execute("call-4", {}, new AbortController().signal, undefined, context);
	const resumedDetails = (resumedList as { details: { agents: Array<{ status: string; result?: string }> } }).details;
	assert.equal(resumedDetails.agents[0]?.status, "done");
	assert.equal(resumedDetails.agents[0]?.result, "resumed result");
	assert.equal(sentMessages.length, 2);
	assert.match(sentMessages[1]!.content, /resumed result/);
	await handlers.get("session_shutdown")?.({}, context);
	console.log("subagent tool surface tests passed");
} finally {
	SubagentLaunchHost.prototype.launch = originalLaunch;
	SubagentLaunchHost.prototype.resume = originalResume;
	SubagentLaunchHost.prototype.close = originalClose;
}
