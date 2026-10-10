import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAVEMAN_PROMPT } from "../workflow-modes/caveman.ts";
import {
	createSubagentDiagnostics,
	MAX_SUBAGENT_TAIL_BYTES,
	redactSubagentText,
	type SubagentDiagnostics,
	type SubagentTransport,
} from "./diagnostics.ts";
import type { AgentRole, AgentConfig } from "./agents.ts";
import { normalizeOwnership, OwnershipLockManager, type OwnershipAcquireResult } from "./ownership.ts";
import { acquireSubagentSlot, type AcquiredSubagentSlot } from "./concurrency.ts";
import { subagentToolsMutateRepository, validateSubagentDepth } from "./policy.ts";
import { createSubagentWatchdog, type SubagentWatchdog, type SubagentWatchdogClock } from "./timeout.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_TOTAL_MS, type SubagentTimeoutPolicy } from "./timeout-policy.ts";
import {
	resolveSubagentSocketPath,
	SubagentIpcServer,
	type SubagentIpcRequest,
} from "./ipc.ts";
import {
	SubagentRpcError,
	SubagentRpcProcess,
	type SubagentRpcErrorKind,
	type SubagentRpcEvent,
	type SubagentRpcSpawnProcess,
} from "./rpc.ts";

export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;
export const MAX_SUBAGENT_SESSION_FILE_BYTES = 4 * 1024;
export const MAX_SUBAGENT_ITEMS = 200;
export const MAX_SUBAGENT_ITEM_BYTES = 2 * 1024;
const MAX_SUBAGENT_ITEM_HISTORY_RUNS = 100;
const MAX_SUBAGENT_TOOL_ARGS_BYTES = 384;
const RPC_PROMPT_TIMEOUT_MS = 30_000;
const RUNTIME_DIR_MODE = 0o700;
const LOADOUT_MODE = 0o600;
const LOADOUT_VERSION = 1;
const MAX_RPC_TOOL_CALL_ID_BYTES = 128;
const FIRE_AND_FORGET_UI_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

export interface SubagentLoadout {
	version: typeof LOADOUT_VERSION;
	parentSessionId: string;
	childSessionId: string;
	owner: string;
	role: AgentRole;
	agentName: string;
	cwd: string;
	extensionPath: string;
	tools: string[];
	model?: string;
	thinkingLevel?: string;
	appendSystemPrompt: string;
	cavemanEnabled: boolean;
	depth: number;
	subagentAgents?: string[];
	fileOwnership?: string[];
	createdAt: string;
}

export interface SubagentQuestion {
	questionId: string;
	question: string;
	options?: string[];
}

export type SubagentRunStatus = "running" | "waiting";

export interface SubagentFailureInfo {
	transport: SubagentTransport;
	kind: SubagentRpcErrorKind;
	logPath: string;
	error: string;
	tail: string;
}

export class SubagentFailureError extends Error {
	readonly info: SubagentFailureInfo;

	constructor(owner: string, info: SubagentFailureInfo) {
		super(`Subagent ${owner} failed over ${info.transport} (${info.kind}). Log: ${info.logPath}. Error: ${info.error}${info.tail ? `\nRecent output:\n${info.tail}` : ""}`);
		this.name = "SubagentFailureError";
		this.info = info;
	}
}

export interface SubagentLaunchOptions {
	parentSessionId: string;
	owner: string;
	role: AgentRole;
	agent: Pick<AgentConfig, "name" | "systemPrompt" | "model">;
	cwd: string;
	task: string;
	tools: string[];
	cavemanEnabled: boolean;
	model?: string;
	thinkingLevel?: string;
	childSessionId?: string;
	extensionPath?: string;
	signal?: AbortSignal;
	depth?: number;
	subagentAgents?: string[];
	fileOwnership?: string[];
	onResult?: (text: string) => void | Promise<void>;
	onStatus?: (status: SubagentRunStatus) => void;
	onQuestion?: (question: SubagentQuestion) => void | Promise<void>;
	onSessionFile?: (sessionFile: string) => void;
}

export type SubagentSpawnProcess = SubagentRpcSpawnProcess;

export interface SubagentLaunchHostOptions {
	parentSessionId: string;
	agentDir?: string;
	logger?: (event: string, details?: Record<string, unknown>) => void;
	/** Test-only process injection; production always uses process.execPath and the parent Pi CLI script. */
	spawnProcess?: SubagentSpawnProcess;
	/** Test-only deterministic watchdog clock. */
	watchdogClock?: SubagentWatchdogClock;
	onSpawn?: (owner: string, payload: unknown) => Promise<unknown> | unknown;
	onBrowser?: (owner: string, payload: unknown) => Promise<unknown> | unknown;
	timeoutPolicy?: SubagentTimeoutPolicy;
}

export interface SubagentResult {
	owner: string;
	childSessionId: string;
	text: string;
	sessionFile?: string;
}

export interface SubagentLaunchHandle {
	readonly owner: string;
	readonly childSessionId: string;
	readonly pid: number | undefined;
	readonly loadoutPath: string;
	readonly transport: SubagentTransport;
	readonly logPath: string;
	readonly sessionFile?: string;
	readonly result: Promise<SubagentResult>;
	request(type: "message", payload?: unknown): Promise<void>;
	kill(): void;
}

interface SubagentRuntimeOptions {
	task: string;
	signal?: AbortSignal;
	onResult?: (text: string) => void | Promise<void>;
	onStatus?: (status: SubagentRunStatus) => void;
	onQuestion?: (question: SubagentQuestion) => void | Promise<void>;
	onSessionFile?: (sessionFile: string) => void;
}

interface PendingQuestion {
	question: SubagentQuestion;
	resolve: (answer: string) => void;
	reject: (error: Error) => void;
}

export type SubagentItemKind = "text" | "thinking" | "tool" | "user" | "question" | "status";

export interface SubagentItem {
	kind: SubagentItemKind;
	text: string;
}

export type SubagentItemListener = (items: readonly SubagentItem[]) => void;

interface ToolItemState {
	item: SubagentItem;
	name: string;
	args: string;
}

interface RunItemBuffer {
	items: SubagentItem[];
	listeners: Set<SubagentItemListener>;
	contentItems: Map<number, SubagentItem>;
	toolItems: Map<string, ToolItemState>;
}

interface RunState {
	options: SubagentRuntimeOptions;
	tools: string[];
	watchdog?: SubagentWatchdog;
	childSessionId: string;
	ipcToken: string;
	rpc?: SubagentRpcProcess;
	loadoutPath: string;
	resolveResult: (result: SubagentResult) => void;
	rejectResult: (error: Error) => void;
	resultSettled: boolean;
	settling?: boolean;
	failureFinalizing?: boolean;
	finalizePromise?: Promise<void>;
	diagnostics: SubagentDiagnostics;
	transport: SubagentTransport;
	cleanup?: () => void;
	slot?: AcquiredSubagentSlot;
	pendingQuestion?: PendingQuestion;
	sessionFile?: string;
	sessionFilePromise?: Promise<void>;
	removeAbortListener?: () => void;
	browserReaped?: boolean;
	tail: string;
	tailPending: string;
	itemBuffer: RunItemBuffer;
}

export function truncateSubagentResult(text: string, maxBytes = MAX_SUBAGENT_RESULT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = `\n\n[truncated to ${maxBytes} bytes]`;
	const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let output = text.slice(0, contentBytes);
	while (Buffer.byteLength(output, "utf8") > contentBytes) output = output.slice(0, -1);
	return `${output}${suffix}`;
}

export function resolveSubagentExtensionPath(): string {
	const extensionPath = fileURLToPath(new URL("./child.ts", import.meta.url));
	if (!fs.existsSync(extensionPath)) throw new Error(`Subagent child extension not found: ${extensionPath}`);
	return extensionPath;
}

export function buildSubagentSystemPrompt(agentPrompt: string, cavemanEnabled: boolean): string {
	const prompt = agentPrompt.trim();
	return cavemanEnabled ? `${prompt}\n\n${CAVEMAN_PROMPT.trim()}` : prompt;
}

export function resolveSubagentLoadoutPath(parentSessionId: string, owner: string, agentDir = getAgentDir()): string {
	validateIdentifier(parentSessionId, "parentSessionId");
	validateIdentifier(owner, "owner");
	return path.join(agentDir, "subagents", parentSessionId, `${owner}.json`);
}

export function writeSubagentLoadout(loadout: SubagentLoadout, agentDir: string): string {
	const loadoutPath = resolveSubagentLoadoutPath(loadout.parentSessionId, loadout.owner, agentDir);
	const directory = path.dirname(loadoutPath);
	fs.mkdirSync(directory, { recursive: true, mode: RUNTIME_DIR_MODE });
	fs.chmodSync(directory, RUNTIME_DIR_MODE);
	const temporaryPath = `${loadoutPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(loadout, null, 2)}\n`, { encoding: "utf8", mode: LOADOUT_MODE });
		fs.chmodSync(temporaryPath, LOADOUT_MODE);
		fs.renameSync(temporaryPath, loadoutPath);
		fs.chmodSync(loadoutPath, LOADOUT_MODE);
	} catch (error) {
		try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
		throw error;
	}
	return loadoutPath;
}

export function readSubagentLoadout(loadoutPath: string): SubagentLoadout {
	const value: unknown = JSON.parse(fs.readFileSync(loadoutPath, "utf8"));
	if (!isRecord(value) || value.version !== LOADOUT_VERSION || typeof value.parentSessionId !== "string" || typeof value.childSessionId !== "string" || typeof value.owner !== "string" || typeof value.role !== "string" || typeof value.agentName !== "string" || typeof value.cwd !== "string" || typeof value.extensionPath !== "string" || !isStringArray(value.tools) || typeof value.appendSystemPrompt !== "string" || typeof value.cavemanEnabled !== "boolean") {
		throw new Error("Invalid subagent loadout.");
	}
	const depth = value.depth === undefined ? 0 : value.depth;
	if ((value.role !== "worker" && value.role !== "explorer") || typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || (value.subagentAgents !== undefined && !isStringArray(value.subagentAgents)) || (value.fileOwnership !== undefined && !isStringArray(value.fileOwnership))) {
		throw new Error("Invalid subagent loadout.");
	}
	return { ...value, depth } as SubagentLoadout;
}

export function buildSubagentCommandArgs(loadout: SubagentLoadout): string[] {
	const args = [
		"--no-extensions",
		"-e", loadout.extensionPath,
		"--tools", loadout.tools.join(","),
		"--append-system-prompt", loadout.appendSystemPrompt,
		"--session-id", loadout.childSessionId,
		"--no-approve",
	];
	if (loadout.model) args.push("--model", loadout.model);
	if (loadout.thinkingLevel) args.push("--thinking", loadout.thinkingLevel);
	return args;
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedSubagentSessionFile(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SUBAGENT_SESSION_FILE_BYTES ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validateIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || value.length > 128) throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
}

function errorAsRpcError(error: unknown, kind: SubagentRpcErrorKind = "process"): SubagentRpcError {
	return error instanceof SubagentRpcError
		? error
		: new SubagentRpcError(kind, error instanceof Error ? error.message : String(error));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new SubagentRpcError("launch", message)), timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function utf8Suffix(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let suffix = text.slice(-maxBytes);
	while (Buffer.byteLength(suffix, "utf8") > maxBytes) suffix = suffix.slice(1);
	return suffix;
}

function appendBoundedTail(current: string, text: string): string {
	const summary = utf8Suffix(text, MAX_SUBAGENT_TAIL_BYTES);
	let output = `${current}${summary}\n`;
	while (Buffer.byteLength(output, "utf8") > MAX_SUBAGENT_TAIL_BYTES) output = output.slice(1);
	return output;
}

function appendRunTail(run: RunState, text: string): void {
	const boundedText = utf8Suffix(text, MAX_SUBAGENT_TAIL_BYTES + Buffer.byteLength(run.ipcToken, "utf8"));
	const combined = redactSubagentText(`${run.tailPending}${boundedText}`, run.ipcToken);
	let heldLength = 0;
	const maxPrefix = Math.min(run.ipcToken.length - 1, combined.length);
	for (let length = maxPrefix; length > 0; length -= 1) {
		if (run.ipcToken.startsWith(combined.slice(-length))) {
			heldLength = length;
			break;
		}
	}
	const split = combined.length - heldLength;
	run.tail = appendBoundedTail(run.tail, combined.slice(0, split));
	run.tailPending = combined.slice(split);
}

function flushRunTail(run: RunState): void {
	if (!run.tailPending) return;
	run.tail = appendBoundedTail(run.tail, redactSubagentText(run.tailPending, run.ipcToken));
	run.tailPending = "";
}

function suffixBoundary(text: string, start: number): number {
	const current = text.charCodeAt(start);
	const previous = text.charCodeAt(start - 1);
	return start > 0 && start < text.length && current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
		? start + 1
		: start;
}

function boundedItemText(kind: SubagentItemKind, text: string, token: string): string {
	const redacted = redactSubagentText(text, token);
	const firstCandidate = suffixBoundary(redacted, Math.max(0, redacted.length - MAX_SUBAGENT_ITEM_BYTES));
	let low = 0;
	let high = redacted.length - firstCandidate;
	while (low < high) {
		const length = Math.ceil((low + high) / 2);
		const start = suffixBoundary(redacted, redacted.length - length);
		const candidate = { kind, text: redacted.slice(start) };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_SUBAGENT_ITEM_BYTES) low = length;
		else high = length - 1;
	}
	const start = suffixBoundary(redacted, redacted.length - low);
	return redacted.slice(start);
}

function copySubagentItems(items: readonly SubagentItem[]): SubagentItem[] {
	return items.map((item) => ({ ...item }));
}

function summarizeToolArgs(value: unknown): string {
	if (value === undefined) return "";
	let summary: string;
	try {
		const serialized = JSON.stringify(value);
		summary = serialized ?? String(value);
	} catch {
		summary = "[unavailable]";
	}
	return utf8Suffix(summary, MAX_SUBAGENT_TOOL_ARGS_BYTES);
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap((item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("");
}

function summarizeRpcEvent(event: SubagentRpcEvent): string {
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		const action = event.type === "tool_execution_start" ? "started" : "ended";
		const name = typeof event.toolName === "string" ? event.toolName.slice(0, 200) : "tool";
		return `${action}: ${name}`;
	}
	if (event.type === "message_end" && isRecord(event.message)) {
		const text = contentText(event.message.content);
		return text ? `${typeof event.message.role === "string" ? event.message.role : "message"}: ${utf8Suffix(text, MAX_SUBAGENT_TAIL_BYTES)}` : event.type;
	}
	if (event.type === "message_update" && isRecord(event.assistantMessageEvent) && event.assistantMessageEvent.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
		return event.assistantMessageEvent.delta;
	}
	return `event: ${event.type}`;
}

function questionFromUiRequest(id: string, method: string, payload: Record<string, unknown>, token: string): SubagentQuestion | undefined {
	if (method !== "input" && method !== "select") return undefined;
	if (typeof payload.title !== "string" || Buffer.byteLength(payload.title, "utf8") > MAX_SUBAGENT_RESULT_BYTES) return undefined;
	const question = payload.title.trim();
	if (!question) return undefined;
	const safeQuestion = redactSubagentText(question, token);
	if (method === "input") return { questionId: id, question: safeQuestion };
	if (!Array.isArray(payload.options) || payload.options.length === 0 || payload.options.length > 20 || payload.options.some((option) => typeof option !== "string" || Buffer.byteLength(option, "utf8") > 1_000 || !option.trim())) return undefined;
	return {
		questionId: id,
		question: safeQuestion,
		options: payload.options.map((option: string) => redactSubagentText(option.trim(), token)),
	};
}

function validateToolCallId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_RPC_TOOL_CALL_ID_BYTES;
}

export class SubagentLaunchHost {
	readonly server: SubagentIpcServer;
	private readonly runs = new Map<string, RunState>();
	private readonly itemHistory = new Map<string, SubagentItem[]>();
	private readonly spawnProcess: SubagentSpawnProcess | undefined;
	private readonly ownership = new OwnershipLockManager();
	private closed = false;
	private readonly exitHandler = () => {
		for (const run of this.runs.values()) void run.rpc?.stop();
	};

	constructor(private readonly options: SubagentLaunchHostOptions) {
		this.server = new SubagentIpcServer({
			socketPath: resolveSubagentSocketPath(options.parentSessionId, options.agentDir),
			logger: (event, details) => this.log(event, details),
			onRequest: (request, connection) => this.handleRequest(request, connection),
			onDisconnect: (owner, error) => this.handleDisconnect(owner, error),
		});
		this.spawnProcess = options.spawnProcess;
		process.on("exit", this.exitHandler);
	}

	async listen(): Promise<void> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		await this.server.listen();
	}

	async launch(options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		await this.server.listen();
		validateIdentifier(options.owner, "owner");
		validateIdentifier(options.parentSessionId, "parentSessionId");
		if (options.parentSessionId !== this.options.parentSessionId) throw new Error("Subagent parent session does not match IPC host.");
		if (!options.task.trim()) throw new Error("Subagent task is required.");
		if (!Array.isArray(options.tools) || options.tools.length === 0 || options.tools.some((tool) => typeof tool !== "string" || !tool.trim())) throw new Error("Subagent tools must be a non-empty allowlist.");
		if (options.fileOwnership !== undefined && (!Array.isArray(options.fileOwnership) || options.fileOwnership.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("Subagent ownership paths must be non-empty strings.");
		if (options.subagentAgents !== undefined && (!Array.isArray(options.subagentAgents) || options.subagentAgents.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("Subagent child agent names must be non-empty strings.");
		const depthError = validateSubagentDepth(options.depth ?? 0);
		if (depthError) throw new Error(depthError);
		const childSessionId = options.childSessionId ?? crypto.randomUUID();
		validateIdentifier(childSessionId, "childSessionId");
		const childAgents = options.subagentAgents ? [...new Set(options.subagentAgents.map((item) => item.trim()).filter(Boolean))] : undefined;
		const fileOwnership = normalizeOwnership(options.fileOwnership);
		const loadout: SubagentLoadout = {
			version: LOADOUT_VERSION,
			parentSessionId: options.parentSessionId,
			childSessionId,
			owner: options.owner,
			role: options.role,
			agentName: options.agent.name,
			cwd: options.cwd,
			extensionPath: options.extensionPath ?? resolveSubagentExtensionPath(),
			tools: [...options.tools],
			...(options.model ?? options.agent.model ? { model: options.model ?? options.agent.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			appendSystemPrompt: buildSubagentSystemPrompt(options.agent.systemPrompt, options.cavemanEnabled),
			cavemanEnabled: options.cavemanEnabled,
			depth: options.depth ?? 0,
			...(childAgents && childAgents.length > 0 ? { subagentAgents: childAgents } : {}),
			...(fileOwnership.length > 0 ? { fileOwnership } : {}),
			createdAt: new Date().toISOString(),
		};
		const loadoutPath = writeSubagentLoadout(loadout, this.options.agentDir ?? getAgentDir());
		return this.start(loadout, loadoutPath, options);
	}

	async resume(
		loadoutPath: string,
		task: string,
		options: Pick<SubagentLaunchOptions, "signal" | "onResult" | "onStatus" | "onQuestion" | "onSessionFile"> = {},
	): Promise<SubagentLaunchHandle> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		await this.server.listen();
		if (!task.trim()) throw new Error("Subagent task is required.");
		const loadout = readSubagentLoadout(loadoutPath);
		validateIdentifier(loadout.owner, "owner");
		if (loadout.parentSessionId !== this.options.parentSessionId) throw new Error("Subagent loadout parent session does not match IPC host.");
		const expectedPath = resolveSubagentLoadoutPath(loadout.parentSessionId, loadout.owner, this.options.agentDir ?? getAgentDir());
		if (path.resolve(loadoutPath) !== path.resolve(expectedPath)) throw new Error("Subagent loadout path does not match its owner.");
		return this.start(loadout, loadoutPath, { task, ...options });
	}

	answerQuestion(owner: string, questionId: string, answer: string): boolean {
		const run = this.runs.get(owner);
		const pending = run?.pendingQuestion;
		if (!run || run.resultSettled || !pending || pending.question.questionId !== questionId || Buffer.byteLength(answer, "utf8") > MAX_SUBAGENT_RESULT_BYTES || !answer.trim()) return false;
		run.pendingQuestion = undefined;
		pending.resolve(answer);
		return true;
	}

	redactText(owner: string, text: string): string {
		const run = this.runs.get(owner);
		return run ? redactSubagentText(text, run.ipcToken) : text;
	}

	acquireOwnership(owner: string, paths: readonly string[] | undefined): OwnershipAcquireResult {
		validateIdentifier(owner, "owner");
		return this.ownership.acquire(owner, paths);
	}

	releaseOwnership(owner: string): void {
		this.ownership.release(owner);
	}

	getOwnershipSnapshot(): Record<string, string[]> {
		return this.ownership.snapshot();
	}

	async readTail(owner: string, lines: number): Promise<string | undefined> {
		const run = this.runs.get(owner);
		if (!run || run.resultSettled) return undefined;
		const boundedLines = Number.isInteger(lines) ? Math.max(1, Math.min(100, lines)) : 20;
		let output = run.tail.split("\n").filter(Boolean).slice(-boundedLines).join("\n");
		while (Buffer.byteLength(output, "utf8") > MAX_SUBAGENT_TAIL_BYTES) output = output.slice(1);
		return output || undefined;
	}

	readItems(owner: string): SubagentItem[] {
		if (this.closed) return [];
		const items = this.runs.get(owner)?.itemBuffer.items ?? this.itemHistory.get(owner) ?? [];
		return copySubagentItems(items);
	}

	subscribeItems(owner: string, listener: SubagentItemListener): () => void {
		const run = this.runs.get(owner);
		if (this.closed || !run || run.resultSettled || run.failureFinalizing) {
			this.notifyItemListener(listener, this.readItems(owner));
			return () => undefined;
		}
		run.itemBuffer.listeners.add(listener);
		this.notifyItemListener(listener, run.itemBuffer.items);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			run.itemBuffer.listeners.delete(listener);
		};
	}

	private async start(loadout: SubagentLoadout, loadoutPath: string, runtime: SubagentRuntimeOptions): Promise<SubagentLaunchHandle> {
		const depthError = validateSubagentDepth(loadout.depth);
		if (depthError) throw new Error(depthError);
		const existing = this.runs.get(loadout.owner);
		if (existing) {
			if (!existing.resultSettled) throw new Error(`Subagent owner already exists: ${loadout.owner}`);
			await this.server.closeOwner(loadout.owner);
			await existing.rpc?.stop();
			this.retainItemHistory(loadout.owner, existing.itemBuffer.items);
			existing.itemBuffer.listeners.clear();
			this.runs.delete(loadout.owner);
			this.ownership.release(loadout.owner);
			existing.slot?.release();
		} else {
			await this.server.closeOwner(loadout.owner);
		}
		await this.server.revokeRun(loadout.owner);
		const args = buildSubagentCommandArgs(loadout);
		if (subagentToolsMutateRepository(loadout.tools)) {
			const ownership = this.ownership.acquire(loadout.owner, loadout.fileOwnership);
			if (!ownership.ok) throw new Error(`Subagent ownership overlaps ${ownership.conflict?.owner}: requested ${ownership.conflict?.requestedPath}, existing ${ownership.conflict?.existingPath}.`);
		}
		let slot: AcquiredSubagentSlot;
		try {
			slot = await acquireSubagentSlot(loadout.cwd, runtime.signal);
		} catch (error) {
			this.ownership.release(loadout.owner);
			throw error;
		}
		let ipcToken: string;
		try {
			ipcToken = this.server.registerRun(loadout.owner);
		} catch (error) {
			this.ownership.release(loadout.owner);
			slot.release();
			throw error;
		}
		const environment: Record<string, string> = {
			PI_SUBAGENT_SOCKET: this.server.socketPath,
			PI_SUBAGENT_TOKEN: ipcToken,
			PI_SUBAGENT_OWNER: loadout.owner,
			PI_SUBAGENT_PARENT_SESSION_ID: loadout.parentSessionId,
			PI_SUBAGENT_CHILD_SESSION_ID: loadout.childSessionId,
			PI_SUBAGENT_LOADOUT: loadoutPath,
		};
		let diagnostics: SubagentDiagnostics;
		try {
			diagnostics = createSubagentDiagnostics({ parentSessionId: loadout.parentSessionId, childSessionId: loadout.childSessionId, owner: loadout.owner, token: ipcToken, agentDir: this.options.agentDir });
		} catch (error) {
			void this.server.revokeRun(loadout.owner).catch(() => undefined);
			this.ownership.release(loadout.owner);
			slot.release();
			throw error;
		}
		let run!: RunState;
		let resolveResult!: (result: SubagentResult) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<SubagentResult>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		run = {
			options: runtime,
			tools: loadout.tools,
			childSessionId: loadout.childSessionId,
			ipcToken,
			loadoutPath,
			resolveResult,
			rejectResult,
			resultSettled: false,
			diagnostics,
			transport: "rpc",
			slot,
			tail: "",
			tailPending: "",
			itemBuffer: { items: [], listeners: new Set(), contentItems: new Map(), toolItems: new Map() },
		};
		this.runs.set(loadout.owner, run);
		const releaseRun = () => {
			run.removeAbortListener?.();
			if (this.runs.get(loadout.owner) !== run) return;
			this.retainItemHistory(loadout.owner, run.itemBuffer.items);
			run.itemBuffer.listeners.clear();
			this.runs.delete(loadout.owner);
			this.ownership.release(loadout.owner);
			run.slot?.release();
			void this.server.revokeRun(loadout.owner).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.log("ipc_revoke_failed", { owner: loadout.owner, error: redactSubagentText(message, run.ipcToken) });
			});
		};
		run.cleanup = releaseRun;
		const finishChild = (error?: Error) => {
			if (run.resultSettled || run.failureFinalizing) return;
			run.settling = false;
			run.failureFinalizing = true;
			run.resultSettled = true;
			const failure = error ?? new SubagentRpcError("process", `Subagent ${loadout.owner} exited before returning a result.`);
			run.pendingQuestion?.reject(failure);
			run.watchdog?.clearTools();
			run.watchdog?.cancel();
			run.finalizePromise = this.finalizeFailure(run, loadout.owner, failure);
			void run.finalizePromise;
		};
		run.watchdog = createSubagentWatchdog({
			idleMs: this.options.timeoutPolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			maxTotalMs: this.options.timeoutPolicy?.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS,
			clock: this.options.watchdogClock,
			onFire: (kind) => finishChild(new SubagentRpcError("process", `Subagent ${loadout.owner} ${kind === "idle" ? "idle" : "maximum total"} timeout exceeded.`)),
		});
		const abort = () => this.abortRun(run, loadout.owner);
		if (runtime.signal) {
			if (runtime.signal.aborted) abort();
			else {
				runtime.signal.addEventListener("abort", abort, { once: true });
				run.removeAbortListener = () => runtime.signal?.removeEventListener("abort", abort);
			}
		}
		this.reportStatus(run, "running");
		void result.catch(() => undefined);

		const makeHandle = (): SubagentLaunchHandle => ({
			owner: loadout.owner,
			childSessionId: loadout.childSessionId,
			pid: run.rpc?.child.pid,
			loadoutPath,
			transport: run.transport,
			logPath: run.diagnostics.logPath,
			...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
			result,
			request: (type, payload) => this.request(loadout.owner, type, payload),
			kill: () => {
				const current = this.runs.get(loadout.owner);
				if (current) this.abortRun(current, loadout.owner);
			},
		});

		if (run.resultSettled) return makeHandle();
		try {
			run.rpc = new SubagentRpcProcess({
				args,
				cwd: loadout.cwd,
				env: environment,
				spawnProcess: this.spawnProcess,
				logger: (event, details) => this.log(`rpc_${event}`, { owner: loadout.owner, ...details }),
				stderrSink: (chunk) => run.diagnostics.append("stderr", chunk),
				onEvent: (event) => this.handleRpcEvent(run, loadout.owner, event),
				onUiRequest: (id, method, payload) => this.handleUiRequest(run, loadout.owner, id, method, payload),
				onExit: (code, signal) => {
					if (!run.resultSettled && !run.settling && !run.failureFinalizing) {
						finishChild(new SubagentRpcError("process", `Subagent ${loadout.owner} exited (${code ?? signal ?? "unknown"}) before agent_settled.`));
					}
				},
			});
		} catch (error) {
			finishChild(errorAsRpcError(error, "launch"));
			return makeHandle();
		}

		try {
			const prompt = await withTimeout(
				run.rpc.prompt(runtime.task),
				RPC_PROMPT_TIMEOUT_MS,
				`RPC prompt readiness timed out after ${RPC_PROMPT_TIMEOUT_MS / 1_000} seconds.`,
			);
			if (run.resultSettled) return makeHandle();
			if (prompt.disposition === "handled") throw new SubagentRpcError("launch", "Prompt handled without a run.");
			await this.readSessionFile(run);
		} catch (error) {
			finishChild(errorAsRpcError(error, "launch"));
		}
		return makeHandle();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		process.off("exit", this.exitHandler);
		const runs = [...this.runs.entries()];
		const stops: Promise<void>[] = [];
		for (const [owner, run] of runs) {
			this.reapBrowserPage(run, owner);
			flushRunTail(run);
			run.watchdog?.clearTools();
			run.watchdog?.cancel();
			if (!run.resultSettled) {
				this.appendRunItem(run, "status", "closed");
				run.resultSettled = true;
				run.pendingQuestion?.reject(new Error(`Subagent ${owner} host closed.`));
				run.rejectResult(new Error(`Subagent ${owner} host closed.`));
			}
			run.itemBuffer.listeners.clear();
			if (run.rpc) stops.push(run.rpc.stop().finally(() => run.diagnostics.close()));
			else run.diagnostics.close();
			run.cleanup?.();
		}
		await Promise.all(stops);
		await Promise.all(runs.map(([, run]) => run.finalizePromise).filter((promise): promise is Promise<void> => promise !== undefined));
		await this.server.close();
		this.itemHistory.clear();
	}

	private async readSessionFile(run: RunState): Promise<void> {
		if (!run.sessionFilePromise) {
			const rpc = run.rpc;
			if (!rpc) throw new SubagentRpcError("process", "RPC process is unavailable.");
			run.sessionFilePromise = rpc.getState().then((state) => this.updateSessionFile(run, state.sessionFile));
		}
		return run.sessionFilePromise;
	}

	private updateSessionFile(run: RunState, value: unknown): void {
		const sessionFile = boundedSubagentSessionFile(value);
		if (!sessionFile || run.sessionFile === sessionFile) return;
		run.sessionFile = sessionFile;
		try {
			run.options.onSessionFile?.(sessionFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("session_file_callback_failed", { error: redactSubagentText(message, run.ipcToken) });
		}
	}

	private handleRpcEvent(run: RunState, owner: string, event: SubagentRpcEvent): void {
		if (run.resultSettled || run.failureFinalizing) return;
		run.watchdog?.touch();
		appendRunTail(run, summarizeRpcEvent(event));
		this.recordItemEvent(run, event);
		if (event.type === "tool_execution_start" && validateToolCallId(event.toolCallId)) run.watchdog?.toolStarted(event.toolCallId);
		if (event.type === "tool_execution_end" && validateToolCallId(event.toolCallId)) run.watchdog?.toolEnded(event.toolCallId);
		if (event.type === "agent_settled") void this.settleRun(run, owner);
	}

	private notifyItemListener(listener: SubagentItemListener, items: readonly SubagentItem[]): void {
		try { listener(copySubagentItems(items)); }
		catch { /* Item observers must not interrupt child execution. */ }
	}

	private notifyItemBuffer(buffer: RunItemBuffer): void {
		for (const listener of [...buffer.listeners]) this.notifyItemListener(listener, buffer.items);
	}

	private retainItemHistory(owner: string, items: readonly SubagentItem[]): void {
		this.itemHistory.delete(owner);
		this.itemHistory.set(owner, copySubagentItems(items));
		while (this.itemHistory.size > MAX_SUBAGENT_ITEM_HISTORY_RUNS) {
			const oldest = this.itemHistory.keys().next().value;
			if (oldest === undefined) break;
			this.itemHistory.delete(oldest);
		}
	}

	private forgetItemReferences(buffer: RunItemBuffer, item: SubagentItem): void {
		for (const [index, contentItem] of buffer.contentItems) if (contentItem === item) buffer.contentItems.delete(index);
		for (const [toolCallId, tool] of buffer.toolItems) if (tool.item === item) buffer.toolItems.delete(toolCallId);
	}

	private appendRunItem(run: RunState, kind: SubagentItemKind, text: string): SubagentItem {
		const item = { kind, text: boundedItemText(kind, text, run.ipcToken) };
		const buffer = run.itemBuffer;
		buffer.items.push(item);
		while (buffer.items.length > MAX_SUBAGENT_ITEMS) this.forgetItemReferences(buffer, buffer.items.shift()!);
		this.notifyItemBuffer(buffer);
		return item;
	}

	private replaceRunItem(run: RunState, previous: SubagentItem, kind: SubagentItemKind, text: string): SubagentItem {
		const buffer = run.itemBuffer;
		const index = buffer.items.indexOf(previous);
		if (index === -1) return this.appendRunItem(run, kind, text);
		const item = { kind, text: boundedItemText(kind, text, run.ipcToken) };
		buffer.items[index] = item;
		for (const [contentIndex, contentItem] of buffer.contentItems) if (contentItem === previous) buffer.contentItems.set(contentIndex, item);
		for (const [toolCallId, tool] of buffer.toolItems) {
			if (tool.item === previous) buffer.toolItems.set(toolCallId, { ...tool, item });
		}
		this.notifyItemBuffer(buffer);
		return item;
	}

	private removeRunItem(run: RunState, item: SubagentItem): void {
		const buffer = run.itemBuffer;
		const index = buffer.items.indexOf(item);
		if (index === -1) return;
		buffer.items.splice(index, 1);
		this.forgetItemReferences(buffer, item);
		this.notifyItemBuffer(buffer);
	}

	private updateContentItem(run: RunState, index: number, kind: "text" | "thinking", text: string, append = false): SubagentItem {
		const buffer = run.itemBuffer;
		const previous = buffer.contentItems.get(index);
		const value = append && previous?.kind === kind ? previous.text + text : text;
		const item = previous
			? this.replaceRunItem(run, previous, kind, value)
			: this.appendRunItem(run, kind, value);
		buffer.contentItems.set(index, item);
		return item;
	}

	private recordItemEvent(run: RunState, event: SubagentRpcEvent): void {
		if (event.type === "message_start") {
			run.itemBuffer.contentItems.clear();
			return;
		}
		if (event.type === "message_update") {
			if (!isRecord(event.assistantMessageEvent)) return;
			const update = event.assistantMessageEvent;
			if (typeof update.contentIndex !== "number" || !Number.isInteger(update.contentIndex) || update.contentIndex < 0) return;
			if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) this.updateContentItem(run, update.contentIndex, "text", update.delta, true);
			else if (update.type === "text_end" && typeof update.content === "string") this.updateContentItem(run, update.contentIndex, "text", update.content);
			else if (update.type === "thinking_delta" && typeof update.delta === "string" && update.delta) this.updateContentItem(run, update.contentIndex, "thinking", update.delta, true);
			else if (update.type === "thinking_end" && typeof update.content === "string") this.updateContentItem(run, update.contentIndex, "thinking", update.content);
			return;
		}
		if (event.type === "message_end") {
			if (!isRecord(event.message)) return;
			const message = event.message;
			if (message.role === "user") {
				const text = contentText(message.content);
				if (text) this.appendRunItem(run, "user", text);
			} else if (message.role === "assistant") {
				const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
				const seen = new Set<number>();
				for (let index = 0; index < blocks.length; index += 1) {
					const block = blocks[index];
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string") {
						seen.add(index);
						this.updateContentItem(run, index, "text", block.text);
					} else if (block.type === "thinking" && typeof block.thinking === "string") {
						seen.add(index);
						this.updateContentItem(run, index, "thinking", block.thinking);
					}
				}
				for (const [index, item] of [...run.itemBuffer.contentItems]) if (!seen.has(index)) this.removeRunItem(run, item);
			}
			run.itemBuffer.contentItems.clear();
			return;
		}
		if (event.type === "tool_execution_start" && validateToolCallId(event.toolCallId)) {
			const name = redactSubagentText(typeof event.toolName === "string" ? event.toolName.slice(0, 200) : "tool", run.ipcToken);
			const args = redactSubagentText(summarizeToolArgs(event.args), run.ipcToken);
			const previous = run.itemBuffer.toolItems.get(event.toolCallId);
			const text = `${name}${args ? ` ${args}` : ""} — running`;
			const item = previous ? this.replaceRunItem(run, previous.item, "tool", text) : this.appendRunItem(run, "tool", text);
			run.itemBuffer.toolItems.set(event.toolCallId, { item, name, args });
			return;
		}
		if (event.type === "tool_execution_end" && validateToolCallId(event.toolCallId)) {
			const previous = run.itemBuffer.toolItems.get(event.toolCallId);
			const name = previous?.name ?? redactSubagentText(typeof event.toolName === "string" ? event.toolName.slice(0, 200) : "tool", run.ipcToken);
			const args = previous?.args ?? redactSubagentText(summarizeToolArgs(event.args), run.ipcToken);
			const result = event.isError === true ? "error" : "ok";
			const duration = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? ` (${Math.max(0, Math.round(event.durationMs))}ms)` : "";
			const text = `${name}${args ? ` ${args}` : ""} — ${result}${duration}`;
			if (previous) this.replaceRunItem(run, previous.item, "tool", text);
			else this.appendRunItem(run, "tool", text);
			run.itemBuffer.toolItems.delete(event.toolCallId);
		}
	}

	private async settleRun(run: RunState, owner: string): Promise<void> {
		if (run.resultSettled || run.settling || run.failureFinalizing) return;
		run.settling = true;
		run.watchdog?.clearTools();
		run.pendingQuestion?.reject(new Error(`Subagent ${owner} settled while a question was pending.`));
		try {
			await this.readSessionFile(run);
			const text = await run.rpc!.getLastAssistantText();
			if (run.resultSettled) return;
			if (text) appendRunTail(run, text);
			flushRunTail(run);
			run.watchdog?.cancel();
			const result: SubagentResult = {
				owner,
				childSessionId: run.childSessionId,
				text: truncateSubagentResult(text ?? ""),
				...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
			};
			this.appendRunItem(run, "status", "done");
			run.resultSettled = true;
			run.settling = false;
			run.diagnostics.close();
			run.resolveResult(result);
			void Promise.resolve().then(() => run.options.onResult?.(result.text)).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.log("result_steering_failed", { owner, error: redactSubagentText(message, run.ipcToken) });
			});
			this.reapBrowserPage(run, owner);
			const stopping = run.rpc?.stop();
			run.cleanup?.();
			void stopping;
		} catch (error) {
			run.settling = false;
			if (!run.resultSettled) {
				const failure = errorAsRpcError(error);
				run.failureFinalizing = true;
				run.resultSettled = true;
				run.finalizePromise = this.finalizeFailure(run, owner, failure);
				void run.finalizePromise;
			}
		}
	}

	private async handleUiRequest(run: RunState, owner: string, id: string, method: string, payload: Record<string, unknown>): Promise<void> {
		const rpc = run.rpc;
		if (!rpc) return;
		if (FIRE_AND_FORGET_UI_METHODS.has(method)) return;
		const question = questionFromUiRequest(id, method, payload, run.ipcToken);
		if (question) {
			const options = question.options?.length ? `\nOptions: ${question.options.join(" | ")}` : "";
			this.appendRunItem(run, "question", `${question.question}${options}`);
		}
		if (!question || run.resultSettled || run.pendingQuestion || !run.options.onQuestion) {
			try { await rpc.respondUi(id, { cancelled: true }); } catch { /* Process may already be stopping. */ }
			return;
		}
		const answer = new Promise<string>((resolve, reject) => {
			run.pendingQuestion = { question, resolve, reject };
		});
		this.reportStatus(run, "waiting");
		run.watchdog?.setWaiting(true);
		try {
			await run.options.onQuestion(question);
			const value = await answer;
			if (!run.resultSettled) await rpc.respondUi(id, { value });
		} catch {
			if (!run.resultSettled) {
				try { await rpc.respondUi(id, { cancelled: true }); } catch { /* Process may already be stopping. */ }
			}
		} finally {
			if (run.pendingQuestion?.question.questionId === id) run.pendingQuestion = undefined;
			run.watchdog?.setWaiting(false);
			if (!run.resultSettled) this.reportStatus(run, "running");
		}
	}

	private async request(owner: string, type: "message", payload: unknown): Promise<void> {
		const run = this.runs.get(owner);
		if (!run || run.resultSettled || !run.rpc) throw new Error(`Subagent ${owner} is not running.`);
		if (type !== "message" || !isRecord(payload) || typeof payload.text !== "string" || Buffer.byteLength(payload.text, "utf8") > MAX_SUBAGENT_RESULT_BYTES || !payload.text.trim()) throw new Error("Subagent message is malformed.");
		try {
			await run.rpc.steer(payload.text);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(redactSubagentText(message, run.ipcToken));
		}
	}

	private abortRun(run: RunState, owner: string): void {
		if (run.resultSettled) return;
		this.appendRunItem(run, "status", "aborted");
		run.resultSettled = true;
		run.pendingQuestion?.reject(new Error(`Subagent ${owner} aborted.`));
		run.watchdog?.clearTools();
		run.watchdog?.cancel();
		this.reapBrowserPage(run, owner);
		flushRunTail(run);
		run.rejectResult(new Error(`Subagent ${owner} aborted.`));
		const rpc = run.rpc;
		const abortCommand = rpc?.abort().catch(() => undefined);
		run.cleanup?.();
		if (rpc && abortCommand) {
			void (async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						abortCommand,
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 250);
							timer.unref();
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
					await rpc.stop().catch(() => undefined);
					run.diagnostics.close();
				}
			})();
		} else run.diagnostics.close();
	}

	private reapBrowserPage(run: RunState, owner: string): void {
		if (run.browserReaped || !run.tools.includes("browser_close") || !this.options.onBrowser) return;
		run.browserReaped = true;
		void Promise.resolve().then(() => this.options.onBrowser!(owner, { tool: "browser_close", params: {} })).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			this.log("browser_reap_failed", { owner, error: redactSubagentText(message, run.ipcToken) });
		});
	}

	private async handleRequest(request: SubagentIpcRequest, _connection: unknown): Promise<unknown> {
		const run = this.runs.get(request.owner);
		if (!run) throw new Error(`Unknown subagent owner: ${request.owner}.`);
		if (run.resultSettled) throw new Error(`Subagent ${request.owner} is already settled.`);
		run.watchdog?.touch();
		if (request.type === "spawn") {
			if (!this.options.onSpawn) throw new Error("Nested subagent spawning is unavailable.");
			return this.options.onSpawn(request.owner, request.payload);
		}
		if (request.type === "browser") {
			if (!this.options.onBrowser) throw new Error("Browser proxy is unavailable.");
			if (!isRecord(request.payload) || typeof request.payload.tool !== "string" || !run.tools.includes(request.payload.tool)) throw new Error("Browser tool is not in child allowlist.");
			return this.options.onBrowser(request.owner, request.payload);
		}
		if (request.type === "ownership") {
			if (!isRecord(request.payload) || (request.payload.action !== "acquire" && request.payload.action !== "release")) throw new Error("Ownership request is malformed.");
			if (request.payload.action === "release") {
				this.releaseOwnership(request.owner);
				return { accepted: true, released: true };
			}
			const requested = request.payload.paths as string[] | undefined;
			if (requested !== undefined && (!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))) throw new Error("Ownership paths are malformed.");
			if (!subagentToolsMutateRepository(run.tools)) return { ok: true, paths: normalizeOwnership(requested) };
			const acquired = this.acquireOwnership(request.owner, requested);
			if (!acquired.ok) throw new Error(`Subagent ownership overlaps ${acquired.conflict?.owner}: requested ${acquired.conflict?.requestedPath}, existing ${acquired.conflict?.existingPath}.`);
			return acquired;
		}
		throw new Error(`Unsupported child IPC message: ${request.type}.`);
	}

	private async finalizeFailure(run: RunState, owner: string, error: Error): Promise<void> {
		const failure = errorAsRpcError(error);
		this.appendRunItem(run, "status", "failed");
		run.itemBuffer.listeners.clear();
		try { await run.rpc?.stop(); } catch { /* Failure cleanup must continue. */ }
		flushRunTail(run);
		run.diagnostics.close();
		const safeError = redactSubagentText(failure.message, run.ipcToken);
		const failed = new SubagentFailureError(owner, {
			transport: run.transport,
			kind: failure.kind,
			logPath: run.diagnostics.logPath,
			error: safeError,
			tail: run.diagnostics.tail(),
		});
		run.watchdog?.clearTools();
		run.watchdog?.cancel();
		this.reapBrowserPage(run, owner);
		run.cleanup?.();
		run.rejectResult(failed);
	}

	private handleDisconnect(owner: string | undefined, _error?: Error): void {
		if (!owner) return;
		const run = this.runs.get(owner);
		if (!run || run.resultSettled) return;
		this.log("ipc_disconnected", { owner });
	}

	private reportStatus(run: RunState, status: SubagentRunStatus): void {
		this.appendRunItem(run, "status", status);
		try {
			run.options.onStatus?.(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log("status_callback_failed", { error: redactSubagentText(message, run.ipcToken) });
		}
	}

	private log(event: string, details?: Record<string, unknown>): void {
		try { this.options.logger?.(event, details); }
		catch { /* Logging must not interrupt lifecycle cleanup. */ }
	}
}
