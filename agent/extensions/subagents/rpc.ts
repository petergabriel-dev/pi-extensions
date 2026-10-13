import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";

export const SUBAGENT_RPC_MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const SUBAGENT_RPC_MAX_STDERR_BYTES = 1024 * 1024;
const MAX_RPC_ID_BYTES = 128;
const STOP_TERM_DELAY_MS = 1_000;
const STOP_KILL_DELAY_MS = 500;

export type SubagentRpcErrorKind = "launch" | "protocol" | "process" | "command" | "stopped";

export class SubagentRpcError extends Error {
	constructor(readonly kind: SubagentRpcErrorKind, message: string) {
		super(message);
		this.name = "SubagentRpcError";
	}
}

export type SubagentRpcEvent = Record<string, unknown> & { type: string };
export type SubagentRpcLogger = (event: string, details?: Record<string, unknown>) => void;
export type SubagentRpcSpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type SubagentRpcUiResponse = { value: unknown } | { cancelled: true };

export interface SubagentRpcProcessOptions {
	args: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawnProcess?: SubagentRpcSpawnProcess;
	logger?: SubagentRpcLogger;
	stderrSink?: (chunk: Uint8Array) => void;
	onEvent?: (event: SubagentRpcEvent) => void;
	onUiRequest?: (id: string, method: string, payload: Record<string, unknown>) => void | Promise<void>;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface SubagentRpcPromptResult {
	disposition: "started" | "queued" | "handled";
}

export interface SubagentRpcState extends Record<string, unknown> {
	sessionFile?: string;
}

interface PendingCommand {
	command: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

const RPC_EVENT_TYPES = new Set([
	"agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
	"message_start", "message_update", "message_end",
	"tool_execution_start", "tool_execution_update", "tool_execution_end",
	"queue_update", "compaction_start", "compaction_end",
	"auto_retry_start", "auto_retry_end", "extension_error",
	"entry_appended", "session_info_changed", "thinking_level_changed",
	"summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
	"bash_execution_update",
]);
const RPC_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class SubagentRpcJsonlDecoder {
	private chunks: Buffer[] = [];
	private recordBytes = 0;

	constructor(private readonly maxRecordBytes: number) {}

	push(chunk: Buffer): Buffer[] {
		const records: Buffer[] = [];
		let start = 0;
		for (let index = 0; index < chunk.length; index += 1) {
			if (chunk[index] !== 0x0a) continue;
			this.append(chunk.subarray(start, index));
			records.push(this.take());
			start = index + 1;
		}
		this.append(chunk.subarray(start));
		return records;
	}

	hasPartialRecord(): boolean {
		return this.recordBytes > 0;
	}

	private append(chunk: Buffer): void {
		if (!chunk.length) return;
		this.recordBytes += chunk.length;
		if (this.recordBytes > this.maxRecordBytes) {
			throw new SubagentRpcError("protocol", `RPC record exceeds ${this.maxRecordBytes} bytes.`);
		}
		this.chunks.push(chunk);
	}

	private take(): Buffer {
		const record = Buffer.concat(this.chunks, this.recordBytes);
		this.chunks = [];
		this.recordBytes = 0;
		return record;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_RPC_ID_BYTES;
}

function rpcError(error: unknown, kind: SubagentRpcErrorKind): SubagentRpcError {
	return error instanceof SubagentRpcError ? error : new SubagentRpcError(kind, error instanceof Error ? error.message : String(error));
}

export function resolvePiCliPath(candidate = process.argv[1]): string {
	if (!candidate) throw new SubagentRpcError("launch", "Parent Pi CLI path is unavailable in process.argv[1].");
	try {
		const resolved = fs.realpathSync(path.resolve(candidate));
		if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
		return resolved;
	} catch {
		throw new SubagentRpcError("launch", "Could not resolve parent Pi CLI script from process.argv[1].");
	}
}

export class SubagentRpcProcess {
	readonly child: ChildProcess;
	private readonly decoder = new SubagentRpcJsonlDecoder(SUBAGENT_RPC_MAX_RECORD_BYTES);
	private readonly pending = new Map<string, PendingCommand>();
	private readonly logger: SubagentRpcLogger;
	private readonly exitPromise: Promise<void>;
	private resolveExit!: () => void;
	private writeQueue: Promise<void> = Promise.resolve();
	private stderrBytes = 0;
	private stderrTruncated = false;
	private closed = false;
	private stopping = false;
	private stopPromise?: Promise<void>;

	constructor(private readonly options: SubagentRpcProcessOptions) {
		this.logger = options.logger ?? (() => undefined);
		this.exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
		const piCliPath = resolvePiCliPath();
		const args = [piCliPath, "--mode", "rpc", ...options.args];
		const spawnProcess = options.spawnProcess ?? ((command, argv, spawnOptions) => spawn(command, [...argv], spawnOptions));
		try {
			this.child = spawnProcess(process.execPath, args, {
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			throw new SubagentRpcError("launch", `Could not spawn parent Pi CLI process: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
			this.child.kill("SIGKILL");
			throw new SubagentRpcError("launch", "RPC child process did not provide piped stdin, stdout, and stderr.");
		}

		this.child.stdout.on("data", (chunk: Buffer | string) => this.receiveStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		this.child.stdout.on("error", (error) => this.fail(new SubagentRpcError("process", `RPC child stdout failed: ${error.message}`)));
		this.child.stdout.on("end", () => {
			if (this.decoder.hasPartialRecord()) this.log("incomplete_record_ignored", { reason: "missing_lf" });
		});
		this.child.stderr.on("data", (chunk: Buffer | string) => this.receiveStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		this.child.stderr.on("error", () => this.log("stderr_stream_error", {}));
		this.child.stdin.on("error", (error) => this.fail(new SubagentRpcError("process", `RPC child stdin failed: ${error.message}`)));
		this.child.once("error", (error) => {
			const kind = this.child.pid === undefined ? "launch" : "process";
			this.finish(null, null, new SubagentRpcError(kind, `RPC child process failed: ${error.message}`));
		});
		this.child.once("exit", (code, signal) => {
			const message = `RPC child exited (${code ?? signal ?? "unknown"}).`;
			this.finish(code, signal, new SubagentRpcError("process", message));
		});
	}

	prompt(message: string): Promise<SubagentRpcPromptResult> {
		return this.command<{ disposition?: unknown }>("prompt", { message }).then((data) => {
			const disposition = data?.disposition;
			return { disposition: disposition === "queued" || disposition === "handled" ? disposition : "started" };
		});
	}

	async followUp(message: string): Promise<void> {
		await this.command("follow_up", { message });
	}

	async steer(message: string): Promise<void> {
		await this.command("steer", { message });
	}

	async abort(): Promise<void> {
		await this.command("abort");
	}

	async getState(): Promise<SubagentRpcState> {
		const data = await this.command<unknown>("get_state");
		if (data === undefined) return {};
		if (!isRecord(data)) throw new SubagentRpcError("protocol", "RPC get_state response data must be an object.");
		return data as SubagentRpcState;
	}

	async getLastAssistantText(): Promise<string | null | undefined> {
		const data = await this.command<unknown>("get_last_assistant_text");
		if (data === undefined) return undefined;
		if (!isRecord(data) || (data.text !== null && data.text !== undefined && typeof data.text !== "string")) {
			throw new SubagentRpcError("protocol", "RPC get_last_assistant_text response data is malformed.");
		}
		return data.text as string | null | undefined;
	}

	async respondUi(id: string, response: SubagentRpcUiResponse): Promise<void> {
		if (!isBoundedId(id)) throw new SubagentRpcError("protocol", "RPC extension UI request id is invalid.");
		if (!isRecord(response) || ("cancelled" in response ? response.cancelled !== true : !("value" in response))) {
			throw new SubagentRpcError("protocol", "RPC extension UI response must contain value or cancelled.");
		}
		const record = "cancelled" in response
			? { type: "extension_ui_response", id, cancelled: true }
			: { type: "extension_ui_response", id, value: response.value };
		await this.sendRecord(record);
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.closed) return Promise.resolve();
		this.stopping = true;
		this.rejectPending(new SubagentRpcError("stopped", "RPC process stopped before command completed."));
		try {
			if (this.child.stdin && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
		} catch {
			// Process exit or stdin failure is handled through the exit hook.
		}

		let termTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		this.stopPromise = new Promise<void>((resolve) => {
			this.exitPromise.then(() => {
				if (termTimer) clearTimeout(termTimer);
				if (killTimer) clearTimeout(killTimer);
				resolve();
			});
			termTimer = setTimeout(() => {
				if (this.closed) return;
				try { this.child.kill("SIGTERM"); } catch { /* best effort */ }
				killTimer = setTimeout(() => {
					if (!this.closed) {
						try { this.child.kill("SIGKILL"); } catch { /* best effort */ }
					}
				}, STOP_KILL_DELAY_MS);
				killTimer.unref();
			}, STOP_TERM_DELAY_MS);
			termTimer.unref();
		});
		return this.stopPromise;
	}

	private command<T>(command: string, fields: Record<string, unknown> = {}): Promise<T | undefined> {
		if (this.closed || this.stopping) return Promise.reject(new SubagentRpcError("stopped", "RPC process is not running."));
		const id = randomUUID();
		const record = { id, type: command, ...fields };
		return new Promise<T | undefined>((resolve, reject) => {
			this.pending.set(id, {
				command,
				resolve: (data) => resolve(data as T | undefined),
				reject,
			});
			void this.sendRecord(record).catch((error: unknown) => this.rejectPendingById(id, rpcError(error, "process")));
		});
	}

	private sendRecord(record: Record<string, unknown>): Promise<void> {
		if (this.closed || this.stopping) return Promise.reject(new SubagentRpcError("stopped", "RPC process is not running."));
		let bytes: Buffer;
		try {
			bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			return Promise.reject(new SubagentRpcError("protocol", `Could not serialize RPC record: ${error instanceof Error ? error.message : String(error)}`));
		}
		if (bytes.byteLength - 1 > SUBAGENT_RPC_MAX_RECORD_BYTES) {
			return Promise.reject(new SubagentRpcError("protocol", `RPC command exceeds ${SUBAGENT_RPC_MAX_RECORD_BYTES} bytes.`));
		}
		const write = this.writeQueue.then(async () => {
			if (this.closed || this.stopping) throw new SubagentRpcError("stopped", "RPC process is not running.");
			const stdin = this.child.stdin;
			if (!stdin || stdin.destroyed || stdin.writableEnded) throw new SubagentRpcError("process", "RPC child stdin is closed.");
			if (!stdin.write(bytes)) await once(stdin, "drain");
		});
		this.writeQueue = write.catch(() => undefined);
		return write;
	}

	private receiveStdout(chunk: Buffer): void {
		if (this.closed) return;
		let records: Buffer[];
		try {
			records = this.decoder.push(chunk);
		} catch (error) {
			const failure = rpcError(error, "protocol");
			this.log("protocol_failure", { kind: failure.kind });
			this.fail(failure);
			return;
		}
		for (const bytes of records) this.handleRecord(bytes);
	}

	private handleRecord(bytes: Buffer): void {
		let line = bytes;
		if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
		let text: string;
		try {
			text = RPC_UTF8_DECODER.decode(line);
		} catch {
			this.log("invalid_record_ignored", { reason: "utf8", bytes: bytes.byteLength });
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			this.log("invalid_record_ignored", { reason: "json", bytes: bytes.byteLength });
			return;
		}
		if (!isRecord(value) || typeof value.type !== "string") {
			this.log("invalid_record_ignored", { reason: "shape", bytes: bytes.byteLength });
			return;
		}
		if (value.type === "response") {
			this.handleResponse(value);
			return;
		}
		if (value.type === "extension_ui_request") {
			this.handleUiRequest(value);
			return;
		}
		if (RPC_EVENT_TYPES.has(value.type)) {
			try { this.options.onEvent?.(value as SubagentRpcEvent); }
			catch { this.log("event_callback_failed", { type: value.type }); }
			return;
		}
		this.log("unknown_record_ignored", {});
	}

	private handleResponse(response: Record<string, unknown>): void {
		if (!isBoundedId(response.id)) {
			this.log("invalid_response_ignored", { reason: "id" });
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) {
			this.log("unmatched_response_ignored", {});
			return;
		}
		if (response.command !== pending.command || typeof response.success !== "boolean") {
			this.fail(new SubagentRpcError("protocol", "RPC response did not match its pending command."));
			return;
		}
		this.pending.delete(response.id);
		if (!response.success) {
			const message = typeof response.error === "string" ? response.error : "RPC command failed.";
			pending.reject(new SubagentRpcError("command", message));
			return;
		}
		pending.resolve(response.data);
	}

	private handleUiRequest(request: Record<string, unknown>): void {
		if (!isBoundedId(request.id) || typeof request.method !== "string" || request.method.length === 0 || Buffer.byteLength(request.method, "utf8") > 128) {
			this.log("invalid_ui_request_ignored", { reason: "shape" });
			return;
		}
		const { id, method, ...payload } = request;
		delete payload.type;
		try {
			const result = this.options.onUiRequest?.(id, method, payload);
			if (result && typeof result.then === "function") void result.catch(() => this.log("ui_callback_failed", {}));
		} catch {
			this.log("ui_callback_failed", {});
		}
	}

	private receiveStderr(chunk: Buffer): void {
		const remaining = SUBAGENT_RPC_MAX_STDERR_BYTES - this.stderrBytes;
		if (remaining <= 0) {
			if (!this.stderrTruncated) this.log("stderr_truncated", { limitBytes: SUBAGENT_RPC_MAX_STDERR_BYTES });
			this.stderrTruncated = true;
			return;
		}
		const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
		this.stderrBytes += accepted.byteLength;
		try { this.options.stderrSink?.(accepted); }
		catch { this.log("stderr_sink_failed", {}); }
		if (accepted.byteLength < chunk.byteLength && !this.stderrTruncated) {
			this.stderrTruncated = true;
			this.log("stderr_truncated", { limitBytes: SUBAGENT_RPC_MAX_STDERR_BYTES });
		}
	}

	private fail(error: SubagentRpcError): void {
		if (this.closed) return;
		this.rejectPending(error);
		void this.stop();
	}

	private finish(code: number | null, signal: NodeJS.Signals | null, error: SubagentRpcError): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectPending(error);
		try { this.options.onExit?.(code, signal); }
		catch { this.log("exit_callback_failed", {}); }
		this.resolveExit();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	private rejectPendingById(id: string, error: Error): void {
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		request.reject(error);
	}

	private log(event: string, details?: Record<string, unknown>): void {
		try { this.logger(event, details); }
		catch { /* Logging must not interrupt RPC process handling. */ }
	}
}
