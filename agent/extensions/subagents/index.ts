import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { discoverAgents, formatAgentList, type AgentConfig, type AgentRole, type AgentScope } from "./agents.ts";
import { resolveEffort, type SubagentParentThinkingLevel } from "./effort.ts";
import { normalizeOwnership } from "./ownership.ts";
import {
	BROWSER_PROXY_BUILD_TOOLS,
	BROWSER_PROXY_READ_ONLY_TOOLS,
	READ_ONLY_EXPLORER_TOOLS,
	REPOSITORY_READ_ONLY_TOOLS,
	type BrowserProxyName,
	validateSubagentAgentAllowlist,
	validateSubagentDepth,
	validateSubagentToolset,
} from "./policy.ts";
export { BROWSER_PROXY_BUILD_TOOLS, BROWSER_PROXY_READ_ONLY_TOOLS, READ_ONLY_EXPLORER_TOOLS, REPOSITORY_READ_ONLY_TOOLS } from "./policy.ts";
export type { BrowserProxyName } from "./policy.ts";
import { resolveSubagentTimeoutPolicy } from "./timeout-policy.ts";
import {
	SubagentFailureError,
	SubagentLaunchHost,
	type SubagentLaunchHandle,
	type SubagentQuestion,
	type SubagentResult,
} from "./launch.ts";
import type { SubagentTransport } from "./diagnostics.ts";
import {
	clearSubagentProgress,
	setSubagentProgressContext,
	startSubagentProgress,
	type ProgressHandle,
} from "./progress.ts";

const SUBAGENT_TOOL_NAME = "subagent";
const SUBAGENTS_LIST_TOOL_NAME = "subagents_list";
const SUBAGENT_MESSAGE_TOOL_NAME = "subagent_message";
const AGENT_SCOPE_DESCRIPTION =
	"Bundled defaults are always present; user is the default scope, project uses the nearest project override, and both applies user then project.";
const SUBAGENT_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_AGENT_SCOPE: AgentScope = "user";
const MAX_FINAL_TEXT_BYTES = 50 * 1024;
const MAX_TRACKED_RUNS = 100;
const MAX_BROWSER_PROXY_TIMEOUT_MS = 120_000;
const BROWSER_REQUEST_EVENT = "browser:request";
const BROWSER_RESULT_EVENT = "browser:result";
const BROWSER_READ_ONLY_TOOLS = new Set(["browser_console", "browser_network"]);

const SubagentParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: MAX_FINAL_TEXT_BYTES, description: "Task for async subagent. Result arrives as a later parent turn." }),
	agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Agent definition name. Defaults to "worker".' })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: AGENT_SCOPE_DESCRIPTION,
			default: DEFAULT_AGENT_SCOPE,
		}),
	),
	fileOwnership: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 100, description: "Paths or globs exclusively owned by this child while it runs." })),
});
type SubagentParams = Static<typeof SubagentParams>;

const SubagentsListParams = Type.Object({
	tail: Type.Optional(Type.Boolean({ description: "Read live output from running cmux subagents." })),
});
type SubagentsListParams = Static<typeof SubagentsListParams>;

const SubagentMessageParams = Type.Object({
	owner: Type.String({ minLength: 1, maxLength: 128, description: "Unique subagent owner from subagents_list." }),
	message: Type.String({ minLength: 1, maxLength: MAX_FINAL_TEXT_BYTES, description: "Message or answer to send to subagent." }),
	questionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Question ID when answering a waiting child." })),
});
type SubagentMessageParams = Static<typeof SubagentMessageParams>;

export type WorkflowMode = "off" | "discuss" | "plan" | "build" | "review" | "design";

interface WorkflowStateQueryResult {
	ok: boolean;
	mode?: WorkflowMode;
	cavemanEnabled: boolean;
	error?: string;
}

interface SubagentsSettings {
	models?: Partial<Record<AgentRole, string>>;
	effort?: Partial<Record<AgentRole, string>>;
	idleTimeoutMs?: unknown;
	maxTotalMs?: unknown;
}

export function validateExplorerTools(tools: string[] | undefined): string | undefined {
	const activeTools = tools ?? REPOSITORY_READ_ONLY_TOOLS;
	const unsafeTools = activeTools.filter((tool) => !READ_ONLY_EXPLORER_TOOLS.has(tool));
	return unsafeTools.length > 0 ? `Explorer agent includes non-repository-read-only tool(s): ${unsafeTools.join(", ")}.` : undefined;
}

export function browserProxyToolNames(mode: WorkflowMode | undefined): BrowserProxyName[] {
	return [...(mode === "build" ? BROWSER_PROXY_BUILD_TOOLS : BROWSER_PROXY_READ_ONLY_TOOLS)];
}

export function augmentBrowserProxyTools(tools: string[] | undefined, names: readonly BrowserProxyName[]): string[] {
	return [...new Set([...(tools ?? REPOSITORY_READ_ONLY_TOOLS), ...names])];
}

interface SubagentRecord {
	owner: string;
	childSessionId: string;
	agentName: string;
	role: AgentRole;
	status: "running" | "waiting" | "done" | "failed";
	task: string;
	tools: string[];
	subagentAgents?: string[];
	depth: number;
	fileOwnership: string[];
	agentScope: AgentScope;
	parentOwner?: string;
	startedAt: number;
	finishedAt?: number;
	loadoutPath?: string;
	transport?: SubagentTransport;
	logPath?: string;
	sessionFile?: string;
	cmuxFailureReason?: string;
	outputTail?: string;
	handle?: SubagentLaunchHandle;
	question?: SubagentQuestion;
	result?: string;
	error?: string;
	browserReadOnly: boolean;
	steered: boolean;
	progress?: ProgressHandle;
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "off" || value === "discuss" || value === "plan" || value === "build" || value === "review" || value === "design";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateUtf8(text: string, maxBytes = MAX_FINAL_TEXT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = `\n\n[truncated to ${maxBytes} bytes]`;
	const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let output = text.slice(0, contentBytes);
	while (Buffer.byteLength(output, "utf8") > contentBytes) output = output.slice(0, -1);
	return `${output}${suffix}`;
}

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readSubagentsSettings(): SubagentsSettings {
	const value = readSettings().subagents;
	return isRecord(value) ? value as SubagentsSettings : {};
}

function writeSubagentModel(role: AgentRole, modelRef: string | undefined): void {
	const settings = readSettings();
	const subagents = readSubagentsSettings();
	const models = { ...(subagents.models ?? {}) };
	if (modelRef) models[role] = modelRef;
	else delete models[role];
	const nextSubagents = { ...subagents };
	if (Object.keys(models).length > 0) nextSubagents.models = models;
	else delete nextSubagents.models;
	settings.subagents = nextSubagents;
	fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function writeSubagentEffort(role: AgentRole, effort: string | "inherit"): void {
	const settings = readSettings();
	const subagents = readSubagentsSettings();
	const configured = isRecord(subagents.effort) ? { ...subagents.effort } : {};
	if (effort === "inherit") delete configured[role];
	else configured[role] = effort;
	const nextSubagents = { ...subagents };
	if (Object.keys(configured).length > 0) nextSubagents.effort = configured;
	else delete nextSubagents.effort;
	settings.subagents = nextSubagents;
	fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function modelReference(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function resolveModelReference(reference: string | undefined, ctx: ExtensionContext): Model<any> | undefined {
	if (!reference) return undefined;
	const slashIndex = reference.indexOf("/");
	if (slashIndex > 0) return ctx.modelRegistry.find(reference.slice(0, slashIndex), reference.slice(slashIndex + 1));
	return ctx.modelRegistry.getAll().find((model) => model.id === reference) ?? ctx.modelRegistry.getAll().find((model) => model.id.includes(reference));
}

function configuredModel(role: AgentRole, ctx: ExtensionContext): Model<any> | undefined {
	return resolveModelReference(readSubagentsSettings().models?.[role], ctx);
}

function parentThinkingLevel(pi: ExtensionAPI): SubagentParentThinkingLevel | undefined {
	return pi.getThinkingLevel?.() as SubagentParentThinkingLevel | undefined;
}

function configuredEffort(pi: ExtensionAPI, role: AgentRole): SubagentParentThinkingLevel | undefined {
	return resolveEffort(readSubagentsSettings(), role, parentThinkingLevel(pi));
}

function queryWorkflowState(pi: ExtensionAPI, signal: AbortSignal | undefined, timeoutMs = 1000): Promise<WorkflowStateQueryResult> {
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbort: (() => void) | undefined;
		const settle = (result: WorkflowStateQueryResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			removeAbort?.();
			unsubscribe?.();
			resolve(result);
		};
		const abort = () => settle({ ok: false, cavemanEnabled: true, error: "Workflow state query aborted." });
		if (signal?.aborted) return abort();
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			removeAbort = () => signal.removeEventListener("abort", abort);
		}
		unsubscribe = pi.events.on("workflow-modes:state", (data: unknown) => {
			const value = isRecord(data) ? data : {};
			if (!isWorkflowMode(value.mode)) return settle({ ok: false, cavemanEnabled: true, error: "workflow-modes returned invalid mode state." });
			settle({ ok: true, mode: value.mode, cavemanEnabled: typeof value.cavemanEnabled === "boolean" ? value.cavemanEnabled : true });
		});
		timer = setTimeout(() => settle({ ok: false, cavemanEnabled: true, error: "Timed out waiting for workflow-modes state." }), timeoutMs);
		try {
			pi.events.emit("workflow-modes:get", undefined);
		} catch (error) {
			settle({ ok: false, cavemanEnabled: true, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

export function requestBrowserViaParent(pi: ExtensionAPI, owner: string, payload: unknown, readOnly: boolean): Promise<unknown> {
	if (!isRecord(payload) || typeof payload.tool !== "string" || !isRecord(payload.params)) throw new Error("Browser proxy request is malformed.");
	const params = readOnly && BROWSER_READ_ONLY_TOOLS.has(payload.tool) ? { ...payload.params, clear: false } : payload.params;
	const requestId = crypto.randomUUID();
	const timeoutValue = payload.params.timeout;
	const timeout = typeof timeoutValue === "number" && Number.isInteger(timeoutValue) && timeoutValue >= 100 && timeoutValue <= MAX_BROWSER_PROXY_TIMEOUT_MS
		? timeoutValue
		: 30_000;
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (action: () => void) => {
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			action();
		};
		let unsubscribe: (() => void) | undefined;
		const onResult = (value: unknown) => {
			if (!isRecord(value) || value.requestId !== requestId || value.owner !== owner) return;
			if (value.ok === true) return finish(() => resolve(value.result));
			if (value.ok === false && typeof value.error === "string") return finish(() => reject(new Error(String(value.error))));
			return finish(() => reject(new Error("Malformed browser proxy result.")));
		};
		timer = setTimeout(() => finish(() => reject(new Error(`Browser proxy request timed out after ${timeout} milliseconds.`))), timeout);
		unsubscribe = pi.events.on(BROWSER_RESULT_EVENT, onResult);
		try {
			pi.events.emit(BROWSER_REQUEST_EVENT, { requestId, owner, tool: payload.tool, params });
		} catch (error) {
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
	});
}

function inferRole(agent: AgentConfig): AgentRole {
	return agent.name === "explorer" ? "explorer" : "worker";
}

function nextOwner(): string {
	return `subagent-${++ownerCounter}`;
}

function resultMessage(record: SubagentRecord, text: string): string {
	return `Subagent ${record.owner} finished.\n\n${truncateUtf8(text)}`;
}

function steerResult(pi: ExtensionAPI, record: SubagentRecord, text: string): void {
	if (record.steered) return;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			pi.sendUserMessage(resultMessage(record, text), { deliverAs: "followUp" });
			record.steered = true;
			return;
		} catch (error) {
			lastError = error;
		}
	}
	record.error = `Result steering failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
}

function failureMessage(record: SubagentRecord): string {
	const lines = [
		`Subagent ${record.owner} failed.`,
		`Transport: ${record.transport ?? "unknown"}`,
		`Log: ${record.logPath ?? "unavailable"}`,
		`Error: ${record.error ?? "unknown error"}`,
		...(record.sessionFile ? [`Transcript: ${record.sessionFile}`] : []),
	];
	if (record.cmuxFailureReason) lines.push(`Cmux failure: ${record.cmuxFailureReason}`);
	if (record.outputTail) lines.push(`Recent output:\n${record.outputTail}`);
	return lines.join("\n");
}

function steerFailure(pi: ExtensionAPI, record: SubagentRecord): void {
	if (record.steered) return;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			pi.sendUserMessage(failureMessage(record), { deliverAs: "followUp" });
			record.steered = true;
			return;
		} catch (error) {
			lastError = error;
		}
	}
	record.error = `Failure steering failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
}

async function chooseSubagentModel(args: string, ctx: ExtensionContext): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const role = (parts[0] === "explorer" || parts[0] === "worker" ? parts[0] : await ctx.ui.select("Subagent role", ["explorer", "worker"])) as AgentRole | undefined;
	if (!role) return;
	const requestedModel = parts[0] === role ? parts[1] : parts[0];
	if (requestedModel === "inherit") {
		writeSubagentModel(role, undefined);
		return ctx.ui.notify(`Subagent ${role} model: inherit`, "info");
	}
	const available = await Promise.resolve(ctx.modelRegistry.getAvailable());
	if (available.length === 0) return ctx.ui.notify("No available models found.", "warning");
	const selectedReference = requestedModel ?? await ctx.ui.select(`Model for ${role}`, ["inherit", ...available.map(modelReference)]);
	if (selectedReference === "inherit") {
		writeSubagentModel(role, undefined);
		return ctx.ui.notify(`Subagent ${role} model: inherit`, "info");
	}
	const selected = selectedReference ? resolveModelReference(selectedReference, ctx) : undefined;
	if (!selected) return ctx.ui.notify(`Unknown model${requestedModel ? `: ${requestedModel}` : ""}.`, "warning");
	writeSubagentModel(role, modelReference(selected));
	ctx.ui.notify(`Subagent ${role} model: ${modelReference(selected)}`, "info");
}

async function chooseSubagentEffort(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const role = (parts[0] === "explorer" || parts[0] === "worker" ? parts[0] : await ctx.ui.select("Subagent role", ["explorer", "worker"])) as AgentRole | undefined;
	if (!role) return ctx.ui.notify("Subagent effort selection cancelled.", "info");
	const requestedEffort = parts[0] === role ? parts[1] : parts[0];
	const selectedEffort = requestedEffort ?? await ctx.ui.select(`Effort for ${role}`, ["inherit", ...SUBAGENT_EFFORT_LEVELS]);
	if (!selectedEffort || (selectedEffort !== "inherit" && !SUBAGENT_EFFORT_LEVELS.includes(selectedEffort as typeof SUBAGENT_EFFORT_LEVELS[number]))) {
		return ctx.ui.notify(`Unknown effort${selectedEffort ? `: ${selectedEffort}` : ""}.`, "warning");
	}
	writeSubagentEffort(role, selectedEffort);
	if (selectedEffort === "inherit") return ctx.ui.notify(`Subagent ${role} effort: inherit (effective parent: ${parentThinkingLevel(pi) ?? "unknown"})`, "info");
	ctx.ui.notify(`Subagent ${role} effort: ${selectedEffort}`, "info");
}

let ownerCounter = 0;

export default function subagentsExtension(pi: ExtensionAPI): void {
	let host: SubagentLaunchHost | undefined;
	let hostSessionId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	const records = new Map<string, SubagentRecord>();

	const ensureHost = (ctx: ExtensionContext): SubagentLaunchHost => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (host && hostSessionId === sessionId) return host;
		const previous = host;
		host = new SubagentLaunchHost({ parentSessionId: sessionId, timeoutPolicy: resolveSubagentTimeoutPolicy(readSubagentsSettings()), onSpawn: spawnNested, onBrowser: (owner, payload) => requestBrowserViaParent(pi, owner, payload, records.get(owner)?.browserReadOnly ?? false) });
		hostSessionId = sessionId;
		void previous?.close();
		return host;
	};

	const rememberRecord = (record: SubagentRecord): void => {
		records.set(record.owner, record);
		while (records.size > MAX_TRACKED_RUNS) records.delete(records.keys().next().value as string);
	};

	const callbacksFor = (record: SubagentRecord, steerToParent = true) => ({
		...(steerToParent ? { onResult: (text: string) => steerResult(pi, record, text) } : {}),
		onStatus: (status: "running" | "waiting") => {
			record.status = status;
			if (status === "running") record.question = undefined;
			record.progress?.setStatus(status);
		},
		onSessionFile: (sessionFile: string) => {
			record.sessionFile = sessionFile;
		},
		onQuestion: (question: SubagentQuestion) => {
			record.question = question;
			record.progress?.setStatus("waiting");
			const options = question.options?.length ? `\nOptions: ${question.options.join(", ")}` : "";
			pi.sendUserMessage(
				`Subagent ${record.owner} is waiting for an answer.\nQuestion ID: ${question.questionId}\n${question.question}${options}\n\nReply with subagent_message using owner ${record.owner} and this questionId.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	const attachHandle = (record: SubagentRecord, handle: SubagentLaunchHandle, steerToParent = true): void => {
		record.handle = handle;
		record.childSessionId = handle.childSessionId;
		record.loadoutPath = handle.loadoutPath;
		record.transport = handle.transport;
		record.logPath = handle.logPath;
		record.sessionFile = handle.sessionFile ?? record.sessionFile;
		record.cmuxFailureReason = handle.cmuxFailureReason;
		record.outputTail = undefined;
		record.progress?.setTransport(handle.transport, handle.logPath);
		void handle.result.then((result: SubagentResult) => {
			record.sessionFile = result.sessionFile ?? record.sessionFile;
			record.result = result.text;
			record.finishedAt = Date.now();
			if (steerToParent && !record.steered) steerResult(pi, record, result.text);
			record.status = !steerToParent || record.steered ? "done" : "failed";
			record.progress?.finish(record.status === "done" ? "done" : "failed");
		}).catch((error: unknown) => {
			record.status = "failed";
			record.finishedAt = Date.now();
			record.error = error instanceof SubagentFailureError ? error.info.error : error instanceof Error ? error.message : String(error);
			if (error instanceof SubagentFailureError) {
				record.transport = error.info.transport;
				record.logPath = error.info.logPath;
				record.cmuxFailureReason = error.info.cmuxFailureReason;
				record.outputTail = error.info.tail;
			}
			record.progress?.setFailure(record.error);
			record.progress?.finish("failed");
			if (steerToParent) steerFailure(pi, record);
		});
	};

	const readLiveTails = async (): Promise<void> => {
		const activeHost = host;
		if (!activeHost) return;
		const liveRecords = [...records.values()].filter((record) => record.status === "running" || record.status === "waiting");
		let next = 0;
		const readLane = async (): Promise<void> => {
			while (next < liveRecords.length) {
				const record = liveRecords[next++]!;
				try {
					const tail = await activeHost.readSurfaceTail(record.owner, 20);
					if (record.status === "running" || record.status === "waiting") record.outputTail = tail;
				} catch {
					if (record.status === "running" || record.status === "waiting") record.outputTail = undefined;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(3, liveRecords.length) }, () => readLane()));
	};

	async function spawnNested(parentOwner: string, payload: unknown): Promise<unknown> {
		const parent = records.get(parentOwner);
		if (!parent) throw new Error(`Unknown parent subagent ${parentOwner}.`);
		if (!isRecord(payload) || typeof payload.task !== "string" || !payload.task.trim()) throw new Error("Nested subagent request is malformed.");
		const agentName = typeof payload.agent === "string" && payload.agent.trim() ? payload.agent.trim() : parent.subagentAgents?.[0];
		if (!agentName) throw new Error(`Subagent ${parentOwner} has no child agent allowlist.`);
		const allowlistError = validateSubagentAgentAllowlist(parent.subagentAgents, agentName);
		if (allowlistError) throw new Error(allowlistError);
		const depth = parent.depth + 1;
		const depthError = validateSubagentDepth(depth);
		if (depthError) throw new Error(depthError);
		const ctx = activeContext;
		if (!ctx) throw new Error("Nested subagent context is unavailable.");
		const discovery = discoverAgents(ctx.cwd, parent.agentScope);
		const agent = discovery.agents.find((candidate) => candidate.name === agentName);
		if (!agent) throw new Error(`Nested agent ${agentName} not found. Available: ${formatAgentList(discovery.agents)}`);
		const configuredTools = agent.tools ?? [];
		if (configuredTools.length === 0) throw new Error(`Nested agent ${agentName} has no explicit tools.`);
		const workflow = await queryWorkflowState(pi, undefined);
		const tools = augmentBrowserProxyTools(
			[...new Set([...configuredTools, "ask_question", ...(agent.subagentAgents?.length ? ["subagent"] : [])])],
			browserProxyToolNames(workflow.mode),
		);
		const toolsetReason = validateSubagentToolset(tools, workflow.mode);
		if (toolsetReason) throw new Error(workflow.error ?? toolsetReason);
		const ownershipValue = payload.fileOwnership;
		if (ownershipValue !== undefined && (!Array.isArray(ownershipValue) || ownershipValue.some((item) => typeof item !== "string"))) throw new Error("Nested ownership paths are malformed.");
		const ownership = normalizeOwnership(ownershipValue as string[] | undefined);
		const owner = nextOwner();
		const record: SubagentRecord = {
			owner,
			childSessionId: "pending",
			agentName: agent.name,
			role: inferRole(agent),
			status: "running",
			task: payload.task.trim(),
			tools,
			subagentAgents: agent.subagentAgents,
			depth,
			fileOwnership: ownership,
			agentScope: parent.agentScope,
			browserReadOnly: workflow.mode !== "build",
			parentOwner,
			startedAt: Date.now(),
			steered: false,
			progress: startSubagentProgress(inferRole(agent), { name: owner, parentId: parentOwner, depth }),
		};
		rememberRecord(record);
		try {
			const selectedModel = configuredModel(record.role, ctx);
			const handle = await ensureHost(ctx).launch({
				parentSessionId: ctx.sessionManager.getSessionId(),
				owner,
				role: record.role,
				agent,
				cwd: ctx.cwd,
				task: record.task,
				tools,
				cavemanEnabled: workflow.cavemanEnabled,
				model: selectedModel ? modelReference(selectedModel) : undefined,
				thinkingLevel: configuredEffort(pi, record.role),
				depth,
				subagentAgents: agent.subagentAgents,
				fileOwnership: ownership,
				...callbacksFor(record, false),
			});
			attachHandle(record, handle, false);
			const result = await handle.result;
			return { owner, childSessionId: result.childSessionId, text: result.text };
		} catch (error) {
			record.status = "failed";
			record.finishedAt = Date.now();
			record.error = error instanceof Error ? error.message : String(error);
			record.progress?.finish("failed");
			throw error;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		setSubagentProgressContext(ctx);
		ensureHost(ctx);
	});

	pi.on("session_shutdown", async () => {
		activeContext = undefined;
		const closing = host;
		host = undefined;
		hostSessionId = undefined;
		await closing?.close();
		records.clear();
		clearSubagentProgress();
		setSubagentProgressContext(undefined);
	});

	pi.registerCommand("subagent-model", {
		description: "Choose per-role subagent model defaults for explorer and worker.",
		handler: (args, ctx) => chooseSubagentModel(args, ctx),
	});
	pi.registerCommand("subagent-effort", {
		description: "Choose per-role subagent thinking levels for explorer and worker.",
		handler: (args, ctx) => chooseSubagentEffort(args, ctx, pi),
	});

	pi.registerTool({
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent",
		description: "Start one async subagent. Returns immediately; final result arrives as a new parent turn.",
		parameters: SubagentParams,
		async execute(_toolCallId, params: SubagentParams, signal, _onUpdate, ctx) {
			const agentName = params.agent?.trim() || "worker";
			const agentScope = (params.agentScope ?? DEFAULT_AGENT_SCOPE) as AgentScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agent = discovery.agents.find((candidate) => candidate.name === agentName);
			if (!agent) {
				return { content: [{ type: "text", text: `Agent ${agentName} not found. Available: ${formatAgentList(discovery.agents)}` }], details: { ok: false, error: "Agent not found", discovery } };
			}

			const role = inferRole(agent);
			const workflow = await queryWorkflowState(pi, signal);
			if (role === "explorer") {
				const unsafeReason = validateExplorerTools(agent.tools);
				if (unsafeReason) return { content: [{ type: "text", text: `Refusing to spawn explorer: ${unsafeReason}` }], details: { ok: false, error: unsafeReason, agent: agent.name, tools: agent.tools } };
			}
			const configuredTools = agent.tools ?? [];
			if (configuredTools.length === 0) {
				const reason = `Agent ${agentName} has no explicit tools; refusing to launch child.`;
				return { content: [{ type: "text", text: reason }], details: { ok: false, error: reason } };
			}
			const tools = augmentBrowserProxyTools(
				[...new Set([...configuredTools, "ask_question", ...(agent.subagentAgents?.length ? ["subagent"] : [])])],
				browserProxyToolNames(workflow.mode),
			);
			const toolsetReason = validateSubagentToolset(tools, workflow.mode);
			if (toolsetReason) {
				const reason = workflow.error ?? toolsetReason;
				return { content: [{ type: "text", text: reason }], details: { ok: false, error: reason, workflowMode: workflow.mode ?? "unknown", tools } };
			}
			const ownership = normalizeOwnership(params.fileOwnership);

			const owner = nextOwner();
			const progress = startSubagentProgress(role, { name: owner });
			const record: SubagentRecord = {
				owner,
				childSessionId: "pending",
				agentName: agent.name,
				role,
				status: "running",
				task: params.task.trim(),
				tools,
				subagentAgents: agent.subagentAgents,
				depth: 0,
				fileOwnership: ownership,
				agentScope,
				browserReadOnly: workflow.mode !== "build",
				startedAt: Date.now(),
				steered: false,
				progress,
			};
			rememberRecord(record);

			try {
				const selectedModel = configuredModel(role, ctx);
				const handle = await ensureHost(ctx).launch({
					parentSessionId: ctx.sessionManager.getSessionId(),
					owner,
					role,
					agent,
					cwd: ctx.cwd,
					task: params.task.trim(),
					tools,
					cavemanEnabled: workflow.cavemanEnabled,
					model: selectedModel ? modelReference(selectedModel) : undefined,
					thinkingLevel: configuredEffort(pi, role),
					depth: 0,
					subagentAgents: agent.subagentAgents,
					fileOwnership: ownership,
					signal,
					...callbacksFor(record),
				});
				attachHandle(record, handle);
				return {
					content: [{ type: "text", text: `Subagent ${owner} started asynchronously over ${handle.transport}. Log: ${handle.logPath}. Result will arrive as a new parent turn.` }],
					details: {
						ok: true,
						owner,
						childSessionId: handle.childSessionId,
						agent: agent.name,
						role,
						status: record.status,
						transport: handle.transport,
						logPath: handle.logPath,
						...(handle.cmuxFailureReason ? { cmuxFailureReason: handle.cmuxFailureReason } : {}),
					},
				};
			} catch (error) {
				record.status = "failed";
				record.finishedAt = Date.now();
				record.error = error instanceof Error ? error.message : String(error);
				progress.finish("failed");
				return { content: [{ type: "text", text: `Subagent launch failed: ${record.error}` }], details: { ok: false, owner, error: record.error } };
			}
		},
	});

	pi.registerTool({
		name: SUBAGENT_MESSAGE_TOOL_NAME,
		label: "Message Subagent",
		description: "Send message to a live subagent, answer its pending question, or resume a finished subagent session.",
		parameters: SubagentMessageParams,
		async execute(_toolCallId, params: SubagentMessageParams, signal, _onUpdate, ctx) {
			const owner = params.owner.trim();
			const message = params.message.trim();
			const record = records.get(owner);
			if (!record) return { content: [{ type: "text", text: `Unknown subagent ${owner}.` }], details: { ok: false, error: "Unknown subagent" } };
			if (record.status === "waiting") {
				if (!record.question || params.questionId !== record.question.questionId) {
					return { content: [{ type: "text", text: `Subagent ${owner} is waiting for question ${record.question?.questionId ?? "(unknown)"}.` }], details: { ok: false, error: "Question ID mismatch", questionId: record.question?.questionId } };
				}
				if (!ensureHost(ctx).answerQuestion(owner, record.question.questionId, message)) {
					return { content: [{ type: "text", text: `Could not answer question ${record.question.questionId}; child may have exited.` }], details: { ok: false, error: "Question is no longer pending" } };
				}
				return { content: [{ type: "text", text: `Answer delivered to ${owner}.` }], details: { ok: true, owner, questionId: record.question.questionId } };
			}

			if (record.status === "running") {
				if (!record.handle) return { content: [{ type: "text", text: `Subagent ${owner} has no live handle.` }], details: { ok: false, error: "No live handle" } };
				try {
					await record.handle.request("message", { text: message });
					return { content: [{ type: "text", text: `Message delivered to ${owner}.` }], details: { ok: true, owner, status: record.status } };
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Message to ${owner} failed: ${reason}` }], details: { ok: false, owner, error: reason } };
				}
			}

			if (!record.loadoutPath) return { content: [{ type: "text", text: `Subagent ${owner} has no resumable loadout.` }], details: { ok: false, error: "No loadout" } };
			const workflow = await queryWorkflowState(pi, signal);
			const toolsetReason = validateSubagentToolset(record.tools, workflow.mode);
			if (toolsetReason) {
				const reason = workflow.error ?? toolsetReason;
				return { content: [{ type: "text", text: reason }], details: { ok: false, owner, error: reason, workflowMode: workflow.mode ?? "unknown" } };
			}
			record.progress = startSubagentProgress(record.role, { name: owner });
			record.status = "running";
			record.result = undefined;
			record.error = undefined;
			record.finishedAt = undefined;
			record.steered = false;
			record.question = undefined;
			try {
				const handle = await ensureHost(ctx).resume(record.loadoutPath, message, { signal, ...callbacksFor(record) });
				attachHandle(record, handle);
				return { content: [{ type: "text", text: `Subagent ${owner} resumed asynchronously.` }], details: { ok: true, owner, childSessionId: handle.childSessionId, status: record.status, resumed: true } };
			} catch (error) {
				record.status = "failed";
				record.finishedAt = Date.now();
				record.error = error instanceof Error ? error.message : String(error);
				record.progress?.finish("failed");
				return { content: [{ type: "text", text: `Subagent resume failed: ${record.error}` }], details: { ok: false, owner, error: record.error } };
			}
		},
	});

	pi.registerTool({
		name: SUBAGENTS_LIST_TOOL_NAME,
		label: "List Subagents",
		description: "List running, waiting, completed, and failed async subagents.",
		parameters: SubagentsListParams,
		async execute(_toolCallId, params: SubagentsListParams, _signal, _onUpdate, _ctx) {
			if (params.tail) await readLiveTails();
			const agents = [...records.values()].map((record) => ({
				owner: record.owner,
				childSessionId: record.childSessionId,
				agent: record.agentName,
				role: record.role,
				status: record.status,
				depth: record.depth,
				fileOwnership: record.fileOwnership,
				agentScope: record.agentScope,
				parentOwner: record.parentOwner,
				startedAt: new Date(record.startedAt).toISOString(),
				finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : undefined,
				transport: record.transport,
				logPath: record.logPath,
				sessionFile: record.sessionFile,
				cmuxFailureReason: record.cmuxFailureReason,
				result: record.result ? truncateUtf8(record.result, 2_000) : undefined,
				error: record.error,
				outputTail: record.outputTail,
				question: record.question,
			}));
			const text = agents.length === 0
				? "No subagents."
				: agents.map((agent) => {
					const elapsed = Math.max(0, (Date.parse(agent.finishedAt ?? new Date().toISOString()) - Date.parse(agent.startedAt)) / 1000).toFixed(1);
					const transport = agent.transport ? ` transport=${agent.transport}` : "";
					const log = agent.logPath ? ` log=${agent.logPath}` : "";
					const sessionFile = agent.sessionFile ? ` transcript=${agent.sessionFile}` : "";
					const result = agent.result ? `\n  Result: ${agent.result}` : "";
					const error = agent.error ? `\n  Error: ${agent.error}` : "";
					const tail = agent.outputTail ? `\n  Recent output: ${agent.outputTail}` : "";
					return `${agent.owner} [${agent.status}] agent=${agent.agent} role=${agent.role}${transport}${log}${sessionFile} elapsed=${elapsed}s${result}${error}${tail}`;
				}).join("\n\n");
			return { content: [{ type: "text", text: truncateUtf8(text) }], details: { agents } };
		},
	});
}
