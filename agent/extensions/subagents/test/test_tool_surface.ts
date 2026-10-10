import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentsExtension, { requestBrowserViaParent } from "../index.ts";
import {
	SubagentFailureError,
	SubagentLaunchHost,
	type SubagentLaunchHandle,
	type SubagentLaunchOptions,
	type SubagentResult,
} from "../launch.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "subagent-tool-surface-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
const sentMessages: Array<{ content: string; options?: unknown }> = [];
const sentContextMessages: Array<{ message: { customType?: string; content?: string; display?: boolean }; options?: unknown }> = [];
const steeredMessages: Array<{ owner: string; text: string }> = [];
const answerCalls: Array<{ owner: string; questionId: string; answer: string }> = [];
const answeredQuestionKeys = new Set<string>();
const launchedByOwner = new Map<string, SubagentLaunchOptions>();
const pendingResults = new Map<string, (result: SubagentResult) => void>();
const selectCalls: Array<{ title: string; options: string[]; signal?: AbortSignal }> = [];
const inputCalls: Array<{ title: string; placeholder?: string; signal?: AbortSignal }> = [];
const selectResolvers: Array<(value: string | undefined) => void> = [];
const inputResolvers: Array<(value: string | undefined) => void> = [];
const registeredTools = new Map<string, { description?: string; execute: (...args: any[]) => Promise<unknown> }>();
let sendUserMessageFailure: Error | undefined;
const registeredCommands: string[] = [];
const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
const notifications: string[] = [];
const widgetRenders: unknown[] = [];
let browserRequest: unknown;
let overlayComponent: { handleInput?(data: string): void; render?(width: number): string[]; dispose?(): void } | undefined;
let overlayOptions: unknown;

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
	sendMessage(message: { customType?: string; content?: string; display?: boolean }, options?: unknown) {
		sentContextMessages.push({ message, options });
	},
	sendUserMessage(content: string, options?: unknown) {
		if (sendUserMessageFailure) throw sendUserMessageFailure;
		sentMessages.push({ content, options });
	},
	registerCommand(name: string, command?: { handler: (args: string, ctx: unknown) => unknown }) {
		registeredCommands.push(name);
		if (command) commandHandlers.set(name, command.handler);
	},
	registerTool(tool: { name: string; description?: string; execute: (...args: any[]) => Promise<unknown> }) {
		registeredTools.set(tool.name, tool);
	},
};

const context = {
	cwd: process.cwd(),
	mode: "tui",
	hasUI: true,
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
			selectCalls.push({ title, options: [...options], signal: opts?.signal });
			return new Promise<string | undefined>((resolve) => {
				let settled = false;
				const settle = (value: string | undefined) => {
					if (settled) return;
					settled = true;
					const index = selectResolvers.indexOf(settle);
					if (index >= 0) selectResolvers.splice(index, 1);
					resolve(value);
				};
				selectResolvers.push(settle);
				opts?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
				if (opts?.signal?.aborted) settle(undefined);
			});
		},
		input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }) {
			inputCalls.push({ title, placeholder, signal: opts?.signal });
			return new Promise<string | undefined>((resolve) => {
				let settled = false;
				const settle = (value: string | undefined) => {
					if (settled) return;
					settled = true;
					const index = inputResolvers.indexOf(settle);
					if (index >= 0) inputResolvers.splice(index, 1);
					resolve(value);
				};
				inputResolvers.push(settle);
				opts?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
				if (opts?.signal?.aborted) settle(undefined);
			});
		},
		custom<T>(factory: (...args: any[]) => unknown, options: unknown): Promise<T> {
			overlayOptions = options;
			return new Promise<T>((resolve) => {
				const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
				const theme = { fg: (_color: string, text: string) => text };
				overlayComponent = factory(tui, theme, {}, () => resolve(undefined as T)) as typeof overlayComponent;
			});
		},

		setWidget(_key: string, content: unknown) {
			widgetRenders.push(content);
		},
		notify(message: string) {
			notifications.push(message);
		},
	},
	sessionManager: { getSessionId: () => "surface-test-session" },
	modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
};

const originalLaunch = SubagentLaunchHost.prototype.launch;
const originalResume = SubagentLaunchHost.prototype.resume;
const originalReadTail = SubagentLaunchHost.prototype.readTail;
const originalClose = SubagentLaunchHost.prototype.close;
const originalAnswerQuestion = SubagentLaunchHost.prototype.answerQuestion;
const originalRedactText = SubagentLaunchHost.prototype.redactText;
let launched: SubagentLaunchOptions | undefined;
let launchHost: SubagentLaunchHost | undefined;
const surfaceTailReads: string[] = [];
let resumedTask: string | undefined;
SubagentLaunchHost.prototype.launch = async function (options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
	launched = options;
	launchHost = this;
	launchedByOwner.set(options.owner, options);
	const failing = options.task === "failure task";
	const running = options.task.startsWith("tail task") || options.task.startsWith("question task");
	const taskResultText = options.task === "delivery failure task" ? "x".repeat(3_000) : "surface result";
	const result = failing
		? Promise.reject(new SubagentFailureError(options.owner, { transport: "rpc", kind: "process", logPath: "/tmp/subagents/surface-test-session/subagent-2.log", error: "sentinel failure", tail: "sentinel output" }))
		: running
			? new Promise<SubagentResult>((resolve) => { pendingResults.set(options.owner, resolve); })
			: Promise.resolve({ owner: options.owner, childSessionId: "child-surface", text: taskResultText, sessionFile: "/tmp/sessions/child-surface.jsonl" });
	if (!failing && !running) queueMicrotask(() => { void options.onResult?.(taskResultText); });
	return {
		owner: options.owner,
		childSessionId: "child-surface",
		pid: 123,
		loadoutPath: "/tmp/surface-loadout.json",
		transport: "rpc",
		logPath: "/tmp/subagents/surface-test-session/subagent-1.log",
		sessionFile: "/tmp/sessions/child-surface.jsonl",
		result,
		request: async (_type, payload) => {
			const text = (payload as { text?: string } | undefined)?.text;
			if (text) steeredMessages.push({ owner: options.owner, text });
		},
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
		transport: "rpc",
		logPath: "/tmp/subagents/surface-test-session/subagent-1.log",
		sessionFile: "/tmp/sessions/child-surface.jsonl",
		result,
		request: async () => undefined,
		kill: () => undefined,
	};
};
SubagentLaunchHost.prototype.readTail = async function (owner: string, _lines: number): Promise<string | undefined> {
	surfaceTailReads.push(owner);
	if (owner === "subagent-4") throw new Error("surface read failed");
	return "live output";
};
SubagentLaunchHost.prototype.answerQuestion = function (owner: string, questionId: string, answer: string): boolean {
	const key = `${owner}\\u0000${questionId}`;
	if (answeredQuestionKeys.has(key)) return false;
	answeredQuestionKeys.add(key);
	answerCalls.push({ owner, questionId, answer });
	launchedByOwner.get(owner)?.onStatus?.("running");
	return true;
};
SubagentLaunchHost.prototype.redactText = function (_owner: string, text: string): string {
	return text.replaceAll("ipc-secret", "[REDACTED]");
};
SubagentLaunchHost.prototype.close = async function (): Promise<void> {};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), message);
}

function emitQuestion(owner: string, question: { questionId: string; question: string; options?: string[] }): void {
	const options = launchedByOwner.get(owner);
	assert.ok(options, `missing launch options for ${owner}`);
	options.onStatus?.("waiting");
	options.onQuestion?.(question);
}

function resolveNextSelect(value: string | undefined): void {
	const resolve = selectResolvers.shift();
	assert.ok(resolve, "no pending select dialog");
	resolve(value);
}

function resolveNextInput(value: string | undefined): void {
	const resolve = inputResolvers.shift();
	assert.ok(resolve, "no pending input dialog");
	resolve(value);
}

try {
	subagentsExtension(fakePi as never);
	assert.deepEqual([...registeredTools.keys()].sort(), ["subagent", "subagent_message", "subagents_list"]);
	assert.match(registeredTools.get("subagent")?.description ?? "", /new parent turn.*End your turn instead of polling/);
	assert.match(registeredTools.get("subagents_list")?.description ?? "", /when the user asks.*do not poll/);
	assert.match(registeredTools.get("subagent_message")?.description ?? "", /Child questions are routed to the user automatically; answer a pending question only when the user tells you to/);
	assert.deepEqual(registeredCommands.sort(), ["agents", "subagent-effort", "subagent-model"]);
	const selectCountBeforeNonTuiAgents = selectCalls.length;
	context.mode = "rpc";
	await commandHandlers.get("agents")!("", context);
	assert.match(notifications.at(-1) ?? "", /\/agents requires the interactive TUI/);
	assert.equal(selectCalls.length, selectCountBeforeNonTuiAgents);
	context.mode = "tui";
	await commandHandlers.get("subagent-effort")!("explorer inherit", context);
	let settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.subagents.effort.explorer, "inherit");
	assert.match(notifications.at(-1) ?? "", /effective: medium/);
	await commandHandlers.get("subagent-effort")!("worker inherit", context);
	settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.subagents.effort.explorer, "inherit");
	assert.equal(settings.subagents.effort.worker, undefined);
	await handlers.get("session_start")?.({}, context);

	const launchResult = await registeredTools.get("subagent")!.execute("call-1", { task: "surface task", agentScope: "project" }, new AbortController().signal, undefined, context);
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously over rpc/);
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /surface-test-session\/subagent-1\.log/);
	assert.match((launchResult as { content: Array<{ text: string }> }).content[0]!.text, /end your turn instead of polling/);
	assert.equal(launched?.owner, "subagent-1");
	assert.deepEqual(launched?.tools, ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question", "subagent", "browser_goto", "browser_eval", "browser_console", "browser_network", "browser_fill", "browser_click", "browser_screenshot", "browser_close"]);

	await new Promise((resolve) => setImmediate(resolve));
	const listResult = await registeredTools.get("subagents_list")!.execute("call-2", {}, new AbortController().signal, undefined, context);
	const listDetails = (listResult as { details: { agents: Array<{ status: string; result?: string; transport?: string; logPath?: string; sessionFile?: string }> } }).details;
	assert.equal(listDetails.agents[0]?.status, "done");
	assert.equal(listDetails.agents[0]?.transport, "rpc");
	assert.match(listDetails.agents[0]?.logPath ?? "", /surface-test-session\/subagent-1\.log/);
	assert.equal(listDetails.agents[0]?.sessionFile, "/tmp/sessions/child-surface.jsonl");
	const listText = (listResult as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(listText, /transcript=\/tmp\/sessions\/child-surface\.jsonl/);
	assert.match(listText, /subagent-1 \[done\].*result delivered as follow-up turn/);
	assert.doesNotMatch(listText, /Result:/);
	assert.equal(listDetails.agents[0]?.result, "surface result");
	const unchangedList = await registeredTools.get("subagents_list")!.execute("call-2b", {}, new AbortController().signal, undefined, context);
	const unchangedText = (unchangedList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(unchangedText, /No change since last check\. Results arrive automatically as a new turn; end your turn instead of polling\./);
	assert.match(unchangedText, /subagent-1 \[done\].*result delivered as follow-up turn/);
	assert.doesNotMatch(unchangedText, /Result:/);
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
	assert.match((failureResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously over rpc/);
	await new Promise((resolve) => setImmediate(resolve));
	const failureList = await registeredTools.get("subagents_list")!.execute("call-6", {}, new AbortController().signal, undefined, context);
	const failureAgents = (failureList as { details: { agents: Array<{ owner: string; status: string; transport?: string; logPath?: string; outputTail?: string }> } }).details.agents;
	const failureAgent = failureAgents.find((agent) => agent.owner === "subagent-2");
	assert.equal(failureAgent?.status, "failed");
	assert.equal(failureAgent?.transport, "rpc");
	assert.match(failureAgent?.logPath ?? "", /subagent-2\.log/);
	assert.equal(failureAgent?.outputTail, "sentinel output");
	assert.equal(sentMessages.length, 3);
	assert.match(sentMessages[2]!.content, /sentinel failure/);
	assert.match(sentMessages[2]!.content, /subagent-2\.log/);

	await registeredTools.get("subagent")!.execute("call-7", { task: "tail task one" }, new AbortController().signal, undefined, context);
	await registeredTools.get("subagent")!.execute("call-8", { task: "tail task two" }, new AbortController().signal, undefined, context);
	surfaceTailReads.length = 0;
	await registeredTools.get("subagents_list")!.execute("call-9", {}, new AbortController().signal, undefined, context);
	assert.deepEqual(surfaceTailReads, []);
	const liveList = await registeredTools.get("subagents_list")!.execute("call-10", { tail: true }, new AbortController().signal, undefined, context);
	assert.deepEqual(surfaceTailReads, ["subagent-3", "subagent-4"]);
	const liveAgents = (liveList as { details: { agents: Array<{ owner: string; status: string; outputTail?: string }> } }).details.agents;
	assert.equal(liveAgents.find((agent) => agent.owner === "subagent-3")?.outputTail, "live output");
	assert.equal(liveAgents.find((agent) => agent.owner === "subagent-4")?.outputTail, undefined);
	assert.equal(liveAgents.find((agent) => agent.owner === "subagent-2")?.outputTail, "sentinel output");
	assert.match((liveList as { content: Array<{ text: string }> }).content[0]!.text, /Recent output: live output/);
	const unchangedLiveList = await registeredTools.get("subagents_list")!.execute("call-11", {}, new AbortController().signal, undefined, context);
	const unchangedLiveText = (unchangedLiveList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(unchangedLiveText, /No change since last check\. Results arrive automatically as a new turn; end your turn instead of polling\./);
	assert.doesNotMatch(unchangedLiveText, /Recent output: live output/);

	sendUserMessageFailure = new Error("injected follow-up delivery failure");
	await registeredTools.get("subagent")!.execute("call-12", { task: "delivery failure task" }, new AbortController().signal, undefined, context);
	await new Promise((resolve) => setImmediate(resolve));
	sendUserMessageFailure = undefined;
	const deliveryFailureList = await registeredTools.get("subagents_list")!.execute("call-13", {}, new AbortController().signal, undefined, context);
	const deliveryFailureText = (deliveryFailureList as { content: Array<{ text: string }> }).content[0]!.text;
	const deliveryFailureAgents = (deliveryFailureList as { details: { agents: Array<{ owner: string; status: string; result?: string; error?: string }> } }).details.agents;
	const deliveryFailureAgent = deliveryFailureAgents.find((agent) => agent.owner === "subagent-5");
	assert.equal(deliveryFailureAgent?.status, "failed");
	assert.match(deliveryFailureAgent?.error ?? "", /^Result steering failed/);
	assert.ok(Buffer.byteLength(deliveryFailureAgent?.result ?? "") <= 2_000);
	assert.match(deliveryFailureText, /Result: x{50}/);
	assert.match(deliveryFailureText, /transcript=\/tmp\/sessions\/child-surface\.jsonl/);
	const deliveredResult = deliveryFailureText.match(/\n  Result: ([\s\S]*?)(?=\n  Error:|\n  Recent output:|$)/)?.[1];
	assert.ok(deliveredResult);
	assert.ok(Buffer.byteLength(deliveredResult) <= 2_000);

	const userMessageCountBeforeQuestions = sentMessages.length;
	await registeredTools.get("subagent")!.execute("call-14", { task: "question task parent" }, new AbortController().signal, undefined, context);
	const parentOwner = "subagent-6";
	emitQuestion(parentOwner, { questionId: "parent-question", question: "Pick ipc-secret?", options: ["yes", "no"] });
	await waitFor(() => selectCalls.length === 1, "first relayed select dialog");
	assert.equal(selectCalls[0]!.title, "worker subagent-6 asks: Pick [REDACTED]?");
	assert.deepEqual(selectCalls[0]!.options, ["yes", "no", "Other…"]);

	const spawnNested = (launchHost as unknown as { options: { onSpawn?: (owner: string, payload: unknown) => Promise<unknown> } }).options.onSpawn;
	assert.ok(spawnNested, "host did not expose nested spawn callback");
	const ownersBeforeNested = new Set(launchedByOwner.keys());
	let nestedSpawnError: unknown;
	const nestedSpawnResult = spawnNested(parentOwner, { agent: "explorer", task: "question task nested" }).catch((error: unknown) => { nestedSpawnError = error; });
	await waitFor(() => [...launchedByOwner.keys()].some((owner) => !ownersBeforeNested.has(owner)), "nested explorer launch");
	const nestedOwner = [...launchedByOwner.keys()].find((owner) => !ownersBeforeNested.has(owner))!;
	emitQuestion(nestedOwner, { questionId: "nested-question", question: "Which nested answer?", options: ["green", "blue"] });
	assert.equal(selectCalls.length, 1, "second question opened before FIFO dialog finished");

	resolveNextSelect("Other…");
	await waitFor(() => inputCalls.length === 1, "Other answer input dialog");
	resolveNextInput("typed ipc-secret");
	await waitFor(() => answerCalls.length === 1 && selectCalls.length === 2, "first answer and queued nested dialog");
	assert.deepEqual(answerCalls[0], { owner: parentOwner, questionId: "parent-question", answer: "typed ipc-secret" });
	assert.equal(selectCalls[1]!.title, `explorer ${nestedOwner} (via worker ${parentOwner}) asks: Which nested answer?`);
	assert.deepEqual(selectCalls[1]!.options, ["green", "blue", "Other…"]);
	assert.equal(sentContextMessages[0]?.message.customType, "subagent-question");
	assert.equal(sentContextMessages[0]?.message.display, true);
	assert.ok((sentContextMessages[0]?.message.content ?? "").includes("worker subagent-6 asked: Pick [REDACTED]?\nUser answered: typed [REDACTED]"));
	assert.doesNotMatch(sentContextMessages[0]?.message.content ?? "", /ipc-secret/);
	assert.deepEqual(sentContextMessages[0]?.options, { deliverAs: "nextTurn" });
	resolveNextSelect("blue");
	await waitFor(() => answerCalls.length === 2, "nested dialog answer");
	assert.equal(answerCalls[1]?.owner, nestedOwner);
	assert.ok((sentContextMessages[1]?.message.content ?? "").includes(`explorer ${nestedOwner} (via worker ${parentOwner}) asked: Which nested answer?\nUser answered: blue`));
	assert.equal(sentMessages.length, userMessageCountBeforeQuestions, "question relay must not send a user follow-up turn");

	const duplicateDialogAnswer = await registeredTools.get("subagent_message")!.execute("call-15", { owner: parentOwner, questionId: "parent-question", message: "late answer" }, new AbortController().signal, undefined, context);
	assert.match((duplicateDialogAnswer as { content: Array<{ text: string }> }).content[0]!.text, /already answered/);

	await registeredTools.get("subagent")!.execute("call-16", { task: "question task tool answer" }, new AbortController().signal, undefined, context);
	const toolAnswerOwner = "subagent-8";
	emitQuestion(toolAnswerOwner, { questionId: "tool-question", question: "Answer from tool?", options: ["yes", "no"] });
	await waitFor(() => selectCalls.length === 3, "third relayed select dialog");
	const toolAnswerSignal = selectCalls[2]!.signal;
	const toolAnswer = await registeredTools.get("subagent_message")!.execute("call-17", { owner: toolAnswerOwner, questionId: "tool-question", message: "answer via explicit tool" }, new AbortController().signal, undefined, context);
	assert.match((toolAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);
	assert.equal(toolAnswerSignal?.aborted, true, "subagent_message must dismiss active dialog");
	const duplicateToolAnswer = await registeredTools.get("subagent_message")!.execute("call-18", { owner: toolAnswerOwner, questionId: "tool-question", message: "second answer" }, new AbortController().signal, undefined, context);
	assert.match((duplicateToolAnswer as { content: Array<{ text: string }> }).content[0]!.text, /already answered/);

	await registeredTools.get("subagent")!.execute("call-19", { task: "question task dismissed" }, new AbortController().signal, undefined, context);
	const dismissedOwner = "subagent-9";
	emitQuestion(dismissedOwner, { questionId: "dismissed-question", question: "Dismiss then answer" });
	await waitFor(() => inputCalls.length === 2, "free-text question dialog");
	resolveNextInput(undefined);
	await waitFor(() => notifications.some((message) => message.includes("answer later with /agents")), "pending question notice after dismissal");
	const dismissedList = await registeredTools.get("subagents_list")!.execute("call-20", {}, new AbortController().signal, undefined, context);
	const dismissedAgents = (dismissedList as { details: { agents: Array<{ owner: string; status: string; question?: { questionId: string } }> } }).details.agents;
	assert.equal(dismissedAgents.find((agent) => agent.owner === dismissedOwner)?.status, "waiting");
	assert.equal(dismissedAgents.find((agent) => agent.owner === dismissedOwner)?.question?.questionId, "dismissed-question");
	assert.ok((dismissedList as { content: Array<{ text: string }> }).content[0]!.text.includes("? question-pending=dismissed-question"));
	const dismissedAnswer = await registeredTools.get("subagent_message")!.execute("call-21", { owner: dismissedOwner, questionId: "dismissed-question", message: "answer later" }, new AbortController().signal, undefined, context);
	assert.match((dismissedAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);

	context.hasUI = false;
	await registeredTools.get("subagent")!.execute("call-22", { task: "question task no-ui" }, new AbortController().signal, undefined, context);
	const noUiOwner = "subagent-10";
	emitQuestion(noUiOwner, { questionId: "no-ui-question", question: "No UI available" });
	assert.equal(selectCalls.length, 3);
	assert.equal(inputCalls.length, 2);
	assert.ok((notifications.at(-1) ?? "").includes("answer later with /agents"));
	const noUiAnswer = await registeredTools.get("subagent_message")!.execute("call-23", { owner: noUiOwner, questionId: "no-ui-question", message: "answer without UI" }, new AbortController().signal, undefined, context);
	assert.match((noUiAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);
	assert.equal(sentMessages.length, userMessageCountBeforeQuestions, "question handling must not prompt parent model");
	assert.equal(sentContextMessages.length, 5);
	assert.ok(sentContextMessages.every(({ options }) => JSON.stringify(options) === JSON.stringify({ deliverAs: "nextTurn" })));

	context.hasUI = true;
	const openAgentsOverlay = commandHandlers.get("agents")!("", context) as Promise<void>;
	await waitFor(() => selectCalls.length === 4, "agents child picker");
	assert.ok(selectCalls[3]!.options.some((option) => option.startsWith(`  ${nestedOwner} — explorer [running]`)), "picker should indent nested children");
	const selectedAgent = selectCalls[3]!.options.find((option) => option.includes("subagent-3 — worker [running]"));
	assert.ok(selectedAgent, "picker should list running children");
	resolveNextSelect(selectedAgent);
	await waitFor(() => overlayComponent !== undefined, "agents overlay");
	assert.deepEqual(overlayOptions, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 } });
	for (const character of "hello ipc-secret") overlayComponent!.handleInput?.(character);
	assert.doesNotMatch(overlayComponent?.render?.(80)?.join("\n") ?? "", /ipc-secret/, "overlay input must redact the IPC token");
	overlayComponent!.handleInput?.("\r");
	await waitFor(() => sentContextMessages.some(({ message }) => message.customType === "subagent-steer"), "steer parent note");
	assert.deepEqual(steeredMessages.at(-1), { owner: "subagent-3", text: "hello ipc-secret" });
	assert.deepEqual(sentContextMessages.at(-1), {
		message: { customType: "subagent-steer", content: "User told subagent-3: hello [REDACTED]", display: true },
		options: { deliverAs: "nextTurn" },
	});
	overlayComponent!.handleInput?.("\u001b");
	await openAgentsOverlay;

	const questionOwners = [parentOwner, nestedOwner, toolAnswerOwner, dismissedOwner, noUiOwner];
	for (const owner of questionOwners) {
		const resolve = pendingResults.get(owner);
		pendingResults.delete(owner);
		resolve?.({ owner, childSessionId: `child-${owner}`, text: `${owner} done` });
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(nestedSpawnError, undefined);
	await nestedSpawnResult;
	await handlers.get("session_shutdown")?.({}, context);
	console.log("subagent tool surface tests passed");
} finally {
	SubagentLaunchHost.prototype.launch = originalLaunch;
	SubagentLaunchHost.prototype.resume = originalResume;
	SubagentLaunchHost.prototype.readTail = originalReadTail;
	SubagentLaunchHost.prototype.answerQuestion = originalAnswerQuestion;
	SubagentLaunchHost.prototype.redactText = originalRedactText;
	SubagentLaunchHost.prototype.close = originalClose;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
}
