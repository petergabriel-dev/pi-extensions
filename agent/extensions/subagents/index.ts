import * as fs from "node:fs";

import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { discoverAgents, formatAgentList, type AgentRole, type AgentScope } from "./agents.ts";
import { getConcurrencySnapshot, withSubagentSlot, type SlotInfo } from "./concurrency.ts";
import { runSubagent, type ExplorerParsedResult, type WorkerParsedResult } from "./spawn.ts";

const SPAWN_EXPLORER_TOOL_NAME = "spawn_explorer";
const SPAWN_WORKER_TOOL_NAME = "spawn_worker";
const TOOL_NAME = "subagents_inprocess_spike";
const DEBUG_LIST_TOOL_NAME = "subagents_debug_list_agents";
const DEBUG_RUN_TOOL_NAME = "subagents_debug_run_agent";
const DEBUG_CONCURRENCY_TOOL_NAME = "subagents_debug_concurrency";
const DEFAULT_READ_PATH = "agent/AGENTS.md";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FINAL_TEXT_BYTES = 50 * 1024;

const SpikeParams = Type.Object({
	path: Type.Optional(
		Type.String({
			description: `File path the child session should read. Defaults to ${DEFAULT_READ_PATH}.`,
		}),
	),
	prompt: Type.Optional(Type.String({ description: "Optional full child prompt override." })),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Child session timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
			minimum: 1000,
			maximum: 120000,
		}),
	),
});

type SpikeParams = Static<typeof SpikeParams>;

const DebugListParams = Type.Object({
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Which agent definitions to discover. Defaults to "user".',
			default: "user",
		}),
	),
});

type DebugListParams = Static<typeof DebugListParams>;

const DebugRunParams = Type.Object({
	agent: StringEnum(["explorer", "worker"] as const, { description: "Agent role to run." }),
	task: Type.String({ description: "Task string to send to the child subagent." }),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Which agent definitions to discover. Defaults to "user".',
			default: "user",
		}),
	),
	useCurrentModel: Type.Optional(
		Type.Boolean({
			description: "Debug-only: ignore the agent definition's model and use the current parent model.",
			default: false,
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Child timeout in milliseconds.", minimum: 1000, maximum: 120000 })),
});

type DebugRunParams = Static<typeof DebugRunParams>;

const DebugConcurrencyParams = Type.Object({
	count: Type.Optional(Type.Number({ description: "Number of simulated spawns.", minimum: 1, maximum: 20, default: 5 })),
	delayMs: Type.Optional(Type.Number({ description: "Milliseconds each simulated spawn holds its slot.", minimum: 1, maximum: 5000, default: 100 })),
	role: Type.Optional(StringEnum(["explorer", "worker"] as const, { description: "Role lane to exercise.", default: "worker" })),
	explorerLane: Type.Optional(Type.Boolean({ description: "Use the reserved explorer lane for explorer role.", default: false })),
});

type DebugConcurrencyParams = Static<typeof DebugConcurrencyParams>;

const SpawnExplorerParams = Type.Object({
	task: Type.String({ description: "Discovery task for the read-only explorer subagent." }),
	agent: Type.Optional(
		Type.String({
			description: 'Explorer agent definition name. Defaults to "explorer".',
			default: "explorer",
		}),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Which agent definitions to discover. Defaults to "user".',
			default: "user",
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Child timeout in milliseconds.", minimum: 1000, maximum: 120000 })),
});

type SpawnExplorerParams = Static<typeof SpawnExplorerParams>;

const SpawnWorkerParams = Type.Object({
	task: Type.String({ description: "Scoped implementation task for the worker subagent. Requires workflow Build mode." }),
	agent: Type.Optional(
		Type.String({
			description: 'Worker agent definition name. Defaults to "worker".',
			default: "worker",
		}),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Which agent definitions to discover. Defaults to "user".',
			default: "user",
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Child timeout in milliseconds.", minimum: 1000, maximum: 120000 })),
	fileOwnership: Type.Optional(
		Type.Array(Type.String(), {
			description: "Paths or globs this worker is expected to modify. Parallel overlapping ownership is refused.",
			default: [],
		}),
	),
});

type SpawnWorkerParams = Static<typeof SpawnWorkerParams>;

type WorkflowMode = "off" | "discuss" | "plan" | "build";

interface WorkflowModeQueryResult {
	ok: boolean;
	mode?: WorkflowMode;
	error?: string;
}

const READ_ONLY_EXPLORER_TOOLS = new Set(["read", "grep", "find", "ls"]);

interface ParentSnapshot {
	sessionFile: string | undefined;
	leafId: string | null;
	entryCount: number;
	branchLength: number;
}

interface ChildToolCallSummary {
	toolName: string;
	argsPreview: string;
}

interface SpikeDetails {
	ok: boolean;
	readToolCalled: boolean;
	childSessionFile?: string;
	childSessionFileExists: boolean;
	childActiveTools: string[];
	childEventCounts: Record<string, number>;
	childToolCalls: ChildToolCallSummary[];
	childFinalText: string;
	parentBefore: ParentSnapshot;
	parentAfter: ParentSnapshot;
	parentUnchangedDuringExecute: boolean;
	error?: string;
}

const CHILD_SYSTEM_PROMPT = `You are a throwaway in-process subagent spike.

Your job is only to prove that a child AgentSession can run inside an extension tool execute() without inheriting parent state.
Use only the read/grep tools you were given. Read the requested file before answering.
Return a concise final answer that starts with SPIKE_CHILD_OK and mentions the file you inspected.`;

function snapshotParent(ctx: ExtensionContext): ParentSnapshot {
	return {
		sessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		entryCount: ctx.sessionManager.getEntries().length,
		branchLength: ctx.sessionManager.getBranch().length,
	};
}

function sameSnapshot(a: ParentSnapshot, b: ParentSnapshot): boolean {
	return (
		a.sessionFile === b.sessionFile &&
		a.leafId === b.leafId &&
		a.entryCount === b.entryCount &&
		a.branchLength === b.branchLength
	);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[truncated to ${maxBytes} bytes]`;
}

function extractLastAssistantText(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string {
	const direct = session.getLastAssistantText();
	if (direct) return direct;
	for (const message of [...session.messages].reverse()) {
		if (message.role !== "assistant") continue;
		return message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function buildChildPrompt(params: SpikeParams): string {
	if (params.prompt?.trim()) return params.prompt.trim();
	const readPath = params.path?.trim() || DEFAULT_READ_PATH;
	return [
		`Use the read tool to read this file: ${readPath}`,
		"Then return a concise summary beginning with SPIKE_CHILD_OK.",
		"Do not edit files or run shell commands.",
	].join("\n");
}

async function selectModel(ctx: ExtensionContext): Promise<Model<any> | undefined> {
	if (ctx.model) return ctx.model;
	const available = await Promise.resolve(ctx.modelRegistry.getAvailable());
	return available[0];
}

function createIsolatedLoader(cwd: string, agentDir: string, settingsManager: SettingsManager): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: CHILD_SYSTEM_PROMPT,
		appendSystemPrompt: [],
		appendSystemPromptOverride: () => [],
	});
}

async function runInProcessSpike(
	params: SpikeParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<SpikeDetails> {
	const parentBefore = snapshotParent(ctx);
	const eventCounts: Record<string, number> = {};
	const childToolCalls: ChildToolCallSummary[] = [];
	let childSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;

	const baseDetails = (): Omit<SpikeDetails, "ok" | "parentAfter" | "parentUnchangedDuringExecute"> => ({
		readToolCalled: childToolCalls.some((call) => call.toolName === "read"),
		childSessionFile: childSession?.sessionFile,
		childSessionFileExists: Boolean(childSession?.sessionFile && fs.existsSync(childSession.sessionFile)),
		childActiveTools: childSession?.getActiveToolNames() ?? [],
		childEventCounts: { ...eventCounts },
		childToolCalls: [...childToolCalls],
		childFinalText: childSession ? truncateUtf8(extractLastAssistantText(childSession), MAX_FINAL_TEXT_BYTES) : "",
		parentBefore,
	});

	try {
		const model = await selectModel(ctx);
		if (!model) throw new Error("No model is available for the child spike session.");

		const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		} as never);
		const resourceLoader = createIsolatedLoader(ctx.cwd, agentDir, settingsManager);
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd: ctx.cwd,
			agentDir,
			model,
			modelRegistry: ctx.modelRegistry,
			tools: ["read", "grep"],
			resourceLoader,
			sessionManager: SessionManager.create(ctx.cwd),
			settingsManager,
		});
		childSession = result.session;

		unsubscribe = childSession.subscribe((event: any) => {
			eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
			if (event.type === "tool_execution_start") {
				childToolCalls.push({
					toolName: String(event.toolName ?? ""),
					argsPreview: truncateUtf8(JSON.stringify(event.args ?? {}), 1000),
				});
			}
		});

		const abortChild = () => {
			void childSession?.abort().catch(() => undefined);
		};
		if (signal) {
			if (signal.aborted) abortChild();
			signal.addEventListener("abort", abortChild, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abortChild);
		}

		const promptPromise = childSession.prompt(buildChildPrompt(params), {
			expandPromptTemplates: false,
			source: "extension",
		});
		void promptPromise.catch(() => undefined);

		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => {
				abortChild();
				reject(new Error(`Child spike session timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
		});

		await Promise.race([promptPromise, timeoutPromise]);

		const parentAfter = snapshotParent(ctx);
		const childFinalText = truncateUtf8(extractLastAssistantText(childSession), MAX_FINAL_TEXT_BYTES);
		const readToolCalled = childToolCalls.some((call) => call.toolName === "read");
		const childSessionFileExists = Boolean(childSession.sessionFile && fs.existsSync(childSession.sessionFile));
		const parentUnchangedDuringExecute = sameSnapshot(parentBefore, parentAfter);
		const childActiveTools = childSession.getActiveToolNames();
		const ok = Boolean(childFinalText && readToolCalled && childSessionFileExists && parentUnchangedDuringExecute);

		return {
			ok,
			readToolCalled,
			childSessionFile: childSession.sessionFile,
			childSessionFileExists,
			childActiveTools,
			childEventCounts: { ...eventCounts },
			childToolCalls: [...childToolCalls],
			childFinalText,
			parentBefore,
			parentAfter,
			parentUnchangedDuringExecute,
		};
	} catch (error) {
		const parentAfter = snapshotParent(ctx);
		return {
			...baseDetails(),
			ok: false,
			parentAfter,
			parentUnchangedDuringExecute: sameSnapshot(parentBefore, parentAfter),
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		removeAbortListener?.();
		unsubscribe?.();
		childSession?.dispose();
	}
}

function formatToolResult(details: SpikeDetails): string {
	const lines = [
		details.ok ? "In-process subagent spike OK." : "In-process subagent spike FAILED.",
		`Child session file: ${details.childSessionFile ?? "(none)"}`,
		`Child session file exists: ${details.childSessionFileExists ? "yes" : "no"}`,
		`Child active tools: ${details.childActiveTools.join(", ") || "(none)"}`,
		`Child read tool called: ${details.readToolCalled ? "yes" : "no"}`,
		`Parent branch unchanged during execute: ${details.parentUnchangedDuringExecute ? "yes" : "no"}`,
	];
	if (details.error) lines.push(`Error: ${details.error}`);
	if (details.childFinalText) lines.push("", "Child final text:", details.childFinalText);
	return lines.join("\n");
}

function validateExplorerTools(tools: string[] | undefined): string | undefined {
	const activeTools = tools ?? [...READ_ONLY_EXPLORER_TOOLS];
	const unsafeTools = activeTools.filter((tool) => !READ_ONLY_EXPLORER_TOOLS.has(tool));
	if (unsafeTools.length > 0) return `Explorer agent includes non-read-only tool(s): ${unsafeTools.join(", ")}.`;
	return undefined;
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "off" || value === "discuss" || value === "plan" || value === "build";
}

const runningWorkerOwnership = new Map<string, Set<string>>();
let nextWorkerRunId = 0;

function normalizeOwnership(paths: string[] | undefined): string[] {
	return [...new Set((paths ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

function ownershipOverlaps(a: string, b: string): boolean {
	const left = a.replace(/\/+$|\/\*\*?$|\/\*$/g, "");
	const right = b.replace(/\/+$|\/\*\*?$|\/\*$/g, "");
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function findOwnershipConflict(ownership: string[]): { runId: string; path: string; existingPath: string } | undefined {
	for (const path of ownership) {
		for (const [runId, existing] of runningWorkerOwnership.entries()) {
			for (const existingPath of existing) {
				if (ownershipOverlaps(path, existingPath)) return { runId, path, existingPath };
			}
		}
	}
	return undefined;
}

async function withWorkerOwnership<T>(ownership: string[], fn: (runId: string) => Promise<T>): Promise<T> {
	const runId = `worker-${++nextWorkerRunId}`;
	if (ownership.length > 0) runningWorkerOwnership.set(runId, new Set(ownership));
	try {
		return await fn(runId);
	} finally {
		runningWorkerOwnership.delete(runId);
	}
}

function addConcurrencyDetails<T extends object>(details: T, slot: SlotInfo, extra: Record<string, unknown> = {}): T & { concurrency: SlotInfo } {
	return { ...details, ...extra, concurrency: slot };
}

function queryWorkflowMode(pi: ExtensionAPI, signal: AbortSignal | undefined, timeoutMs = 1000): Promise<WorkflowModeQueryResult> {
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;

		const settle = (result: WorkflowModeQueryResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			removeAbortListener?.();
			unsubscribe?.();
			resolve(result);
		};

		const abort = () => settle({ ok: false, error: "Workflow mode query aborted." });
		if (signal?.aborted) return abort();
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abort);
		}

		unsubscribe = pi.events.on("workflow-modes:state", (data: unknown) => {
			const mode = (data as { mode?: unknown } | undefined)?.mode;
			if (!isWorkflowMode(mode)) return settle({ ok: false, error: "workflow-modes returned an invalid mode state." });
			settle({ ok: true, mode });
		});

		timeoutId = setTimeout(() => {
			settle({ ok: false, error: "Timed out waiting for workflow-modes:state; refusing to spawn worker." });
		}, timeoutMs);

		try {
			pi.events.emit("workflow-modes:get", undefined);
		} catch (error) {
			settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

export default function subagentsSpikeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: SPAWN_EXPLORER_TOOL_NAME,
		label: "Spawn Explorer",
		description:
			"Run a read-only explorer subagent in an isolated child session and return structured findings without adding the child transcript to parent context.",
		parameters: SpawnExplorerParams,
		async execute(_toolCallId, params: SpawnExplorerParams, signal, _onUpdate, ctx) {
			const agentName = params.agent?.trim() || "explorer";
			const agentScope = (params.agentScope ?? "user") as AgentScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agent = discovery.agents.find((candidate) => candidate.name === agentName);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Explorer agent ${agentName} not found. Available: ${formatAgentList(discovery.agents)}` }],
					details: { ok: false, error: "Explorer agent not found", discovery },
				};
			}

			const unsafeReason = validateExplorerTools(agent.tools);
			if (unsafeReason) {
				return {
					content: [{ type: "text", text: `Refusing to spawn explorer: ${unsafeReason}` }],
					details: { ok: false, error: unsafeReason, agent: agent.name, tools: agent.tools },
				};
			}

			return withSubagentSlot("explorer", ctx.cwd, signal, async (slot) => {
				const result = await runSubagent({
					agent: { ...agent, tools: agent.tools ?? [...READ_ONLY_EXPLORER_TOOLS] },
					role: "explorer",
					task: params.task,
					ctx,
					signal,
					timeoutMs: params.timeoutMs,
				});

				if (!result.ok) {
					return {
						content: [{ type: "text", text: `Explorer failed: ${result.error}` }],
						details: addConcurrencyDetails(result, slot),
					};
				}

				const parsed = result.parsed as ExplorerParsedResult;
				return {
					content: [
						{
							type: "text",
							text: [
								`Explorer summary: ${parsed.summary}`,
								parsed.filesInspected.length > 0 ? `Files inspected: ${parsed.filesInspected.join(", ")}` : "Files inspected: none reported",
								parsed.openQuestions.length > 0 ? `Open questions: ${parsed.openQuestions.join("; ")}` : "Open questions: none",
							].join("\n"),
						},
					],
					details: addConcurrencyDetails(result, slot),
				};
			});
		},
	});

	pi.registerTool({
		name: SPAWN_WORKER_TOOL_NAME,
		label: "Spawn Worker",
		description:
			"Run a coding worker subagent in an isolated child session. Refuses unless workflow-modes reports Build mode.",
		parameters: SpawnWorkerParams,
		async execute(_toolCallId, params: SpawnWorkerParams, signal, _onUpdate, ctx) {
			const workflowMode = await queryWorkflowMode(pi, signal);
			if (!workflowMode.ok || workflowMode.mode !== "build") {
				const modeLabel = workflowMode.mode ?? "unknown";
				const reason = workflowMode.error ?? `spawn_worker is blocked in ${modeLabel} mode. Switch to Build mode with /mode build.`;
				return {
					content: [{ type: "text", text: reason }],
					details: { ok: false, error: reason, workflowMode: modeLabel },
				};
			}

			const agentName = params.agent?.trim() || "worker";
			const agentScope = (params.agentScope ?? "user") as AgentScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agent = discovery.agents.find((candidate) => candidate.name === agentName);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Worker agent ${agentName} not found. Available: ${formatAgentList(discovery.agents)}` }],
					details: { ok: false, error: "Worker agent not found", workflowMode: workflowMode.mode, discovery },
				};
			}

			const ownership = normalizeOwnership(params.fileOwnership);
			const conflict = findOwnershipConflict(ownership);
			if (conflict) {
				const reason = `spawn_worker ownership overlaps running ${conflict.runId}: requested ${conflict.path}, existing ${conflict.existingPath}.`;
				return {
					content: [{ type: "text", text: reason }],
					details: { ok: false, error: reason, workflowMode: workflowMode.mode, fileOwnership: ownership, conflict },
				};
			}

			return withWorkerOwnership(ownership, (workerRunId) =>
				withSubagentSlot("worker", ctx.cwd, signal, async (slot) => {
					const result = await runSubagent({
						agent,
						role: "worker",
						task: params.task,
						ctx,
						signal,
						timeoutMs: params.timeoutMs,
					});

					if (!result.ok) {
						return {
							content: [{ type: "text", text: `Worker failed: ${result.error}` }],
							details: addConcurrencyDetails(result, slot, { workflowMode: workflowMode.mode, fileOwnership: ownership, workerRunId }),
						};
					}

					const parsed = result.parsed as WorkerParsedResult;
					return {
						content: [
							{
								type: "text",
								text: [
									`Worker summary: ${parsed.summary}`,
									parsed.filesTouched.length > 0 ? `Files touched: ${parsed.filesTouched.join(", ")}` : "Files touched: none reported",
									parsed.followUps.length > 0 ? `Follow-ups: ${parsed.followUps.join("; ")}` : "Follow-ups: none",
									parsed.openQuestions.length > 0 ? `Open questions: ${parsed.openQuestions.join("; ")}` : "Open questions: none",
								].join("\n"),
							},
						],
						details: addConcurrencyDetails(result, slot, { workflowMode: workflowMode.mode, fileOwnership: ownership, workerRunId }),
					};
				}),
			);
		},
	});

	pi.registerTool({
		name: DEBUG_CONCURRENCY_TOOL_NAME,
		label: "Subagents Debug Concurrency",
		description:
			"Debug helper for subagents development: exercise the concurrency limiter with simulated subagent runs and report queueing behavior.",
		parameters: DebugConcurrencyParams,
		async execute(_toolCallId, params: DebugConcurrencyParams, signal, _onUpdate, ctx) {
			const count = Math.max(1, Math.min(20, Math.floor(params.count ?? 5)));
			const delayMs = Math.max(1, Math.min(5000, Math.floor(params.delayMs ?? 100)));
			const role = (params.role ?? "worker") as AgentRole;
			const started: Array<{ index: number; slot: SlotInfo; startedAt: number }> = [];
			const completed: Array<{ index: number; completedAt: number }> = [];
			const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			const before = getConcurrencySnapshot(ctx.cwd);
			await Promise.all(
				Array.from({ length: count }, (_unused, index) =>
					withSubagentSlot(
						role,
						ctx.cwd,
						signal,
						async (slot) => {
							started.push({ index, slot, startedAt: Date.now() });
							await sleep(delayMs);
							completed.push({ index, completedAt: Date.now() });
						},
						{ explorerLane: Boolean(params.explorerLane) },
					),
				),
			);
			const after = getConcurrencySnapshot(ctx.cwd);
			const maxActive = Math.max(0, ...started.map((item) => item.slot.activeAtAcquire));
			const queued = started.filter((item) => item.slot.queuedMs > 0).length;
			return {
				content: [
					{
						type: "text",
						text: `Simulated ${count} ${role} spawn(s); max active ${maxActive}; queued ${queued}; cap ${started[0]?.slot.capacity ?? "unknown"}.`,
					},
				],
				details: { ok: true, before, after, count, delayMs, role, maxActive, queued, started, completed },
			};
		},
	});

	pi.registerTool({
		name: DEBUG_LIST_TOOL_NAME,
		label: "Subagents Debug List Agents",
		description:
			"Debug helper for subagents development: list discovered agent definitions with source, model, and tools. Defaults to user-level ~/.pi/agent/agents/*.md definitions.",
		parameters: DebugListParams,
		async execute(_toolCallId, params: DebugListParams, _signal, _onUpdate, ctx) {
			const agentScope = (params.agentScope ?? "user") as AgentScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			return {
				content: [
					{
						type: "text",
						text: [
							`Agent scope: ${discovery.agentScope}`,
							`User agents dir: ${discovery.userAgentsDir}`,
							`Project agents dir: ${discovery.projectAgentsDir ?? "(none)"}`,
							"",
							formatAgentList(discovery.agents),
						].join("\n"),
					},
				],
				details: discovery,
			};
		},
	});

	pi.registerTool({
		name: DEBUG_RUN_TOOL_NAME,
		label: "Subagents Debug Run Agent",
		description:
			"Debug helper for subagents development: run a discovered explorer or worker through the core in-process runSubagent module and return its parsed structured result.",
		parameters: DebugRunParams,
		async execute(_toolCallId, params: DebugRunParams, signal, _onUpdate, ctx) {
			const agentScope = (params.agentScope ?? "user") as AgentScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Unknown agent ${params.agent}. Available: ${formatAgentList(discovery.agents)}` }],
					details: { ok: false, discovery },
				};
			}

			const result = await runSubagent({
				agent,
				role: params.agent as AgentRole,
				task: params.task,
				ctx,
				signal,
				timeoutMs: params.timeoutMs,
				modelOverride: params.useCurrentModel ? ctx.model : undefined,
			});
			return {
				content: [
					{
						type: "text",
						text: result.ok
							? `Subagent ${params.agent} OK.\n\n${JSON.stringify(result.parsed, null, 2)}`
							: `Subagent ${params.agent} FAILED: ${result.error}\n\n${JSON.stringify(result.parsed ?? {}, null, 2)}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagents In-Process Spike",
		description:
			"Throwaway verification spike: create a persisted child AgentSession in-process from this tool execute(), give it read/grep only, prompt it to read one file, stream events, return final text, and report parent branch isolation.",
		promptSnippet: "Run a throwaway in-process child session spike for subagent architecture validation.",
		promptGuidelines: [
			`Use ${TOOL_NAME} only when explicitly asked to run the subagents in-process spike.`,
			`${TOOL_NAME} is diagnostic-only; do not use it for ordinary code search or implementation work.`,
		],
		parameters: SpikeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await runInProcessSpike(params, ctx, signal);
			return {
				content: [{ type: "text", text: formatToolResult(details) }],
				details,
			};
		},
	});
}
