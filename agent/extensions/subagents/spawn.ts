import * as fs from "node:fs";

import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AgentConfig, AgentRole } from "./agents.ts";
import type { SubagentParentThinkingLevel } from "./effort.ts";
import type { ProgressHandle } from "./progress.ts";
import { createSubagentWatchdog, type SubagentTimeoutKind, type SubagentWatchdog } from "./timeout.ts";
import type { SubagentTimeoutPolicy } from "./timeout-policy.ts";
const MAX_RETURN_BYTES = 50 * 1024;

export interface ExplorerParsedResult {
	summary: string;
	findings: string[];
	filesInspected: string[];
	openQuestions: string[];
}

export interface WorkerParsedResult {
	summary: string;
	filesTouched: string[];
	commandsRun: string[];
	followUps: string[];
	openQuestions: string[];
}

export type ParsedSubagentResult = ExplorerParsedResult | WorkerParsedResult;
export type SubagentFailureKind = SubagentTimeoutKind | "error";

export interface SubagentToolCallSummary {
	toolName: string;
	argsPreview: string;
}

export interface SubagentRunSuccess {
	ok: true;
	role: AgentRole;
	agentName: string;
	sessionFile?: string;
	sessionFileExists: boolean;
	model?: string;
	activeTools: string[];
	eventCounts: Record<string, number>;
	toolCalls: SubagentToolCallSummary[];
	rawText: string;
	parsed: ParsedSubagentResult;
}

export interface SubagentRunFailure {
	ok: false;
	role: AgentRole;
	agentName: string;
	sessionFile?: string;
	sessionFileExists: boolean;
	activeTools: string[];
	eventCounts: Record<string, number>;
	toolCalls: SubagentToolCallSummary[];
	rawText: string;
	parsed?: ParsedSubagentResult;
	error: string;
	failureKind: SubagentFailureKind;
	partialWork: boolean;
}

export type SubagentRunResult = SubagentRunSuccess | SubagentRunFailure;

export interface RunSubagentOptions {
	agent: AgentConfig;
	role?: AgentRole;
	task: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	timeoutPolicy: SubagentTimeoutPolicy;
	modelOverride?: Model<any>;
	thinkingLevel?: SubagentParentThinkingLevel;
	customTools?: ToolDefinition[];
	progress?: ProgressHandle;
}

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

function isAgentRole(value: string): value is AgentRole {
	return value === "explorer" || value === "worker";
}

function inferRole(agent: AgentConfig, explicitRole?: AgentRole): AgentRole {
	if (explicitRole) return explicitRole;
	if (isAgentRole(agent.name)) return agent.name;
	return "worker";
}

export function truncateUtf8(text: string, maxBytes = MAX_RETURN_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[truncated to ${maxBytes} bytes]`;
}

function getLastAssistantMessage(session: Session) {
	for (const message of [...session.messages].reverse()) {
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function extractLastAssistantText(session: Session): string {
	const direct = session.getLastAssistantText();
	if (direct) return direct;
	const lastAssistant = getLastAssistantMessage(session);
	if (!lastAssistant) return "";
	return lastAssistant.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function normalizeListItem(line: string): string | undefined {
	const cleaned = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
	if (!cleaned || /^none\.?$/i.test(cleaned)) return undefined;
	return cleaned;
}

function sectionMap(markdown: string): Map<string, string> {
	const sections = new Map<string, string>();
	const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
	if (matches.length === 0) return sections;

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const title = match[1]!.trim().toLowerCase();
		const start = match.index! + match[0]!.length;
		const end = matches[index + 1]?.index ?? markdown.length;
		sections.set(title, markdown.slice(start, end).trim());
	}
	return sections;
}

function getSection(sections: Map<string, string>, ...names: string[]): string {
	for (const name of names) {
		const found = sections.get(name.toLowerCase());
		if (found) return found;
	}
	return "";
}

function linesFromSection(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(normalizeListItem)
		.filter((line): line is string => Boolean(line));
}

function filesFromSection(text: string): string[] {
	const files = new Set<string>();
	for (const line of linesFromSection(text)) {
		const backtick = line.match(/`([^`]+)`/);
		files.add((backtick?.[1] ?? line.split(/\s+/)[0] ?? line).trim());
	}
	return [...files].filter(Boolean);
}

function firstNonEmptyLine(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? "";
}

export function parseExplorerResult(rawText: string): ExplorerParsedResult {
	const text = truncateUtf8(rawText.trim());
	const sections = sectionMap(text);
	const filesRetrieved = getSection(sections, "files retrieved", "files inspected");
	const keyCode = getSection(sections, "key code", "findings");
	const architecture = getSection(sections, "architecture", "summary");
	const startHere = getSection(sections, "start here");
	const openQuestions = linesFromSection(getSection(sections, "open questions", "questions"));
	const findings = [
		...linesFromSection(keyCode),
		...linesFromSection(architecture),
		...linesFromSection(startHere),
	].filter(Boolean);
	const fallbackSummary = firstNonEmptyLine(text) || "No structured explorer summary returned.";

	return {
		summary: firstNonEmptyLine(architecture) || firstNonEmptyLine(startHere) || fallbackSummary,
		findings,
		filesInspected: filesFromSection(filesRetrieved),
		openQuestions,
	};
}

export function parseWorkerResult(rawText: string): WorkerParsedResult {
	const text = truncateUtf8(rawText.trim());
	const sections = sectionMap(text);
	const summary = getSection(sections, "summary", "completed");
	const filesTouched = getSection(sections, "files touched", "files changed");
	const commands = getSection(sections, "commands", "commands run");
	const followUps = getSection(sections, "follow-ups", "follow ups", "notes");
	const openQuestions = getSection(sections, "open questions", "questions");

	return {
		summary: firstNonEmptyLine(summary) || firstNonEmptyLine(text) || "No structured worker summary returned.",
		filesTouched: filesFromSection(filesTouched),
		commandsRun: linesFromSection(commands),
		followUps: linesFromSection(followUps),
		openQuestions: linesFromSection(openQuestions),
	};
}

export function parseSubagentResult(role: AgentRole, rawText: string): ParsedSubagentResult {
	return role === "explorer" ? parseExplorerResult(rawText) : parseWorkerResult(rawText);
}

function resolveModelReference(reference: string | undefined, ctx: ExtensionContext): Model<any> | undefined {
	if (!reference) return undefined;
	const trimmed = reference.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex > 0) {
		const provider = trimmed.slice(0, slashIndex);
		const modelId = trimmed.slice(slashIndex + 1);
		return ctx.modelRegistry.find(provider, modelId);
	}

	const available = ctx.modelRegistry.getAll();
	return available.find((model) => model.id === trimmed) ?? available.find((model) => model.id.includes(trimmed));
}

async function selectModel(agent: AgentConfig, ctx: ExtensionContext, modelOverride?: Model<any>): Promise<Model<any> | undefined> {
	return modelOverride ?? resolveModelReference(agent.model, ctx) ?? ctx.model ?? (await Promise.resolve(ctx.modelRegistry.getAvailable()))[0];
}

function createSubagentResourceLoader(agent: AgentConfig, cwd: string, agentDir: string, settingsManager: SettingsManager): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: agent.systemPrompt,
		appendSystemPrompt: [],
		appendSystemPromptOverride: () => [],
	});
}

function emptyFailureBase(role: AgentRole, agent: AgentConfig, session: Session | undefined, eventCounts: Record<string, number>, toolCalls: SubagentToolCallSummary[]) {
	return {
		role,
		agentName: agent.name,
		sessionFile: session?.sessionFile,
		sessionFileExists: Boolean(session?.sessionFile && fs.existsSync(session.sessionFile)),
		activeTools: session?.getActiveToolNames() ?? [],
		eventCounts: { ...eventCounts },
		toolCalls: [...toolCalls],
		rawText: session ? truncateUtf8(extractLastAssistantText(session)) : "",
	};
}

function hasPartialWork(eventCounts: Record<string, number>): boolean {
	return (eventCounts.tool_execution_start ?? 0) > 0;
}

function formatTimeoutThreshold(ms: number): string {
	const seconds = ms / 1000;
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

function timeoutErrorMessage(kind: SubagentTimeoutKind, idleMs: number, maxTotalMs: number): string {
	return kind === "idle"
		? `idle timeout: no activity for ${formatTimeoutThreshold(idleMs)}`
		: `max-total timeout: exceeded ${formatTimeoutThreshold(maxTotalMs)}`;
}

class SubagentTimeoutError extends Error {
	constructor(readonly kind: SubagentTimeoutKind, message: string) {
		super(message);
		this.name = "SubagentTimeoutError";
	}
}

class SubagentExternalAbortError extends Error {
	constructor() {
		super("Subagent aborted by parent signal.");
		this.name = "SubagentExternalAbortError";
	}
}

function failureKindForError(error: unknown): SubagentFailureKind {
	return error instanceof SubagentTimeoutError ? error.kind : "error";
}

function errorMessageForFailure(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
	const role = inferRole(options.agent, options.role);
	const { idleTimeoutMs, maxTotalMs } = options.timeoutPolicy;
	const eventCounts: Record<string, number> = {};
	const toolCalls: SubagentToolCallSummary[] = [];
	let childSession: Session | undefined;
	let unsubscribe: (() => void) | undefined;
	let watchdog: SubagentWatchdog | undefined;
	let removeAbortListener: (() => void) | undefined;

	try {
		const model = await selectModel(options.agent, options.ctx, options.modelOverride);
		if (!model) throw new Error(`No model is available for subagent ${options.agent.name}.`);

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		} as never);
		const resourceLoader = createSubagentResourceLoader(options.agent, options.ctx.cwd, agentDir, settingsManager);
		await resourceLoader.reload();

		options.progress?.setActivity("creating session");
		const result = await createAgentSession({
			cwd: options.ctx.cwd,
			agentDir,
			model,
			tools: options.agent.tools,
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			customTools: options.customTools,
			resourceLoader,
			sessionManager: SessionManager.create(options.ctx.cwd),
			settingsManager,
		});
		childSession = result.session;

		unsubscribe = childSession.subscribe((event: AgentSessionEvent) => {
			watchdog?.touch();
			eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
			if (event.type === "agent_start") options.progress?.setActivity("running");
			if (event.type === "tool_execution_start") {
				options.progress?.setActivity(`tool ${event.toolName}`);
				options.progress?.incrementToolCount();
				toolCalls.push({
					toolName: event.toolName,
					argsPreview: truncateUtf8(JSON.stringify(event.args ?? {}), 1000),
				});
			}
			if (event.type === "agent_end") options.progress?.setActivity("finishing");
		});

		const abortChild = () => {
			void childSession?.abort().catch(() => undefined);
		};

		let rejectExternalAbort: ((error: SubagentExternalAbortError) => void) | undefined;
		const externalAbortPromise = new Promise<never>((_resolve, reject) => {
			rejectExternalAbort = reject;
		});
		const abortFromParent = () => {
			abortChild();
			rejectExternalAbort?.(new SubagentExternalAbortError());
		};
		if (options.signal) {
			if (options.signal.aborted) abortFromParent();
			else {
				options.signal.addEventListener("abort", abortFromParent, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", abortFromParent);
			}
		}

		let rejectTimeout: ((error: SubagentTimeoutError) => void) | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			rejectTimeout = reject;
		});
		watchdog = createSubagentWatchdog({
			idleMs: idleTimeoutMs,
			maxTotalMs,
			onFire: (kind) => {
				abortChild();
				rejectTimeout?.(new SubagentTimeoutError(kind, timeoutErrorMessage(kind, idleTimeoutMs, maxTotalMs)));
			},
		});

		const promptPromise = childSession.prompt(options.task, { expandPromptTemplates: false, source: "extension" });
		void promptPromise.catch(() => undefined);

		await Promise.race([promptPromise, timeoutPromise, externalAbortPromise]);

		const rawText = truncateUtf8(extractLastAssistantText(childSession));
		const parsed = parseSubagentResult(role, rawText);
		const lastAssistant = getLastAssistantMessage(childSession);
		if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
			return {
				ok: false,
				...emptyFailureBase(role, options.agent, childSession, eventCounts, toolCalls),
				rawText,
				parsed,
				error: lastAssistant.errorMessage ?? `Subagent stopped with ${lastAssistant.stopReason}.`,
				failureKind: "error",
				partialWork: hasPartialWork(eventCounts),
			};
		}

		return {
			ok: true,
			role,
			agentName: options.agent.name,
			sessionFile: childSession.sessionFile,
			sessionFileExists: Boolean(childSession.sessionFile && fs.existsSync(childSession.sessionFile)),
			model: `${model.provider}/${model.id}`,
			activeTools: childSession.getActiveToolNames(),
			eventCounts: { ...eventCounts },
			toolCalls: [...toolCalls],
			rawText,
			parsed,
		};
	} catch (error) {
		const rawText = childSession ? truncateUtf8(extractLastAssistantText(childSession)) : "";
		return {
			ok: false,
			...emptyFailureBase(role, options.agent, childSession, eventCounts, toolCalls),
			rawText,
			parsed: rawText ? parseSubagentResult(role, rawText) : undefined,
			error: errorMessageForFailure(error),
			failureKind: failureKindForError(error),
			partialWork: hasPartialWork(eventCounts),
		};
	} finally {
		options.progress?.finish();
		watchdog?.cancel();
		removeAbortListener?.();
		unsubscribe?.();
		childSession?.dispose();
	}
}
