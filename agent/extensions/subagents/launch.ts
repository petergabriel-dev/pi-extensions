import * as crypto from "node:crypto";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAVEMAN_PROMPT } from "../workflow-modes/caveman.ts";
import { CmuxTransport, type CmuxLaunchOutcome, type CmuxSurfaceHandle } from "./cmux.ts";
import {
	createSubagentDiagnostics,
	redactSubagentText,
	type SubagentDiagnostics,
	type SubagentTransport,
} from "./diagnostics.ts";
import type { AgentRole, AgentConfig } from "./agents.ts";
import { normalizeOwnership, OwnershipLockManager, type OwnershipAcquireResult } from "./ownership.ts";
import { acquireSubagentSlot, type AcquiredSubagentSlot } from "./concurrency.ts";
import { validateSubagentDepth } from "./policy.ts";
import { createSubagentWatchdog, type SubagentWatchdog } from "./timeout.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_TOTAL_MS, type SubagentTimeoutPolicy } from "./timeout-policy.ts";
import {
	resolveSubagentSocketPath,
	SubagentIpcServer,
	type SubagentIpcMessageType,
	type SubagentIpcRequest,
} from "./ipc.ts";

export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;
const RUNTIME_DIR_MODE = 0o700;
const LOADOUT_MODE = 0o600;
const LOADOUT_VERSION = 1;

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
	logPath: string;
	error: string;
	tail: string;
	cmuxFailureReason?: string;
}

export class SubagentFailureError extends Error {
	readonly info: SubagentFailureInfo;

	constructor(owner: string, info: SubagentFailureInfo) {
		super(`Subagent ${owner} failed over ${info.transport}. Log: ${info.logPath}. Error: ${info.error}${info.cmuxFailureReason ? ` Cmux failure: ${info.cmuxFailureReason}` : ""}${info.tail ? `\nRecent output:\n${info.tail}` : ""}`);
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
}

export type SubagentSpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SubagentLaunchHostOptions {
	parentSessionId: string;
	agentDir?: string;
	logger?: (event: string, details?: Record<string, unknown>) => void;
	command?: string;
	/** Test-only process injection; production launches use cmux interactive transport. */
	spawnProcess?: SubagentSpawnProcess;
	/** Test-only cmux bypass when paired with spawnProcess. */
	cmux?: CmuxTransport | false;
	onSpawn?: (owner: string, payload: unknown) => Promise<unknown> | unknown;
	onBrowser?: (owner: string, payload: unknown) => Promise<unknown> | unknown;
	timeoutPolicy?: SubagentTimeoutPolicy;
}

export interface SubagentResult {
	owner: string;
	childSessionId: string;
	text: string;
}

export interface SubagentLaunchHandle {
	readonly owner: string;
	readonly childSessionId: string;
	readonly pid: number | undefined;
	readonly loadoutPath: string;
	readonly transport: SubagentTransport;
	readonly logPath: string;
	readonly cmuxFailureReason?: string;
	readonly result: Promise<SubagentResult>;
	request<T = unknown>(type: SubagentIpcMessageType, payload?: unknown): Promise<T>;
	kill(): void;
}

interface SubagentRuntimeOptions {
	task: string;
	signal?: AbortSignal;
	onResult?: (text: string) => void | Promise<void>;
	onStatus?: (status: SubagentRunStatus) => void;
	onQuestion?: (question: SubagentQuestion) => void | Promise<void>;
}

interface PendingQuestion {
	question: SubagentQuestion;
	resolve: (answer: string) => void;
	reject: (error: Error) => void;
}

interface RunState {
	options: SubagentRuntimeOptions;
	tools: string[];
	watchdog?: SubagentWatchdog;
	childSessionId: string;
	child?: ChildProcess;
	surface?: CmuxSurfaceHandle;
	loadoutPath: string;
	resolveResult: (result: SubagentResult) => void;
	rejectResult: (error: Error) => void;
	resultSettled: boolean;
	failureFinalizing?: boolean;
	diagnostics: SubagentDiagnostics;
	transport: SubagentTransport;
	cmuxFailureReason?: string;
	cleanup?: () => void;
	slot?: AcquiredSubagentSlot;
	pendingQuestion?: PendingQuestion;
	removeAbortListener?: () => void;
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

export function buildSubagentCommandArgs(loadout: SubagentLoadout, task: string): string[] {
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
	args.push(task);
	return args;
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validateIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || value.length > 128) throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
}

function resultFromRequest(request: SubagentIpcRequest, childSessionId: string): SubagentResult | undefined {
	if (request.type !== "result" || !isRecord(request.payload) || typeof request.payload.text !== "string") return undefined;
	return {
		owner: request.owner,
		childSessionId: typeof request.payload.childSessionId === "string" ? request.payload.childSessionId : childSessionId,
		text: truncateSubagentResult(request.payload.text),
	};
}

function questionFromRequest(request: SubagentIpcRequest): SubagentQuestion | undefined {
	if (request.type !== "question" || !isRecord(request.payload) || typeof request.payload.questionId !== "string" || typeof request.payload.question !== "string") return undefined;
	try {
		validateIdentifier(request.payload.questionId, "questionId");
	} catch {
		return undefined;
	}
	const question = request.payload.question.trim();
	if (!question || Buffer.byteLength(question, "utf8") > MAX_SUBAGENT_RESULT_BYTES) return undefined;
	if (request.payload.options !== undefined) {
		if (!Array.isArray(request.payload.options) || request.payload.options.length > 20 || request.payload.options.some((option) => typeof option !== "string" || !option.trim() || Buffer.byteLength(option, "utf8") > 1_000)) return undefined;
		return { questionId: request.payload.questionId, question, options: request.payload.options.map((option) => option.trim()) };
	}
	return { questionId: request.payload.questionId, question };
}

function terminateChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const killTimer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 500);
	killTimer.unref();
}

function terminateRun(run: RunState): void {
	if (run.child) terminateChild(run.child);
	void run.surface?.close();
}

export class SubagentLaunchHost {
	readonly server: SubagentIpcServer;
	private readonly runs = new Map<string, RunState>();
	private readonly command: string;
	private readonly spawnProcess: SubagentSpawnProcess | undefined;
	private readonly cmux: CmuxTransport | undefined;
	private readonly ownership = new OwnershipLockManager();
	private closed = false;
	private listening = false;
	private readonly exitHandler = () => {
		for (const run of this.runs.values()) terminateRun(run);
	};

	constructor(private readonly options: SubagentLaunchHostOptions) {
		this.server = new SubagentIpcServer({
			socketPath: resolveSubagentSocketPath(options.parentSessionId, options.agentDir),
			logger: options.logger,
			onRequest: (request, connection) => this.handleRequest(request, connection),
			onDisconnect: (owner, error) => this.handleDisconnect(owner, error),
		});
		this.command = options.command ?? "pi";
		this.spawnProcess = options.spawnProcess;
		this.cmux = options.cmux === false ? undefined : options.cmux ?? new CmuxTransport({ logger: options.logger });
		process.on("exit", this.exitHandler);
	}

	async listen(): Promise<void> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		await this.server.listen();
		this.listening = true;
	}

	async launch(options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		if (!this.listening) await this.listen();
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
		options: Pick<SubagentLaunchOptions, "signal" | "onResult" | "onStatus" | "onQuestion"> = {},
	): Promise<SubagentLaunchHandle> {
		if (this.closed) throw new Error("Subagent launch host is closed.");
		if (!this.listening) await this.listen();
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
		if (!run?.pendingQuestion || run.pendingQuestion.question.questionId !== questionId || !answer.trim() || Buffer.byteLength(answer, "utf8") > MAX_SUBAGENT_RESULT_BYTES) return false;
		run.pendingQuestion.resolve(answer);
		return true;
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

	private async start(loadout: SubagentLoadout, loadoutPath: string, runtime: SubagentRuntimeOptions): Promise<SubagentLaunchHandle> {
		const depthError = validateSubagentDepth(loadout.depth);
		if (depthError) throw new Error(depthError);
		const existing = this.runs.get(loadout.owner);
		if (existing) {
			if (!existing.resultSettled) throw new Error(`Subagent owner already exists: ${loadout.owner}`);
			await this.server.closeOwner(loadout.owner);
			terminateRun(existing);
			this.runs.delete(loadout.owner);
			this.ownership.release(loadout.owner);
			existing.slot?.release();
		} else {
			// Result cleanup releases the run before the child socket necessarily emits close.
			await this.server.closeOwner(loadout.owner);
		}
		const args = buildSubagentCommandArgs(loadout, runtime.task);
		const ownership = this.ownership.acquire(loadout.owner, loadout.fileOwnership);
		if (!ownership.ok) throw new Error(`Subagent ownership overlaps ${ownership.conflict?.owner}: requested ${ownership.conflict?.requestedPath}, existing ${ownership.conflict?.existingPath}.`);
		let slot: AcquiredSubagentSlot;
		try {
			slot = await acquireSubagentSlot(loadout.cwd, runtime.signal);
		} catch (error) {
			this.ownership.release(loadout.owner);
			throw error;
		}
		const environment: Record<string, string> = {
			PI_SUBAGENT_SOCKET: this.server.socketPath,
			PI_SUBAGENT_TOKEN: this.server.token,
			PI_SUBAGENT_OWNER: loadout.owner,
			PI_SUBAGENT_PARENT_SESSION_ID: loadout.parentSessionId,
			PI_SUBAGENT_CHILD_SESSION_ID: loadout.childSessionId,
			PI_SUBAGENT_LOADOUT: loadoutPath,
		};
		let diagnostics: SubagentDiagnostics;
		try {
			diagnostics = createSubagentDiagnostics({ parentSessionId: loadout.parentSessionId, owner: loadout.owner, token: this.server.token, agentDir: this.options.agentDir });
		} catch (error) {
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
			loadoutPath,
			resolveResult,
			rejectResult,
			resultSettled: false,
			diagnostics,
			transport: "cmux",
			slot,
		};
		this.runs.set(loadout.owner, run);
		const releaseRun = () => {
			run.removeAbortListener?.();
			if (this.runs.get(loadout.owner) !== run) return;
			this.runs.delete(loadout.owner);
			this.ownership.release(loadout.owner);
			run.slot?.release();
		};
		run.cleanup = releaseRun;
		const finishChild = (error?: Error) => {
			if (run.resultSettled || run.failureFinalizing) return;
			run.failureFinalizing = true;
			run.resultSettled = true;
			run.pendingQuestion?.reject(error ?? new Error(`Subagent ${loadout.owner} exited before returning a result.`));
			void this.finalizeFailure(run, loadout.owner, error ?? new Error(`Subagent ${loadout.owner} exited before returning a result.`));
		};
		run.watchdog = createSubagentWatchdog({
			idleMs: this.options.timeoutPolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			maxTotalMs: this.options.timeoutPolicy?.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS,
			onFire: (kind) => finishChild(new Error(`Subagent ${loadout.owner} ${kind === "idle" ? "idle" : "maximum total"} timeout exceeded.`)),
		});
		const attachChild = (child: ChildProcess): void => {
			run.child = child;
			child.stdout?.on("data", (chunk: Buffer | string) => run.diagnostics.append("stdout", chunk));
			child.stderr?.on("data", (chunk: Buffer | string) => run.diagnostics.append("stderr", chunk));
			child.once("error", (error) => finishChild(error));
			child.once("exit", (code, signal) => finishChild(new Error(`Subagent ${loadout.owner} exited (${code ?? signal ?? "unknown"}).`)));
		};

		let transport: SubagentTransport = "cmux";
		let cmuxFailureReason: string | undefined;
		let surface: CmuxSurfaceHandle | undefined;
		try {
			if (this.cmux) {
				const outcome: CmuxLaunchOutcome = await this.cmux.launch({ cwd: loadout.cwd, title: loadout.agentName, command: this.command, args, env: environment });
				if (outcome.transport !== "cmux") throw new Error(outcome.reason);
				transport = outcome.transport;
				surface = outcome.surface;
			}
		} catch (error) {
			cmuxFailureReason = redactSubagentText(error instanceof Error ? error.message : String(error), this.server.token);
		}
		run.transport = transport;
		run.cmuxFailureReason = cmuxFailureReason;
		if (surface) {
			run.surface = surface;
			if (run.resultSettled) {
				run.surface = undefined;
				run.cleanup?.();
				void surface.close();
			}
		} else if (this.options.cmux === false && this.spawnProcess) {
			// Test-only seam. Production never falls back to a headless child.
			transport = "headless";
			run.transport = transport;
			try {
				attachChild(this.spawnProcess(this.command, args, {
					cwd: loadout.cwd,
					env: { ...process.env, ...environment },
					stdio: ["ignore", "pipe", "pipe"],
				}));
			} catch (error) {
				finishChild(error instanceof Error ? error : new Error(String(error)));
			}
		} else {
			finishChild(new Error(`Subagent ${loadout.owner} could not start interactive cmux session${cmuxFailureReason ? `: ${cmuxFailureReason}` : "."}`));
		}
		if (runtime.signal) {
			const abort = () => {
				this.reapBrowserPage(run, loadout.owner);
				run.watchdog?.cancel();
				terminateRun(run);
				run.diagnostics.close();
				if (!run.resultSettled) {
					run.resultSettled = true;
					run.rejectResult(new Error(`Subagent ${loadout.owner} aborted.`));
					releaseRun();
				}
			};
			if (runtime.signal.aborted) abort();
			else {
				runtime.signal.addEventListener("abort", abort, { once: true });
				run.removeAbortListener = () => runtime.signal?.removeEventListener("abort", abort);
			}
		}
		runtime.onStatus?.("running");
		void result.catch(() => undefined);
		return {
			owner: loadout.owner,
			childSessionId: loadout.childSessionId,
			pid: run.child?.pid,
			loadoutPath,
			transport: run.transport,
			logPath: run.diagnostics.logPath,
			...(run.cmuxFailureReason ? { cmuxFailureReason: run.cmuxFailureReason } : {}),
			result,
			request: (type, payload) => this.request(loadout.owner, type, payload),
			kill: () => {
				const current = this.runs.get(loadout.owner);
				if (current) terminateRun(current);
			},
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		process.off("exit", this.exitHandler);
		for (const [owner, run] of this.runs) {
			this.reapBrowserPage(run, owner);
			run.watchdog?.cancel();
			terminateRun(run);
			run.diagnostics.close();
			if (!run.resultSettled) {
				run.resultSettled = true;
				run.pendingQuestion?.reject(new Error(`Subagent ${owner} host closed.`));
				run.rejectResult(new Error(`Subagent ${owner} host closed.`));
			}
			run.cleanup?.();
		}
		await this.server.close();
	}

	private async request<T>(owner: string, type: SubagentIpcMessageType, payload: unknown): Promise<T> {
		const connection = this.server.getConnection(owner);
		if (!connection) throw new Error(`Subagent ${owner} is not connected.`);
		return connection.request<T>(type, payload);
	}

	private reapBrowserPage(run: RunState, owner: string): void {
		if (!run.tools.includes("browser_close") || !this.options.onBrowser) return;
		void Promise.resolve(this.options.onBrowser(owner, { tool: "browser_close", params: {} })).catch((error) => this.options.logger?.("browser_reap_failed", { owner, error: error instanceof Error ? error.message : String(error) }));
	}

	private async handleRequest(request: SubagentIpcRequest, _connection: unknown): Promise<unknown> {
		const run = this.runs.get(request.owner);
		if (!run) throw new Error(`Unknown subagent owner: ${request.owner}.`);
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
			const paths = request.payload.paths;
			if (paths !== undefined && (!Array.isArray(paths) || paths.some((item) => typeof item !== "string"))) throw new Error("Ownership paths are malformed.");
			const acquired = this.acquireOwnership(request.owner, paths as string[] | undefined);
			if (!acquired.ok) throw new Error(`Subagent ownership overlaps ${acquired.conflict?.owner}: requested ${acquired.conflict?.requestedPath}, existing ${acquired.conflict?.existingPath}.`);
			return acquired;
		}
		const question = questionFromRequest(request);
		if (question) {
			if (run.pendingQuestion) throw new Error(`Subagent ${request.owner} already has a pending question.`);
			const answer = new Promise<string>((resolve, reject) => {
				run.pendingQuestion = { question, resolve, reject };
			});
			run.options.onStatus?.("waiting");
			run.watchdog?.setWaiting(true);
			try {
				await run.options.onQuestion?.(question);
				return { questionId: question.questionId, answer: await answer };
			} finally {
				run.watchdog?.setWaiting(false);
				if (run.pendingQuestion?.question.questionId === question.questionId) run.pendingQuestion = undefined;
				if (!run.resultSettled) run.options.onStatus?.("running");
			}
		}
		const result = resultFromRequest(request, run.childSessionId);
		if (result) {
			if (!run.resultSettled) {
				run.resultSettled = true;
				run.watchdog?.cancel();
				run.diagnostics.close();
				run.resolveResult(result);
				void Promise.resolve(run.options.onResult?.(result.text)).catch((error) => this.options.logger?.("result_steering_failed", { error: String(error) }));
				this.reapBrowserPage(run, request.owner);
				const surface = run.surface;
				run.surface = undefined;
				run.cleanup?.();
				if (surface) void surface.close();
			}
			return { accepted: true };
		}
		throw new Error(`Unsupported child IPC message: ${request.type}.`);
	}

	private async finalizeFailure(run: RunState, owner: string, error: Error): Promise<void> {
		const safeError = redactSubagentText(error.message, this.server.token);
		if (run.surface) {
			try {
				run.diagnostics.append("cmux", await run.surface.readScreen(20));
			} catch (captureError) {
				this.options.logger?.("cmux_capture_failed", {
					owner,
					error: redactSubagentText(captureError instanceof Error ? captureError.message : String(captureError), this.server.token),
				});
			}
		}
		run.diagnostics.close();
		const failure = new SubagentFailureError(owner, {
			transport: run.transport,
			logPath: run.diagnostics.logPath,
			error: safeError,
			tail: run.diagnostics.tail(),
			...(run.cmuxFailureReason ? { cmuxFailureReason: run.cmuxFailureReason } : {}),
		});
		run.watchdog?.cancel();
		this.reapBrowserPage(run, owner);
		terminateRun(run);
		run.cleanup?.();
		run.rejectResult(failure);
	}

	private handleDisconnect(owner: string | undefined, error?: Error): void {
		if (!owner) return;
		const run = this.runs.get(owner);
		if (!run || run.resultSettled || run.failureFinalizing) return;
		run.failureFinalizing = true;
		run.resultSettled = true;
		const disconnectError = error ?? new Error(`Subagent ${owner} disconnected.`);
		run.pendingQuestion?.reject(disconnectError);
		void this.finalizeFailure(run, owner, disconnectError);
	}
}
