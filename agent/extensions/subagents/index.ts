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
import { SubagentLaunchHost, type SubagentResult } from "./launch.ts";
import {
	clearSubagentProgress,
	setSubagentProgressContext,
	startSubagentProgress,
	type ProgressHandle,
} from "./progress.ts";

const SUBAGENT_TOOL_NAME = "subagent";
const SUBAGENTS_LIST_TOOL_NAME = "subagents_list";
const AGENT_SCOPE_DESCRIPTION =
	"Bundled defaults are always present; user is the default scope, project uses the nearest project override, and both applies user then project.";
const SUBAGENT_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_AGENT_SCOPE: AgentScope = "user";
const MAX_FINAL_TEXT_BYTES = 50 * 1024;
const MAX_TRACKED_RUNS = 100;

const SubagentParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: MAX_FINAL_TEXT_BYTES, description: "Task for async subagent. Result arrives as a later parent turn." }),
	agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Agent definition name. Defaults to "worker".' })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: AGENT_SCOPE_DESCRIPTION,
			default: DEFAULT_AGENT_SCOPE,
		}),
	),
});
type SubagentParams = Static<typeof SubagentParams>;

const SubagentsListParams = Type.Object({});
type SubagentsListParams = Static<typeof SubagentsListParams>;

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
}

export const READ_ONLY_EXPLORER_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"browser_goto",
	"browser_eval",
	"browser_console",
	"browser_network",
	"browser_fill",
	"browser_click",
	"browser_screenshot",
	"browser_close",
]);

export const BROWSER_PROXY_BUILD_TOOLS = [
	"browser_goto",
	"browser_eval",
	"browser_console",
	"browser_network",
	"browser_fill",
	"browser_click",
	"browser_screenshot",
	"browser_close",
] as const;
export const BROWSER_PROXY_READ_ONLY_TOOLS = ["browser_console", "browser_screenshot", "browser_network"] as const;
export type BrowserProxyName = typeof BROWSER_PROXY_BUILD_TOOLS[number];

export function validateExplorerTools(tools: string[] | undefined): string | undefined {
	const activeTools = tools ?? ["read", "grep", "find", "ls"];
	const unsafeTools = activeTools.filter((tool) => !READ_ONLY_EXPLORER_TOOLS.has(tool));
	return unsafeTools.length > 0 ? `Explorer agent includes non-repository-read-only tool(s): ${unsafeTools.join(", ")}.` : undefined;
}

export function browserProxyToolNames(mode: WorkflowMode | undefined): BrowserProxyName[] {
	return [...(mode === "build" ? BROWSER_PROXY_BUILD_TOOLS : BROWSER_PROXY_READ_ONLY_TOOLS)];
}

export function augmentBrowserProxyTools(tools: string[] | undefined, names: readonly BrowserProxyName[]): string[] {
	return [...new Set([...(tools ?? ["read", "grep", "find", "ls"]), ...names])];
}

interface SubagentRecord {
	owner: string;
	childSessionId: string;
	agentName: string;
	role: AgentRole;
	status: "running" | "waiting" | "done" | "failed";
	task: string;
	startedAt: number;
	finishedAt?: number;
	result?: string;
	error?: string;
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
	const records = new Map<string, SubagentRecord>();

	const ensureHost = (ctx: ExtensionContext): SubagentLaunchHost => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (host && hostSessionId === sessionId) return host;
		const previous = host;
		host = new SubagentLaunchHost({ parentSessionId: sessionId });
		hostSessionId = sessionId;
		void previous?.close();
		return host;
	};

	const rememberRecord = (record: SubagentRecord): void => {
		records.set(record.owner, record);
		while (records.size > MAX_TRACKED_RUNS) records.delete(records.keys().next().value as string);
	};

	pi.on("session_start", (_event, ctx) => {
		setSubagentProgressContext(ctx);
		ensureHost(ctx);
	});

	pi.on("session_shutdown", async () => {
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
			if (role === "worker" && (!workflow.ok || workflow.mode !== "build")) {
				const reason = workflow.error ?? `Subagent ${agentName} is blocked outside Build mode. Switch to Build mode with /mode build.`;
				return { content: [{ type: "text", text: reason }], details: { ok: false, error: reason, workflowMode: workflow.mode ?? "unknown" } };
			}
			if (role === "explorer") {
				const unsafeReason = validateExplorerTools(agent.tools);
				if (unsafeReason) return { content: [{ type: "text", text: `Refusing to spawn explorer: ${unsafeReason}` }], details: { ok: false, error: unsafeReason, agent: agent.name, tools: agent.tools } };
			}
			const tools = agent.tools ?? [];
			if (tools.length === 0) {
				const reason = `Agent ${agentName} has no explicit tools; refusing to launch unrestricted child.`;
				return { content: [{ type: "text", text: reason }], details: { ok: false, error: reason } };
			}

			const owner = nextOwner();
			const progress = startSubagentProgress(role, { name: owner });
			const record: SubagentRecord = {
				owner,
				childSessionId: "pending",
				agentName: agent.name,
				role,
				status: "running",
				task: params.task.trim(),
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
					signal,
					onResult: (text) => steerResult(pi, record, text),
				});
				record.childSessionId = handle.childSessionId;
				void handle.result.then((result: SubagentResult) => {
					record.status = "done";
					record.finishedAt = Date.now();
					record.result = result.text;
					if (!record.steered) steerResult(pi, record, result.text);
					record.progress?.finish("done");
				}).catch((error: unknown) => {
					record.status = "failed";
					record.finishedAt = Date.now();
					record.error = error instanceof Error ? error.message : String(error);
					record.progress?.finish("failed");
				});
				return {
					content: [{ type: "text", text: `Subagent ${owner} started asynchronously. Result will arrive as a new parent turn.` }],
					details: { ok: true, owner, childSessionId: handle.childSessionId, agent: agent.name, role, status: record.status },
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
		name: SUBAGENTS_LIST_TOOL_NAME,
		label: "List Subagents",
		description: "List running, waiting, completed, and failed async subagents.",
		parameters: SubagentsListParams,
		async execute(_toolCallId, _params: SubagentsListParams, _signal, _onUpdate, _ctx) {
			const agents = [...records.values()].map((record) => ({
				owner: record.owner,
				childSessionId: record.childSessionId,
				agent: record.agentName,
				role: record.role,
				status: record.status,
				startedAt: new Date(record.startedAt).toISOString(),
				finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : undefined,
				result: record.result ? truncateUtf8(record.result, 2_000) : undefined,
				error: record.error,
			}));
			const text = agents.length === 0
				? "No subagents."
				: agents.map((agent) => {
					const elapsed = Math.max(0, (Date.parse(agent.finishedAt ?? new Date().toISOString()) - Date.parse(agent.startedAt)) / 1000).toFixed(1);
					const result = agent.result ? `\n  Result: ${agent.result}` : "";
					const error = agent.error ? `\n  Error: ${agent.error}` : "";
					return `${agent.owner} [${agent.status}] agent=${agent.agent} role=${agent.role} elapsed=${elapsed}s${result}${error}`;
				}).join("\n\n");
			return { content: [{ type: "text", text: truncateUtf8(text) }], details: { agents } };
		},
	});
}
