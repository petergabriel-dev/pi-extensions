import { execFile } from "node:child_process";

import { MAX_SUBAGENT_TAIL_BYTES, redactSubagentText } from "./diagnostics.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 1_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 2_000;
const DEFAULT_PROMPT_POLL_MS = 100;

export interface CmuxCommandResult {
	stdout: string;
	stderr: string;
}

export type CmuxCommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CmuxCommandResult>;

export interface CmuxTransportOptions {
	command?: string;
	run?: CmuxCommandRunner;
	commandTimeoutMs?: number;
	promptTimeoutMs?: number;
	promptPollMs?: number;
	logger?: (event: string, details?: Record<string, unknown>) => void;
}

export interface CmuxLaunchOptions {
	cwd: string;
	title: string;
	command: string;
	args: readonly string[];
	env: Record<string, string>;
}

export interface CmuxSurfaceHandle {
	readonly surface: string;
	readScreen(lines?: number): Promise<string>;
	close(): Promise<void>;
}

export type CmuxLaunchOutcome =
	| { transport: "cmux"; surface: CmuxSurfaceHandle }
	/** @deprecated Test-only compatibility shape; CmuxTransport now throws on failure. */
	| { transport: "headless"; reason: string };

export type CmuxFailureKind = "binary-missing" | "socket-unreachable" | "auth-rejected" | "surface-creation-failed";

type CmuxFailureStage = "preflight" | "surface";

const CMUX_FAILURE_MESSAGES: Record<CmuxFailureKind, string> = {
	"binary-missing": "cmux binary missing.",
	"socket-unreachable": "cmux socket unreachable.",
	"auth-rejected": "cmux auth rejected.",
	"surface-creation-failed": "cmux surface creation failed.",
};

export class CmuxLaunchError extends Error {
	readonly kind: CmuxFailureKind;

	constructor(kind: CmuxFailureKind) {
		super(CMUX_FAILURE_MESSAGES[kind]);
		this.name = "CmuxLaunchError";
		this.kind = kind;
	}
}

function defaultRun(command: string, args: readonly string[], timeoutMs: number): Promise<CmuxCommandResult> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) {
				const commandError = error as Error & { stderr?: string; stdout?: string };
				commandError.stderr = String(stderr);
				commandError.stdout = String(stdout);
				return reject(commandError);
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function errorText(error: unknown): string {
	if (!isRecord(error)) return String(error);
	return [error.message, error.code, error.stderr, error.stdout].filter((value) => typeof value === "string").join(" ");
}

function classifyCmuxFailure(error: unknown, stage: CmuxFailureStage): CmuxFailureKind {
	const text = errorText(error).toLowerCase();
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || /(?:spawn|exec).*cmux.*enoent|command not found|cmux (?:binary )?(?:not found|missing)/.test(text)) return "binary-missing";
	if (/auth(?:entication)?|unauthori[sz]ed|forbidden|invalid (?:password|credential)|permission denied/.test(text)) return "auth-rejected";
	if (/socket|econnrefused|econnreset|enotconn|connection|connect|unreachable|timed out|timeout/.test(text)) return "socket-unreachable";
	return stage === "preflight" ? "socket-unreachable" : "surface-creation-failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCmuxCommandLine(command: string, args: readonly string[], env: Record<string, string>): string {
	const environment = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
	return [...environment, shellQuote(command), ...args.map(shellQuote)].join(" ");
}

export function parseCmuxSurfaceRef(output: string): string | undefined {
	try {
		const value: unknown = JSON.parse(output);
		if (isRecord(value)) {
			for (const key of ["surface", "surface_ref", "surfaceRef", "id"]) {
				if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
			}
		}
	} catch {
		// cmux defaults to plain refs, not JSON.
	}
	return output.match(/\bsurface:[A-Za-z0-9_-]+\b/)?.[0] ?? output.trim().split(/\s+/).find((part) => /^surface:[A-Za-z0-9_-]+$/.test(part));
}

export function shellPromptReady(screen: string): boolean {
	const clean = screen.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	const lastLine = clean.split(/\r?\n/).reverse().find((line) => line.trim());
	return Boolean(lastLine && /(?:[$%#>❯➜])\s*$/.test(lastLine));
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CmuxTransport {
	private readonly command: string;
	private readonly run: CmuxCommandRunner;
	private readonly commandTimeoutMs: number;
	private readonly promptTimeoutMs: number;
	private readonly promptPollMs: number;
	private readonly logger?: (event: string, details?: Record<string, unknown>) => void;

	constructor(options: CmuxTransportOptions = {}) {
		this.command = options.command ?? "cmux";
		this.run = options.run ?? defaultRun;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
		this.promptPollMs = options.promptPollMs ?? DEFAULT_PROMPT_POLL_MS;
		this.logger = options.logger;
	}

	async launch(options: CmuxLaunchOptions): Promise<CmuxLaunchOutcome> {
		let surface: string | undefined;
		try {
			try {
				await this.run(this.command, ["identify", "--json"], this.commandTimeoutMs);
			} catch (error) {
				throw new CmuxLaunchError(classifyCmuxFailure(error, "preflight"));
			}
			let created: CmuxCommandResult;
			try {
				created = await this.run(this.command, [
					"new-surface",
					"--type", "terminal",
					"--working-directory", options.cwd,
					"--focus", "false",
				], this.commandTimeoutMs);
			} catch (error) {
				throw new CmuxLaunchError(classifyCmuxFailure(error, "surface"));
			}
			surface = parseCmuxSurfaceRef(created.stdout);
			if (!surface) throw new CmuxLaunchError("surface-creation-failed");
			await this.run(this.command, ["rename-tab", "--surface", surface, "--title", options.title], this.commandTimeoutMs);
			await this.waitForPrompt(surface);
			await this.run(this.command, ["send", "--surface", surface, `${buildCmuxCommandLine(options.command, options.args, options.env)}\n`], this.commandTimeoutMs);
			return {
				transport: "cmux",
				surface: {
					surface,
					readScreen: (lines = 20) => this.readScreen(surface!, lines, options.env.PI_SUBAGENT_TOKEN),
					close: () => this.closeSurface(surface!),
				},
			};
		} catch (error) {
			const failure = error instanceof CmuxLaunchError ? error : new CmuxLaunchError(classifyCmuxFailure(error, surface ? "surface" : "preflight"));
			this.logger?.("cmux_launch_failed", { kind: failure.kind, surface });
			if (surface) await this.closeSurface(surface);
			throw failure;
		}
	}

	private async readScreen(surface: string, lines: number, token = ""): Promise<string> {
		const boundedLines = Number.isInteger(lines) ? Math.max(1, Math.min(100, lines)) : 20;
		const screen = await this.run(this.command, ["read-screen", "--surface", surface, "--lines", String(boundedLines)], this.commandTimeoutMs);
		let output = redactSubagentText(screen.stdout, token);
		while (Buffer.byteLength(output, "utf8") > MAX_SUBAGENT_TAIL_BYTES) output = output.slice(1);
		return output;
	}

	private async waitForPrompt(surface: string): Promise<void> {
		const deadline = Date.now() + this.promptTimeoutMs;
		let nudged = false;
		while (Date.now() < deadline) {
			try {
				const screen = await this.readScreen(surface, 20);
				if (shellPromptReady(screen)) return;
			} catch {
				// A fresh cmux terminal can have no readable buffer until it receives a key.
			}
			if (!nudged) {
				nudged = true;
				try {
					await this.run(this.command, ["send-key", "--surface", surface, "enter"], this.commandTimeoutMs);
				} catch {
					// Retry read-screen until readiness deadline.
				}
			}
			await wait(Math.min(this.promptPollMs, Math.max(1, deadline - Date.now())));
		}
		throw new Error(`cmux surface ${surface} shell was not ready before timeout.`);
	}

	private async closeSurface(surface: string): Promise<void> {
		try {
			await this.run(this.command, ["close-surface", "--surface", surface], this.commandTimeoutMs);
		} catch {
			this.logger?.("cmux_close_failed", { surface });
		}
	}
}
