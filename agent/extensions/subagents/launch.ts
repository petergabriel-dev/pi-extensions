import * as crypto from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAVEMAN_PROMPT } from "../workflow-modes/caveman.ts";
import type { AgentRole, AgentConfig } from "./agents.ts";
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
	createdAt: string;
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
	onResult?: (text: string) => void | Promise<void>;
}

export type SubagentSpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SubagentLaunchHostOptions {
	parentSessionId: string;
	agentDir?: string;
	logger?: (event: string, details?: Record<string, unknown>) => void;
	command?: string;
	spawnProcess?: SubagentSpawnProcess;
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
	readonly result: Promise<SubagentResult>;
	request<T = unknown>(type: SubagentIpcMessageType, payload?: unknown): Promise<T>;
	kill(): void;
}

interface RunState {
	options: SubagentLaunchOptions;
	childSessionId: string;
	child: ChildProcess;
	loadoutPath: string;
	resolveResult: (result: SubagentResult) => void;
	rejectResult: (error: Error) => void;
	resultSettled: boolean;
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
	if (!isRecord(value) || value.version !== LOADOUT_VERSION || typeof value.parentSessionId !== "string" || typeof value.childSessionId !== "string" || typeof value.owner !== "string" || !Array.isArray(value.tools) || typeof value.appendSystemPrompt !== "string" || typeof value.cavemanEnabled !== "boolean") {
		throw new Error("Invalid subagent loadout.");
	}
	return value as SubagentLoadout;
}

export function buildSubagentCommandArgs(loadout: SubagentLoadout, task: string): string[] {
	const args = [
		"--no-extensions",
		"-e", loadout.extensionPath,
		"--print",
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

function terminateChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const killTimer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 500);
	killTimer.unref();
}

export class SubagentLaunchHost {
	readonly server: SubagentIpcServer;
	private readonly runs = new Map<string, RunState>();
	private readonly command: string;
	private readonly spawnProcess: SubagentSpawnProcess;
	private closed = false;
	private listening = false;
	private readonly exitHandler = () => {
		for (const run of this.runs.values()) terminateChild(run.child);
	};

	constructor(private readonly options: SubagentLaunchHostOptions) {
		this.server = new SubagentIpcServer({
			socketPath: resolveSubagentSocketPath(options.parentSessionId, options.agentDir),
			logger: options.logger,
			onRequest: (request, connection) => this.handleRequest(request, connection),
			onDisconnect: (owner, error) => this.handleDisconnect(owner, error),
		});
		this.command = options.command ?? "pi";
		this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
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
		if (this.runs.has(options.owner)) throw new Error(`Subagent owner already exists: ${options.owner}`);

		const childSessionId = options.childSessionId ?? crypto.randomUUID();
		validateIdentifier(childSessionId, "childSessionId");
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
			createdAt: new Date().toISOString(),
		};
		const loadoutPath = writeSubagentLoadout(loadout, this.options.agentDir ?? getAgentDir());
		const args = buildSubagentCommandArgs(loadout, options.task);
		const result = new Promise<SubagentResult>((resolve, reject) => {
			const child = this.spawnProcess(this.command, args, {
				cwd: options.cwd,
				env: {
					...process.env,
					PI_SUBAGENT_SOCKET: this.server.socketPath,
					PI_SUBAGENT_TOKEN: this.server.token,
					PI_SUBAGENT_OWNER: options.owner,
					PI_SUBAGENT_PARENT_SESSION_ID: options.parentSessionId,
					PI_SUBAGENT_CHILD_SESSION_ID: childSessionId,
					PI_SUBAGENT_LOADOUT: loadoutPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			const run: RunState = { options, childSessionId, child, loadoutPath, resolveResult: resolve, rejectResult: reject, resultSettled: false };
			this.runs.set(options.owner, run);
			child.stdout?.on("data", () => undefined);
			child.stderr?.on("data", () => undefined);
			const finishChild = (error?: Error) => {
				run.removeAbortListener?.();
				this.runs.delete(options.owner);
				if (!run.resultSettled) {
					run.resultSettled = true;
					if (error) reject(error);
					else reject(new Error(`Subagent ${options.owner} exited before returning a result.`));
				}
			};
			child.once("error", (error) => finishChild(error));
			child.once("exit", (code, signal) => finishChild(new Error(`Subagent ${options.owner} exited (${code ?? signal ?? "unknown"}).`)));
			if (options.signal) {
				const abort = () => terminateChild(child);
				if (options.signal.aborted) abort();
				else {
					options.signal.addEventListener("abort", abort, { once: true });
					run.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
				}
			}
		});
		void result.catch(() => undefined);
		return {
			owner: options.owner,
			childSessionId,
			pid: this.runs.get(options.owner)?.child.pid,
			loadoutPath,
			result,
			request: (type, payload) => this.request(options.owner, type, payload),
			kill: () => {
				const run = this.runs.get(options.owner);
				if (run) terminateChild(run.child);
			},
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		process.off("exit", this.exitHandler);
		for (const run of this.runs.values()) terminateChild(run.child);
		await this.server.close();
	}

	private async request<T>(owner: string, type: SubagentIpcMessageType, payload: unknown): Promise<T> {
		const connection = this.server.getConnection(owner);
		if (!connection) throw new Error(`Subagent ${owner} is not connected.`);
		return connection.request<T>(type, payload);
	}

	private async handleRequest(request: SubagentIpcRequest, _connection: unknown): Promise<unknown> {
		const run = this.runs.get(request.owner);
		if (!run) throw new Error(`Unknown subagent owner: ${request.owner}.`);
		const result = resultFromRequest(request, run.childSessionId);
		if (result) {
			if (!run.resultSettled) {
				run.resultSettled = true;
				run.resolveResult(result);
				void Promise.resolve(run.options.onResult?.(result.text)).catch((error) => this.options.logger?.("result_steering_failed", { error: String(error) }));
			}
			return { accepted: true };
		}
		throw new Error(`Unsupported child IPC message: ${request.type}.`);
	}

	private handleDisconnect(owner: string | undefined, error?: Error): void {
		if (!owner) return;
		const run = this.runs.get(owner);
		if (!run || run.resultSettled) return;
		run.resultSettled = true;
		run.rejectResult(error ?? new Error(`Subagent ${owner} disconnected.`));
	}
}
