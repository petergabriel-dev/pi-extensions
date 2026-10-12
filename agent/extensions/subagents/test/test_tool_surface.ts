import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const localWorkerPath = join(agentDir, "agents", "worker.md");
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(localWorkerPath, "---\nname: worker\ndescription: local worker override\ntools: read, bash, edit, write, grep, find, ls\nsubagent_agents: explorer\n---\n\nLocal worker prompt.\n");
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
const pendingFailures = new Map<string, (error: Error) => void>();
const shutdownFailureOwners = new Set<string>();
const ASK_QUESTION_REQUEST_EVENT = "ask-user-question:request";
const ASK_QUESTION_ACK_EVENT = "ask-user-question:ack";
const ASK_QUESTION_RESULT_EVENT = "ask-user-question:result";
const ASK_QUESTION_CANCEL_EVENT = "ask-user-question:cancel";
interface QuestionUiRequest {
	requestId: string;
	title: string;
	options?: string[];
}
const questionRequests: QuestionUiRequest[] = [];
const visibleQuestionRequestIds: string[] = [];
const modelQueuedQuestionRequestIds: string[] = [];
const questionCancels: string[] = [];
let questionUiOwnerAvailable = true;
let modelQuestionOpen = false;
const selectCalls: Array<{ title: string; options: string[]; signal?: AbortSignal }> = [];
const selectResolvers: Array<(value: string | undefined) => void> = [];
const registeredTools = new Map<string, { description?: string; execute: (...args: any[]) => Promise<unknown> }>();
let sendUserMessageFailure: Error | undefined;
let editorText = "";
const registeredCommands: string[] = [];
const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
const notifications: string[] = [];
const workerShadowWarnings = (): string[] => notifications.filter((message) => message.includes(`Local agent ${localWorkerPath} overrides bundled worker`));
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
		if (name === ASK_QUESTION_REQUEST_EVENT) {
			const request = data as QuestionUiRequest;
			questionRequests.push({ ...request, options: request.options ? [...request.options] : undefined });
			if (questionUiOwnerAvailable) {
				for (const listener of eventHandlers.get(ASK_QUESTION_ACK_EVENT) ?? []) listener({ requestId: request.requestId, accepted: true });
				if (modelQuestionOpen) modelQueuedQuestionRequestIds.push(request.requestId);
				else visibleQuestionRequestIds.push(request.requestId);
			}
		}
		if (name === ASK_QUESTION_CANCEL_EVENT) questionCancels.push((data as { requestId: string }).requestId);
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
		getEditorText() {
			return editorText;
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
	const failing = options.task.startsWith("failure task");
	const shutdownFailure = options.task === "shutdown failure task";
	const running = options.task.startsWith("tail task") || options.task.startsWith("question task") || options.task.startsWith("editor result") || options.task.startsWith("edited editor result") || options.task.startsWith("empty editor result") || shutdownFailure;
	const taskResultText = options.task === "delivery failure task" ? "x".repeat(3_000) : "surface result";
	const result = failing
		? Promise.reject(new SubagentFailureError(options.owner, { transport: "rpc", kind: "process", logPath: `/tmp/subagents/surface-test-session/${options.owner}.log`, error: "sentinel failure", tail: "sentinel output" }))
		: running
			? new Promise<SubagentResult>((resolve, reject) => {
				pendingResults.set(options.owner, resolve);
				if (shutdownFailure) {
					pendingFailures.set(options.owner, reject);
					shutdownFailureOwners.add(options.owner);
				}
			})
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
SubagentLaunchHost.prototype.close = async function (): Promise<void> {
	for (const owner of shutdownFailureOwners) {
		pendingFailures.get(owner)?.(new Error(`Subagent ${owner} host closed.`));
		pendingFailures.delete(owner);
		pendingResults.delete(owner);
	}
	shutdownFailureOwners.clear();
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), message);
}

function emitMessageStart(message: unknown): void {
	handlers.get("message_start")?.({ type: "message_start", message }, context);
}

function emitAgentSettled(): void {
	handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
}

function completePendingResult(owner: string, text: string): void {
	const resolve = pendingResults.get(owner);
	assert.ok(resolve, `missing pending result for ${owner}`);
	pendingResults.delete(owner);
	resolve({ owner, childSessionId: `child-${owner}`, text });
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

function resolveQuestionRequest(requestId: string, status: "answered" | "dismissed" | "cancelled" | "unavailable", answer?: string): void {
	events.emit(ASK_QUESTION_RESULT_EVENT, { requestId, status, ...(answer === undefined ? {} : { answer }) });
}

function finishModelQuestion(): void {
	modelQuestionOpen = false;
	visibleQuestionRequestIds.push(...modelQueuedQuestionRequestIds.splice(0));
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
	const pendingDeliveryList = await registeredTools.get("subagents_list")!.execute("call-2-pending", {}, new AbortController().signal, undefined, context);
	const pendingDeliveryText = (pendingDeliveryList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(pendingDeliveryText, /subagent-1 \[done\].*result pending delivery/);
	assert.ok(pendingDeliveryText.includes("Result: Subagent subagent-1 finished.\n\nsurface result"));
	assert.doesNotMatch(pendingDeliveryText, /result delivered/);
	assert.equal(sentMessages.length, 1);
	emitMessageStart({ role: "user", content: sentMessages[0]!.content });
	emitAgentSettled();
	assert.equal(sentContextMessages.filter(({ message }) => message.customType === "subagent-result").length, 0, "receipt prevents nextTurn redelivery");
	const listResult = await registeredTools.get("subagents_list")!.execute("call-2", {}, new AbortController().signal, undefined, context);
	const listDetails = (listResult as { details: { agents: Array<{ status: string; result?: string; transport?: string; logPath?: string; sessionFile?: string }> } }).details;
	assert.equal(listDetails.agents[0]?.status, "done");
	assert.equal(listDetails.agents[0]?.transport, "rpc");
	assert.match(listDetails.agents[0]?.logPath ?? "", /surface-test-session\/subagent-1\.log/);
	assert.equal(listDetails.agents[0]?.sessionFile, "/tmp/sessions/child-surface.jsonl");
	const listText = (listResult as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(listText, /transcript=\/tmp\/sessions\/child-surface\.jsonl/);
	assert.match(listText, /subagent-1 \[done\].*result delivered/);
	assert.doesNotMatch(listText, /result pending delivery|Result:/);
	assert.equal(listDetails.agents[0]?.result, "surface result");
	const unchangedList = await registeredTools.get("subagents_list")!.execute("call-2b", {}, new AbortController().signal, undefined, context);
	const unchangedText = (unchangedList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(unchangedText, /No change since last check\. Results arrive automatically as a new turn; end your turn instead of polling\./);
	assert.match(unchangedText, /subagent-1 \[done\].*result delivered/);
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
	assert.equal(sentMessages.length, 2);
	assert.match(sentMessages[1]!.content, /resumed result/);
	emitMessageStart({ role: "user", content: sentMessages[1]!.content });
	emitAgentSettled();
	const resumedList = await registeredTools.get("subagents_list")!.execute("call-4", {}, new AbortController().signal, undefined, context);
	const resumedDetails = (resumedList as { details: { agents: Array<{ status: string; result?: string; transport?: string; logPath?: string }> } }).details;
	assert.equal(resumedDetails.agents[0]?.status, "done");
	assert.equal(resumedDetails.agents[0]?.result, "resumed result");
	assert.match((resumedList as { content: Array<{ text: string }> }).content[0]!.text, /result delivered/);
	assert.doesNotMatch((resumedList as { content: Array<{ text: string }> }).content[0]!.text, /resumed result/);

	const failureResult = await registeredTools.get("subagent")!.execute("call-5", { task: "failure task" }, new AbortController().signal, undefined, context);
	assert.match((failureResult as { content: Array<{ text: string }> }).content[0]!.text, /started asynchronously over rpc/);
	await new Promise((resolve) => setImmediate(resolve));
	const failurePendingList = await registeredTools.get("subagents_list")!.execute("call-6-pending", {}, new AbortController().signal, undefined, context);
	const failurePendingText = (failurePendingList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(failurePendingText, /subagent-2 \[failed\].*result pending delivery/);
	assert.ok(failurePendingText.includes("Subagent subagent-2 failed."));
	emitMessageStart({ role: "user", content: sentMessages[2]!.content });
	emitAgentSettled();
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
	assert.equal(workerShadowWarnings().length, 1);
	assert.match(workerShadowWarnings()[0] ?? "", /missing: model/);
	assert.match(workerShadowWarnings()[0] ?? "", /Fix: add missing keys from .*agent\/agents\/worker\.md/);

	await registeredTools.get("subagent")!.execute("call-7", { task: "tail task one" }, new AbortController().signal, undefined, context);
	assert.equal(workerShadowWarnings().length, 1, "same local override must warn only once per session across subagent calls");
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
	assert.equal(deliveryFailureAgent?.status, "done");
	assert.match(deliveryFailureAgent?.error ?? "", /^Result steering failed/);
	assert.ok(Buffer.byteLength(deliveryFailureAgent?.result ?? "") <= 2_000);
	assert.match(deliveryFailureText, /result pending delivery/);
	assert.match(deliveryFailureText, /Result: Subagent subagent-5 finished\.\n\nx{50}/);
	assert.match(deliveryFailureText, /transcript=\/tmp\/sessions\/child-surface\.jsonl/);
	const pendingDeliveryBody = deliveryFailureText.match(/\n  Result: ([\s\S]*?)(?=\n  Error:|\n  Recent output:|$)/)?.[1];
	assert.ok(pendingDeliveryBody);
	assert.ok(Buffer.byteLength(pendingDeliveryBody) <= 2_000);

	const resultMessagesBeforeRedelivery = sentContextMessages.filter(({ message }) => message.customType === "subagent-result").length;
	emitAgentSettled();
	const redeliveryMessages = sentContextMessages.filter(({ message }) => message.customType === "subagent-result");
	assert.equal(redeliveryMessages.length, resultMessagesBeforeRedelivery + 1);
	assert.equal(redeliveryMessages.at(-1)?.message.display, true);
	assert.deepEqual(redeliveryMessages.at(-1)?.options, { deliverAs: "nextTurn" });
	emitAgentSettled();
	assert.equal(sentContextMessages.filter(({ message }) => message.customType === "subagent-result").length, resultMessagesBeforeRedelivery + 1, "second settle must not duplicate nextTurn message");
	assert.equal(sentMessages.length, 3, "nextTurn re-delivery must not start a parent turn");
	emitMessageStart({ role: "custom", customType: "subagent-result", content: redeliveryMessages.at(-1)!.message.content });
	const deliveredFallbackList = await registeredTools.get("subagents_list")!.execute("call-13-delivered", {}, new AbortController().signal, undefined, context);
	const deliveredFallbackText = (deliveredFallbackList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(deliveredFallbackText, /subagent-5 \[done\].*result delivered/);
	assert.doesNotMatch(deliveredFallbackText, /result pending delivery|Result:/);

	const userMessageCountBeforeQuestions = sentMessages.length;
	const contextMessageCountBeforeQuestions = sentContextMessages.length;
	const selectCountBeforeQuestions = selectCalls.length;
	await registeredTools.get("subagent")!.execute("call-14", { task: "question task parent" }, new AbortController().signal, undefined, context);
	const parentOwner = "subagent-6";
	emitQuestion(parentOwner, { questionId: "parent-question", question: "Pick ipc-secret?", options: ["ipc-secret yes", "no"] });
	await waitFor(() => questionRequests.length === 1, "parent question request to owner");
	const parentRequest = questionRequests[0]!;
	assert.equal(parentRequest.title, "worker subagent-6 asks: Pick [REDACTED]?");
	assert.deepEqual(parentRequest.options, ["[REDACTED] yes", "no"]);
	assert.ok(visibleQuestionRequestIds.includes(parentRequest.requestId));

	const spawnNested = (launchHost as unknown as { options: { onSpawn?: (owner: string, payload: unknown) => Promise<unknown> } }).options.onSpawn;
	assert.ok(spawnNested, "host did not expose nested spawn callback");
	const ownersBeforeNested = new Set(launchedByOwner.keys());
	let nestedSpawnError: unknown;
	const nestedSpawnResult = spawnNested(parentOwner, { agent: "explorer", task: "question task nested" }).catch((error: unknown) => { nestedSpawnError = error; });
	await waitFor(() => [...launchedByOwner.keys()].some((owner) => !ownersBeforeNested.has(owner)), "nested explorer launch");
	const nestedOwner = [...launchedByOwner.keys()].find((owner) => !ownersBeforeNested.has(owner))!;
	emitQuestion(nestedOwner, { questionId: "nested-question", question: "Which nested answer?", options: ["green", "blue"] });
	assert.equal(questionRequests.length, 1, "second question reached owner before FIFO dialog finished");
	assert.equal(selectCalls.length, selectCountBeforeQuestions, "child relay must not open a competing ctx.ui dialog");

	resolveQuestionRequest(parentRequest.requestId, "answered", "typed ipc-secret");
	await waitFor(() => answerCalls.length === 1 && questionRequests.length === 2, "parent answer and queued nested request");
	const nestedRequest = questionRequests[1]!;
	assert.deepEqual(answerCalls[0], { owner: parentOwner, questionId: "parent-question", answer: "typed ipc-secret" });
	assert.equal(nestedRequest.title, `explorer ${nestedOwner} (via worker ${parentOwner}) asks: Which nested answer?`);
	assert.deepEqual(nestedRequest.options, ["green", "blue"]);
	assert.equal(sentContextMessages[contextMessageCountBeforeQuestions]?.message.customType, "subagent-question");
	assert.equal(sentContextMessages[contextMessageCountBeforeQuestions]?.message.display, true);
	assert.ok((sentContextMessages[contextMessageCountBeforeQuestions]?.message.content ?? "").includes("worker subagent-6 asked: Pick [REDACTED]?\nUser answered: typed [REDACTED]"));
	assert.doesNotMatch(sentContextMessages[contextMessageCountBeforeQuestions]?.message.content ?? "", /ipc-secret/);
	assert.deepEqual(sentContextMessages[contextMessageCountBeforeQuestions]?.options, { deliverAs: "nextTurn" });
	resolveQuestionRequest(nestedRequest.requestId, "answered", "blue");
	await waitFor(() => answerCalls.length === 2, "nested owner result answer");
	assert.equal(answerCalls[1]?.owner, nestedOwner);
	assert.ok((sentContextMessages[contextMessageCountBeforeQuestions + 1]?.message.content ?? "").includes(`explorer ${nestedOwner} (via worker ${parentOwner}) asked: Which nested answer?\nUser answered: blue`));
	assert.equal(sentMessages.length, userMessageCountBeforeQuestions, "question relay must not send a user follow-up turn");

	const duplicateDialogAnswer = await registeredTools.get("subagent_message")!.execute("call-15", { owner: parentOwner, questionId: "parent-question", message: "late answer" }, new AbortController().signal, undefined, context);
	assert.match((duplicateDialogAnswer as { content: Array<{ text: string }> }).content[0]!.text, /already answered/);

	await registeredTools.get("subagent")!.execute("call-16", { task: "question task tool answer" }, new AbortController().signal, undefined, context);
	const toolAnswerOwner = "subagent-8";
	emitQuestion(toolAnswerOwner, { questionId: "tool-question", question: "Answer from tool?", options: ["yes", "no"] });
	await waitFor(() => questionRequests.length === 3, "tool-answer question request to owner");
	const toolRequest = questionRequests[2]!;
	const toolAnswer = await registeredTools.get("subagent_message")!.execute("call-17", { owner: toolAnswerOwner, questionId: "tool-question", message: "answer via explicit tool" }, new AbortController().signal, undefined, context);
	assert.match((toolAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);
	assert.ok(questionCancels.includes(toolRequest.requestId), "subagent_message answer must cancel open owner request");
	const duplicateToolAnswer = await registeredTools.get("subagent_message")!.execute("call-18", { owner: toolAnswerOwner, questionId: "tool-question", message: "second answer" }, new AbortController().signal, undefined, context);
	assert.match((duplicateToolAnswer as { content: Array<{ text: string }> }).content[0]!.text, /already answered/);

	await registeredTools.get("subagent")!.execute("call-19", { task: "question task dismissed" }, new AbortController().signal, undefined, context);
	const dismissedOwner = "subagent-9";
	emitQuestion(dismissedOwner, { questionId: "dismissed-question", question: "Dismiss then answer" });
	await waitFor(() => questionRequests.length === 4, "free-text question request to owner");
	resolveQuestionRequest(questionRequests[3]!.requestId, "dismissed");
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
	const requestsBeforeNoUi = questionRequests.length;
	emitQuestion(noUiOwner, { questionId: "no-ui-question", question: "No UI available" });
	assert.equal(questionRequests.length, requestsBeforeNoUi, "non-UI context must not request a dialog");
	assert.ok((notifications.at(-1) ?? "").includes("answer later with /agents"));
	const noUiAnswer = await registeredTools.get("subagent_message")!.execute("call-23", { owner: noUiOwner, questionId: "no-ui-question", message: "answer without UI" }, new AbortController().signal, undefined, context);
	assert.match((noUiAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);

	context.hasUI = true;
	questionUiOwnerAvailable = false;
	await registeredTools.get("subagent")!.execute("call-no-owner", { task: "question task missing owner" }, new AbortController().signal, undefined, context);
	const noOwnerAckOwner = "subagent-11";
	emitQuestion(noOwnerAckOwner, { questionId: "missing-owner-question", question: "Owner is not loaded" });
	await waitFor(() => questionRequests.length === requestsBeforeNoUi + 1, "request with no loaded question owner");
	const noOwnerRequest = questionRequests.at(-1)!;
	assert.ok(notifications.some((message) => message.includes("question UI unavailable; answer with /agents")));
	assert.equal(visibleQuestionRequestIds.includes(noOwnerRequest.requestId), false);
	questionUiOwnerAvailable = true;
	const noOwnerAnswer = await registeredTools.get("subagent_message")!.execute("call-answer-no-owner", { owner: noOwnerAckOwner, questionId: "missing-owner-question", message: "answer after missing owner" }, new AbortController().signal, undefined, context);
	assert.match((noOwnerAnswer as { content: Array<{ text: string }> }).content[0]!.text, /Answer delivered/);

	// ponytail: fake owner holds child request behind model UI; ask-user-question relay tests exercise real FIFO.
	modelQuestionOpen = true;
	await registeredTools.get("subagent")!.execute("call-overlap", { task: "question task overlap" }, new AbortController().signal, undefined, context);
	const overlappingOwner = "subagent-12";
	emitQuestion(overlappingOwner, { questionId: "overlap-question", question: "Queued behind model?" });
	await waitFor(() => questionRequests.length === requestsBeforeNoUi + 2, "child request queued behind model question");
	const overlappingRequest = questionRequests.at(-1)!;
	assert.equal(visibleQuestionRequestIds.includes(overlappingRequest.requestId), false);
	finishModelQuestion();
	assert.ok(visibleQuestionRequestIds.includes(overlappingRequest.requestId));
	resolveQuestionRequest(overlappingRequest.requestId, "answered", "after model UI");
	await waitFor(() => answerCalls.length === 7, "child answer after model UI clears");

	assert.equal(selectCalls.length, selectCountBeforeQuestions, "relay must never render child questions with ctx.ui.select/input");
	assert.equal(sentMessages.length, userMessageCountBeforeQuestions, "question handling must not prompt parent model");
	assert.equal(sentContextMessages.length, contextMessageCountBeforeQuestions + 7);
	assert.ok(sentContextMessages.slice(contextMessageCountBeforeQuestions).every(({ options }) => JSON.stringify(options) === JSON.stringify({ deliverAs: "nextTurn" })));
	emitQuestion("subagent-3", { questionId: "open-overlay-question", question: "Answer from open relay?", options: ["yes", "no"] });
	await waitFor(() => questionRequests.length === requestsBeforeNoUi + 3, "open relay for /agents answer");
	const openOverlayRequest = questionRequests.at(-1)!;
	const answerOverlaySelectCount = selectCalls.length;
	overlayComponent = undefined;
	const answerAgentsOverlay = commandHandlers.get("agents")!("", context) as Promise<void>;
	await waitFor(() => selectCalls.length === answerOverlaySelectCount + 1, "agents picker for open question");
	const answerPicker = selectCalls.at(-1)!;
	assert.ok(answerPicker.options.some((option) => option.startsWith(`  ${nestedOwner} — explorer [running]`)), "picker should indent nested children");
	const answerAgent = answerPicker.options.find((option) => option.includes("subagent-3 — worker [waiting]"));
	assert.ok(answerAgent, "picker should list child with pending question");
	resolveNextSelect(answerAgent);
	await waitFor(() => overlayComponent !== undefined, "agents overlay for open question");
	assert.deepEqual(overlayOptions, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 } });
	const answerCountBeforeOpenOverlay = answerCalls.length;
	const openQuestionText = overlayComponent!.render?.(80)?.join("\n") ?? "";
	assert.match(openQuestionText, /Question: Answer from open relay\?/);
	assert.ok(openQuestionText.includes("Options: yes | no"));
	assert.match(openQuestionText, /Enter answer.*Esc closes \/agents only/);
	for (const character of "answer in overlay") overlayComponent!.handleInput?.(character);
	overlayComponent!.handleInput?.("\r");
	await waitFor(() => answerCalls.length === answerCountBeforeOpenOverlay + 1, "answer open owner request through /agents");
	assert.deepEqual(answerCalls.at(-1), { owner: "subagent-3", questionId: "open-overlay-question", answer: "answer in overlay" });
	assert.ok(questionCancels.includes(openOverlayRequest.requestId), "/agents answer must cancel open owner request");
	assert.doesNotMatch(overlayComponent?.render?.(80)?.join("\n") ?? "", /ipc-secret/, "overlay input must redact IPC token");
	for (const character of "hello ipc-secret") overlayComponent!.handleInput?.(character);
	assert.doesNotMatch(overlayComponent?.render?.(80)?.join("\n") ?? "", /ipc-secret/, "overlay input must keep IPC token redacted");
	overlayComponent!.handleInput?.("\r");
	await waitFor(() => sentContextMessages.some(({ message }) => message.customType === "subagent-steer"), "steer parent note");
	assert.deepEqual(steeredMessages.at(-1), { owner: "subagent-3", text: "hello ipc-secret" });
	assert.deepEqual(sentContextMessages.at(-1), {
		message: { customType: "subagent-steer", content: "User told subagent-3: hello [REDACTED]", display: true },
		options: { deliverAs: "nextTurn" },
	});
	const answeredOverlay = overlayComponent!;
	answeredOverlay.handleInput?.("\u001b");
	await answerAgentsOverlay;

	overlayComponent = undefined;
	const gatePickerCount = selectCalls.length;
	const openAgentsOverlay = commandHandlers.get("agents")!("", context) as Promise<void>;
	await waitFor(() => selectCalls.length === gatePickerCount + 1, "agents picker for overlay queue gate");
	const gatePicker = selectCalls.at(-1)!;
	assert.ok(gatePicker.options.some((option) => option.startsWith(`  ${nestedOwner} — explorer [running]`)), "picker should continue indenting nested children");
	const selectedAgent = gatePicker.options.find((option) => option.includes("subagent-3 — worker [running]"));
	assert.ok(selectedAgent, "picker should list running children");
	resolveNextSelect(selectedAgent);
	await waitFor(() => overlayComponent !== undefined, "agents overlay for queue gate");
	const selectCountBeforeOverlayQuestions = selectCalls.length;
	const questionCountBeforeOverlayQuestions = questionRequests.length;
	const answerCountBeforeDeferredQuestion = answerCalls.length;
	const deferredOverlayQuestionId = "overlay-question-pending";
	emitQuestion("subagent-3", { questionId: deferredOverlayQuestionId, question: "Answer me after closing?", options: ["yes", "no"] });
	assert.equal(questionRequests.length, questionCountBeforeOverlayQuestions, "viewed child's question must stay behind /agents overlay");
	assert.equal(selectCalls.length, selectCountBeforeOverlayQuestions, "viewed child's question must not open a competing dialog");
	assert.match(overlayComponent!.render?.(80)?.join("\n") ?? "", /Question: Answer me after closing\?/);
	const answerCountBeforeOverlayQuestions = answerCalls.length;
	emitQuestion(nestedOwner, { questionId: "nested-overlay-question", question: "Other child asks?", options: ["green", "blue"] });
	const otherQuestionNotice = `explorer ${nestedOwner} (via worker ${parentOwner}) has a question; press Esc to answer it.`;
	const currentOverlayText = () => (overlayComponent?.render?.(80) ?? []).join(" ").replace(/\s+/g, " ");
	await waitFor(() => currentOverlayText().includes(otherQuestionNotice), "notice for question belonging to another child");
	assert.equal(questionRequests.length, questionCountBeforeOverlayQuestions, "questions must not reach owner while /agents is open");
	assert.equal(selectCalls.length, selectCountBeforeOverlayQuestions, "questions must not open dialogs while /agents is open");
	assert.equal(answerCalls.length, answerCountBeforeOverlayQuestions, "queued questions remain unanswered before Esc");
	const closingOverlay = overlayComponent!;
	closingOverlay.handleInput?.("\u001b");
	await openAgentsOverlay;
	await waitFor(() => questionRequests.length === questionCountBeforeOverlayQuestions + 1, "other-child request after overlay closes");
	const otherQuestionRequest = questionRequests.at(-1)!;
	assert.equal(otherQuestionRequest.title, `explorer ${nestedOwner} (via worker ${parentOwner}) asks: Other child asks?`);
	assert.ok(visibleQuestionRequestIds.includes(otherQuestionRequest.requestId));
	assert.equal(selectCalls.length, selectCountBeforeOverlayQuestions, "only question owner handles child dialog after Esc");
	assert.ok(notifications.at(-1)?.includes("worker subagent-3: question remains pending; answer later with /agents."));
	const pendingOverlayList = await registeredTools.get("subagents_list")!.execute("call-24", {}, new AbortController().signal, undefined, context);
	const pendingOverlayAgents = (pendingOverlayList as { details: { agents: Array<{ owner: string; status: string; question?: { questionId: string } }> } }).details.agents;
	assert.equal(pendingOverlayAgents.find((agent) => agent.owner === "subagent-3")?.status, "waiting");
	assert.equal(pendingOverlayAgents.find((agent) => agent.owner === "subagent-3")?.question?.questionId, deferredOverlayQuestionId);
	assert.equal(pendingOverlayAgents.find((agent) => agent.owner === nestedOwner)?.question?.questionId, "nested-overlay-question");
	resolveQuestionRequest(otherQuestionRequest.requestId, "answered", "green");
	await waitFor(() => answerCalls.length === answerCountBeforeDeferredQuestion + 1, "answer other-child question after overlay closes");
	assert.deepEqual(answerCalls.at(-1), { owner: nestedOwner, questionId: "nested-overlay-question", answer: "green" });
	assert.equal(selectCalls.length, selectCountBeforeOverlayQuestions, "same-child question must not open a relay dialog after Esc");

	const reopenPickerCount = selectCalls.length;
	overlayComponent = undefined;
	const reopenAgentsOverlay = commandHandlers.get("agents")!("", context) as Promise<void>;
	await waitFor(() => selectCalls.length === reopenPickerCount + 1, "agents picker for pending question");
	const reopenPicker = selectCalls.at(-1)!;
	const deferredChildOption = reopenPicker.options.find((option) => option.includes("subagent-3 — worker [waiting]"));
	assert.ok(deferredChildOption, "pending child must remain selectable after Esc");
	resolveNextSelect(deferredChildOption);
	await waitFor(() => overlayComponent !== undefined && overlayComponent !== closingOverlay, "reopened overlay for dismissed question");
	assert.match(overlayComponent!.render?.(80)?.join("\n") ?? "", /Question: Answer me after closing\?/);
	for (const character of "answered later in /agents") overlayComponent!.handleInput?.(character);
	overlayComponent!.handleInput?.("\r");
	await waitFor(() => answerCalls.length === answerCountBeforeDeferredQuestion + 2, "answer dismissed question later through /agents");
	assert.deepEqual(answerCalls.at(-1), { owner: "subagent-3", questionId: deferredOverlayQuestionId, answer: "answered later in /agents" });
	assert.equal(questionRequests.length, questionCountBeforeOverlayQuestions + 1, "later /agents answer must not create owner request");
	assert.equal(selectCalls.length, reopenPickerCount + 1);
	overlayComponent!.handleInput?.("\u001b");
	await reopenAgentsOverlay;
	assert.equal(selectCalls.length, reopenPickerCount + 1);

	const settledRelayCount = questionRequests.length;
	emitQuestion("subagent-4", { questionId: "settled-child-question", question: "Close when child settles?" });
	await waitFor(() => questionRequests.length === settledRelayCount + 1, "open request for child settlement cancellation");
	const settledChildRequest = questionRequests.at(-1)!;
	const questionOwners = [parentOwner, nestedOwner, toolAnswerOwner, dismissedOwner, noUiOwner, noOwnerAckOwner, overlappingOwner, "subagent-3", "subagent-4"];
	for (const owner of questionOwners) {
		const resolve = pendingResults.get(owner);
		pendingResults.delete(owner);
		resolve?.({ owner, childSessionId: `child-${owner}`, text: `${owner} done` });
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(questionCancels.includes(settledChildRequest.requestId), "child settlement must cancel open owner request");
	for (const message of sentMessages) emitMessageStart({ role: "user", content: message.content });
	assert.equal(nestedSpawnError, undefined);
	await nestedSpawnResult;

	const failureFallbackMessageCount = sentMessages.length;
	sendUserMessageFailure = new Error("injected failed-child delivery failure");
	await registeredTools.get("subagent")!.execute("call-failure-fallback", { task: "failure task redelivery" }, new AbortController().signal, undefined, context);
	const failureFallbackOwner = launched?.owner;
	assert.ok(failureFallbackOwner);
	await new Promise((resolve) => setImmediate(resolve));
	sendUserMessageFailure = undefined;
	const failureFallbackList = await registeredTools.get("subagents_list")!.execute("call-failure-pending", {}, new AbortController().signal, undefined, context);
	const failureFallbackText = (failureFallbackList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(failureFallbackText, new RegExp(`${failureFallbackOwner} \\[failed\\].*result pending delivery`));
	assert.match(failureFallbackText, /sentinel failure/);
	const failureFallbackCustomCount = () => sentContextMessages.filter(({ message }) => message.customType === "subagent-result").length;
	const failureFallbackCountBeforeSettle = failureFallbackCustomCount();
	emitAgentSettled();
	const failureFallbackMessage = sentContextMessages.filter(({ message }) => message.customType === "subagent-result").at(-1);
	assert.ok(failureFallbackMessage);
	assert.match(String(failureFallbackMessage.message.content), /sentinel failure/);
	assert.deepEqual(failureFallbackMessage.options, { deliverAs: "nextTurn" });
	emitAgentSettled();
	assert.equal(failureFallbackCustomCount(), failureFallbackCountBeforeSettle + 1, "failed child gets one fallback delivery");
	assert.equal(sentMessages.length, failureFallbackMessageCount, "failed-child nextTurn must not start parent turn");
	emitMessageStart({ role: "custom", customType: "subagent-result", content: failureFallbackMessage.message.content });
	const failureFallbackDelivered = await registeredTools.get("subagents_list")!.execute("call-failure-delivered", {}, new AbortController().signal, undefined, context);
	const failureFallbackDeliveredText = (failureFallbackDelivered as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(failureFallbackDeliveredText, new RegExp(`${failureFallbackOwner} \\[failed\\].*result delivered`));
	assert.ok(!failureFallbackDeliveredText.includes(`Result: Subagent ${failureFallbackOwner} failed.`));

	const editorMessageCount = sentMessages.length;
	await registeredTools.get("subagent")!.execute("call-editor-restore", { task: "editor result restored" }, new AbortController().signal, undefined, context);
	const editorOwner = launched?.owner;
	assert.ok(editorOwner);
	completePendingResult(editorOwner, "editor restored output");
	await waitFor(() => sentMessages.length === editorMessageCount + 1, "editor-owned follow-up queue");
	const editorOwnedText = sentMessages.at(-1)!.content;
	const customResultCount = () => sentContextMessages.filter(({ message }) => message.customType === "subagent-result").length;
	const customCountBeforeEditorSettle = customResultCount();
	editorText = editorOwnedText;
	emitAgentSettled();
	assert.equal(customResultCount(), customCountBeforeEditorSettle, "restored editor text must not get nextTurn duplicate");
	const editorPendingList = await registeredTools.get("subagents_list")!.execute("call-editor-pending", {}, new AbortController().signal, undefined, context);
	assert.match((editorPendingList as { content: Array<{ text: string }> }).content[0]!.text, /result pending delivery/);
	editorText = "";
	emitMessageStart({ role: "user", content: editorOwnedText });
	emitAgentSettled();
	assert.equal(customResultCount(), customCountBeforeEditorSettle);
	const editorDeliveredList = await registeredTools.get("subagents_list")!.execute("call-editor-delivered", {}, new AbortController().signal, undefined, context);
	const editorDeliveredText = (editorDeliveredList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(editorDeliveredText, new RegExp(`${editorOwner} \\[done\\].*result delivered`));
	assert.doesNotMatch(editorDeliveredText, /editor restored output/);

	const editedMessageCount = sentMessages.length;
	await registeredTools.get("subagent")!.execute("call-editor-edited", { task: "edited editor result" }, new AbortController().signal, undefined, context);
	const editedOwner = launched?.owner;
	assert.ok(editedOwner);
	completePendingResult(editedOwner, "edited editor original");
	await waitFor(() => sentMessages.length === editedMessageCount + 1, "edited editor follow-up queue");
	const editedDeliveryText = sentMessages.at(-1)!.content;
	editorText = editedDeliveryText;
	emitAgentSettled();
	editorText = editedDeliveryText.replace("edited editor original", "user changed this result");
	emitMessageStart({ role: "user", content: editorText });
	editorText = "";
	emitAgentSettled();
	assert.equal(customResultCount(), customCountBeforeEditorSettle, "edited restored text stays pending without duplicate");
	const editedPendingList = await registeredTools.get("subagents_list")!.execute("call-editor-edited-pending", {}, new AbortController().signal, undefined, context);
	const editedPendingText = (editedPendingList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(editedPendingText, new RegExp(`${editedOwner} \\[done\\].*result pending delivery`));
	assert.ok(editedPendingText.includes(`Result: Subagent ${editedOwner} finished.\n\nedited editor original`));

	const emptyEditorMessageCount = sentMessages.length;
	await registeredTools.get("subagent")!.execute("call-editor-empty", { task: "empty editor result" }, new AbortController().signal, undefined, context);
	const emptyEditorOwner = launched?.owner;
	assert.ok(emptyEditorOwner);
	completePendingResult(emptyEditorOwner, "empty editor output");
	await waitFor(() => sentMessages.length === emptyEditorMessageCount + 1, "empty-editor follow-up queue");
	const resultMessageCountBeforeSettle = customResultCount();
	emitAgentSettled();
	const fallbackMessage = sentContextMessages.filter(({ message }) => message.customType === "subagent-result").at(-1);
	assert.ok(fallbackMessage);
	assert.equal(fallbackMessage.message.content, sentMessages.at(-1)!.content);
	assert.deepEqual(fallbackMessage.options, { deliverAs: "nextTurn" });
	emitAgentSettled();
	assert.equal(customResultCount(), resultMessageCountBeforeSettle + 1, "only one nextTurn re-delivery per result");
	assert.equal(sentMessages.length, emptyEditorMessageCount + 1, "nextTurn must not auto-start a parent turn");
	emitMessageStart({ role: "custom", customType: "subagent-result", content: fallbackMessage.message.content });
	const emptyEditorDeliveredList = await registeredTools.get("subagents_list")!.execute("call-editor-empty-delivered", {}, new AbortController().signal, undefined, context);
	const emptyEditorDeliveredText = (emptyEditorDeliveredList as { content: Array<{ text: string }> }).content[0]!.text;
	assert.match(emptyEditorDeliveredText, new RegExp(`${emptyEditorOwner} \\[done\\].*result delivered`));
	assert.doesNotMatch(emptyEditorDeliveredText, /empty editor output/);

	const messagesBeforeShutdown = sentMessages.length;
	await registeredTools.get("subagent")!.execute("call-shutdown", { task: "shutdown failure task" }, new AbortController().signal, undefined, context);
	assert.equal(launched?.task, "shutdown failure task");
	const shutdownQuestionOwner = launched?.owner;
	assert.ok(shutdownQuestionOwner);
	emitQuestion(shutdownQuestionOwner, { questionId: "shutdown-child-question", question: "Close on shutdown?" });
	await waitFor(() => questionRequests.length === settledRelayCount + 2, "open request before session shutdown");
	const shutdownQuestionRequest = questionRequests.at(-1)!;
	await handlers.get("session_shutdown")?.({}, context);
	assert.ok(questionCancels.includes(shutdownQuestionRequest.requestId), "session shutdown must cancel open owner request");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sentMessages.length, messagesBeforeShutdown, "host-close failure must not send a parent follow-up during shutdown");
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
