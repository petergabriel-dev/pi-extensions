import assert from "node:assert/strict";

import subagentsExtension, { requestBrowserViaParent } from "../index.ts";
import {
	SubagentFailureError,
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
let browserRequest: unknown;

const events = {
	on(name: string, handler: (data: unknown) => void) {
		const listeners = eventHandlers.get(name) ?? new Set();
		listeners.add(handler);
		eventHandlers.set(name, listeners);
		return () => listeners.delete(handler);
	},
	emit(name: string, data: unknown) {
		if (name === "browser:request") {
			browserRequest = data;
			const request = data as { requestId: string; owner: string };
			for (const listener of eventHandlers.get("browser:result") ?? []) listener({ requestId: request.requestId, owner: request.owner, ok: true, result: { content: [{ type: "text", text: "browser result" }], details: {} } });
		}
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
	const failing = options.task === "failure task";
	const result = failing
		? Promise.reject(new SubagentFailureError(options.owner, { transport: "cmux", logPath: "/tmp/subagents/surface-test-session/subagent-2.log", error: "sentinel failure", tail: "sentinel output" }))
		: Promise.resolve({ owner: options.owner, childSessionId: "child-surface", text: "surface result" });
	if (!failing) queueMicrotask(() => { void options.onResult?.("surface result"); });
	return {
		owner: options.owner,
		childSessionId: "child-surface",
		pid: 123,
		loadoutPath: "/tmp/surface-loadout.json",
		transport: "cmux",
		logPath: "/tmp/subagents/surface-test-session/subagent-1.log",
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
		transport: "cmux",
		logPath: "/tmp/subagents/surface-test-session/subagent-1.log",
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
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously over cmux/);
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /surface-test-session\/subagent-1\.log/);
	assert.equal(launched?.owner, "subagent-1");
	assert.deepEqual(launched?.tools, ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question", "subagent", "browser_goto", "browser_eval", "browser_console", "browser_network", "browser_fill", "browser_click", "browser_screenshot", "browser_close"]);

	await new Promise((resolve) => setImmediate(resolve));
	const listResult = await registeredTools.get("subagents_list")!.execute("call-2", {}, new AbortController().signal, undefined, context);
	const listDetails = (listResult as { details: { agents: Array<{ status: string; result?: string; transport?: string; logPath?: string }> } }).details;
	assert.equal(listDetails.agents[0]?.status, "done");
	assert.equal(listDetails.agents[0]?.transport, "cmux");
	assert.match(listDetails.agents[0]?.logPath ?? "", /surface-test-session\/subagent-1\.log/);
	assert.equal(listDetails.agents[0]?.result, "surface result");
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0]!.content, /surface result/);
	assert.ok(widgetRenders.length > 0);
	await requestBrowserViaParent(fakePi as never, "subagent-1", { tool: "browser_network", params: { clear: true } }, true);
	assert.equal((browserRequest as { params: { clear: boolean } }).params.clear, false);

	const resumeResult = await registeredTools.get("subagent_message")!.execute("call-3", { owner: "subagent-1", message: "resume task" }, new AbortController().signal, undefined, context);
	assert.match((resumeResult as { content: Array<{ text: string }> }).content[0]!.text, /resumed asynchronously/);
	assert.equal(resumedTask, "resume task");
	await new Promise((resolve) => setImmediate(resolve));
	const resumedList = await registeredTools.get("subagents_list")!.execute("call-4", {}, new AbortController().signal, undefined, context);
	const resumedDetails = (resumedList as { details: { agents: Array<{ status: string; result?: string; transport?: string; logPath?: string }> } }).details;
	assert.equal(resumedDetails.agents[0]?.status, "done");
	assert.equal(resumedDetails.agents[0]?.result, "resumed result");
	assert.equal(sentMessages.length, 2);
	assert.match(sentMessages[1]!.content, /resumed result/);

	const failureResult = await registeredTools.get("subagent")!.execute("call-5", { task: "failure task" }, new AbortController().signal, undefined, context);
	assert.match((failureResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously over cmux/);
	await new Promise((resolve) => setImmediate(resolve));
	const failureList = await registeredTools.get("subagents_list")!.execute("call-6", {}, new AbortController().signal, undefined, context);
	const failureAgents = (failureList as { details: { agents: Array<{ owner: string; status: string; transport?: string; logPath?: string; outputTail?: string }> } }).details.agents;
	const failureAgent = failureAgents.find((agent) => agent.owner === "subagent-2");
	assert.equal(failureAgent?.status, "failed");
	assert.equal(failureAgent?.transport, "cmux");
	assert.match(failureAgent?.logPath ?? "", /subagent-2\.log/);
	assert.equal(failureAgent?.outputTail, "sentinel output");
	assert.equal(sentMessages.length, 3);
	assert.match(sentMessages[2]!.content, /sentinel failure/);
	assert.match(sentMessages[2]!.content, /subagent-2\.log/);
	await handlers.get("session_shutdown")?.({}, context);
	console.log("subagent tool surface tests passed");
} finally {
	SubagentLaunchHost.prototype.launch = originalLaunch;
	SubagentLaunchHost.prototype.resume = originalResume;
	SubagentLaunchHost.prototype.close = originalClose;
}
