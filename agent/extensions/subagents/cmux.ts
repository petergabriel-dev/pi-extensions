import { execFile } from "node:child_process";

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
	close(): Promise<void>;
}

function defaultRun(command: string, args: readonly string[], timeoutMs: number): Promise<CmuxCommandResult> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) return reject(error);
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

	async launch(options: CmuxLaunchOptions): Promise<CmuxSurfaceHandle | undefined> {
		let surface: string | undefined;
		try {
			await this.run(this.command, ["identify", "--json"], this.commandTimeoutMs);
			const created = await this.run(this.command, [
				"new-surface",
				"--type", "terminal",
				"--working-directory", options.cwd,
				"--focus", "false",
			], this.commandTimeoutMs);
			surface = parseCmuxSurfaceRef(created.stdout);
			if (!surface) throw new Error("cmux did not return a surface ref.");
			await this.run(this.command, ["rename-tab", "--surface", surface, "--title", options.title], this.commandTimeoutMs);
			await this.waitForPrompt(surface);
			await this.run(this.command, ["send", "--surface", surface, `${buildCmuxCommandLine(options.command, options.args, options.env)}\n`], this.commandTimeoutMs);
			return { surface, close: () => this.closeSurface(surface!) };
		} catch (error) {
			this.logger?.("cmux_fallback", { error: errorMessage(error), surface });
			if (surface) await this.closeSurface(surface);
			return undefined;
		}
	}

	private async waitForPrompt(surface: string): Promise<void> {
		const deadline = Date.now() + this.promptTimeoutMs;
		let nudged = false;
		while (Date.now() < deadline) {
			try {
				const screen = await this.run(this.command, ["read-screen", "--surface", surface, "--lines", "20"], this.commandTimeoutMs);
				if (shellPromptReady(screen.stdout)) return;
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
		} catch (error) {
			this.logger?.("cmux_close_failed", { surface, error: errorMessage(error) });
		}
	}
}
