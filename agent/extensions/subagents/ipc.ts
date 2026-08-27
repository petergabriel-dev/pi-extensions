import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const IPC_MAX_FRAME_BYTES = 256 * 1024;
const IPC_SOCKET_DIR_MODE = 0o700;
const IPC_SOCKET_MODE = 0o600;
const MAX_IDENTIFIER_BYTES = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type SubagentIpcMessageType = "hello" | "ownership" | "browser" | "question" | "result";
export type SubagentIpcLogger = (event: string, details?: Record<string, unknown>) => void;

export interface SubagentIpcRequest<T = unknown> {
	kind: "request";
	token: string;
	requestId: string;
	owner: string;
	type: SubagentIpcMessageType;
	payload: T;
}

export interface SubagentIpcResponse<T = unknown> {
	kind: "response";
	token: string;
	requestId: string;
	owner: string;
	ok: boolean;
	result?: T;
	error?: string;
}

export type SubagentIpcFrame = SubagentIpcRequest | SubagentIpcResponse;

export interface SubagentIpcRequestOptions {
	requestId?: string;
	timeoutMs?: number;
}

export interface SubagentIpcResponseOptions {
	requestId?: string;
	owner?: string;
}

export interface SubagentIpcConnectionOptions {
	token: string;
	owner?: string;
	logger?: SubagentIpcLogger;
	onRequest?: (request: SubagentIpcRequest, connection: SubagentIpcConnection) => Promise<unknown> | unknown;
	onOwner?: (owner: string, connection: SubagentIpcConnection) => boolean;
	onDisconnect?: (owner: string | undefined, error?: Error) => void;
}

export interface SubagentIpcServerOptions extends Omit<SubagentIpcConnectionOptions, "owner" | "onOwner" | "onDisconnect"> {
	socketPath?: string;
	sessionId?: string;
	agentDir?: string;
	onDisconnect?: (owner: string | undefined, error?: Error) => void;
}

export interface SubagentIpcClientOptions extends Omit<SubagentIpcConnectionOptions, "onOwner"> {
	socketPath: string;
	owner: string;
	connectTimeoutMs?: number;
}

export function createSubagentIpcToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

export function resolveSubagentSocketPath(sessionId: string, agentDir = getAgentDir()): string {
	validateIdentifier(sessionId, "sessionId");
	return path.join(agentDir, "subagents", `${sessionId}.sock`);
}

export function encodeSubagentIpcFrame(frame: SubagentIpcFrame, maxBytes = IPC_MAX_FRAME_BYTES): Buffer {
	const serialized = JSON.stringify(frame);
	if (!serialized) throw new Error("IPC frame must be a JSON object.");
	const body = Buffer.from(serialized, "utf8");
	if (body.length === 0 || body.length > maxBytes) {
		throw new Error(`IPC frame exceeds ${maxBytes} bytes.`);
	}
	const encoded = Buffer.allocUnsafe(4 + body.length);
	encoded.writeUInt32BE(body.length, 0);
	body.copy(encoded, 4);
	return encoded;
}

export class SubagentIpcFrameDecoder {
	private buffer = Buffer.alloc(0);

	constructor(private readonly maxBytes = IPC_MAX_FRAME_BYTES) {}

	push(chunk: Buffer | Uint8Array): unknown[] {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		const frames: unknown[] = [];
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32BE(0);
			if (length === 0 || length > this.maxBytes) throw new Error(`Invalid IPC frame length ${length}.`);
			if (this.buffer.length < 4 + length) break;
			const body = this.buffer.subarray(4, 4 + length).toString("utf8");
			this.buffer = this.buffer.subarray(4 + length);
			try {
				frames.push(JSON.parse(body));
			} catch {
				throw new Error("Invalid JSON IPC frame.");
			}
		}
		if (this.buffer.length > 4 + this.maxBytes) throw new Error("Incomplete IPC frame exceeds maximum size.");
		return frames;
	}
}

export function parseSubagentIpcFrame(value: unknown): SubagentIpcFrame | undefined {
	if (!isRecord(value) || (value.kind !== "request" && value.kind !== "response")) return undefined;
	if (!boundedString(value.token, MAX_IDENTIFIER_BYTES) || !boundedString(value.requestId, MAX_IDENTIFIER_BYTES) || !boundedString(value.owner, MAX_IDENTIFIER_BYTES)) return undefined;
	if (value.kind === "request") {
		if (!isMessageType(value.type)) return undefined;
		return value as SubagentIpcRequest;
	}
	if (typeof value.ok !== "boolean") return undefined;
	if (value.ok === false && !boundedString(value.error, IPC_MAX_FRAME_BYTES)) return undefined;
	return value as SubagentIpcResponse;
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validateIdentifier(value: string, label: string): void {
	if (!boundedString(value, MAX_IDENTIFIER_BYTES) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
	}
}

function isMessageType(value: unknown): value is SubagentIpcMessageType {
	return value === "hello" || value === "ownership" || value === "browser" || value === "question" || value === "result";
}

function errorFrom(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function defaultLogger(event: string, details?: Record<string, unknown>): void {
	console.warn(`[subagent-ipc] ${event}`, details ?? "");
}

function validateTimeout(value: number | undefined, label: string): number {
	const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error(`${label} must be an integer from 1 to 120000.`);
	return timeout;
}

interface PendingRequest {
	owner: string;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

export class SubagentIpcDisconnectedError extends Error {
	constructor(message = "Subagent IPC connection closed.") {
		super(message);
		this.name = "SubagentIpcDisconnectedError";
	}
}

export class SubagentIpcConnection {
	private readonly decoder = new SubagentIpcFrameDecoder();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly logger: SubagentIpcLogger;
	private ownerValue: string | undefined;
	private closed = false;
	private disconnectError: Error | undefined;

	constructor(private readonly socket: net.Socket, private readonly options: SubagentIpcConnectionOptions) {
		this.logger = options.logger ?? defaultLogger;
		this.ownerValue = options.owner;
		socket.setNoDelay(true);
		socket.on("data", (chunk) => this.receive(chunk));
		socket.on("error", (error) => this.finish(errorFrom(error)));
		socket.on("close", () => this.finish(this.disconnectError));
	}

	get owner(): string | undefined {
		return this.ownerValue;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	async request<T = unknown>(type: SubagentIpcMessageType, payload: unknown = {}, options: SubagentIpcRequestOptions = {}): Promise<T> {
		if (this.closed) throw this.disconnectError ?? new SubagentIpcDisconnectedError();
		if (!isMessageType(type)) throw new Error(`Unsupported IPC message type: ${String(type)}.`);
		if (!this.ownerValue) throw new Error("IPC owner is not established.");
		const requestId = options.requestId ?? crypto.randomUUID();
		validateIdentifier(requestId, "requestId");
		const timeoutMs = validateTimeout(options.timeoutMs, "timeoutMs");
		const frame: SubagentIpcRequest = { kind: "request", token: this.options.token, requestId, owner: this.ownerValue, type, payload };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`IPC request ${requestId} timed out after ${timeoutMs} milliseconds.`));
			}, timeoutMs);
			this.pending.set(requestId, { owner: this.ownerValue!, timer, resolve, reject });
			try {
				this.socket.write(encodeSubagentIpcFrame(frame));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(requestId);
				reject(errorFrom(error));
			}
		});
	}

	respond(request: SubagentIpcRequest, result?: unknown, options: SubagentIpcResponseOptions = {}): void {
		this.sendResponse({
			kind: "response",
			token: this.options.token,
			requestId: options.requestId ?? request.requestId,
			owner: options.owner ?? this.ownerValue ?? request.owner,
			ok: true,
			result,
		});
	}

	respondError(request: SubagentIpcRequest, error: unknown): void {
		this.sendResponse({
			kind: "response",
			token: this.options.token,
			requestId: request.requestId,
			owner: this.ownerValue ?? request.owner,
			ok: false,
			error: errorFrom(error).message,
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", () => resolve());
			this.socket.destroy();
		});
	}

	private receive(chunk: Buffer | string): void {
		let values: unknown[];
		try {
			values = this.decoder.push(Buffer.from(chunk));
		} catch (error) {
			this.logger("invalid_frame", { error: errorFrom(error).message });
			this.socket.destroy();
			return;
		}
		for (const value of values) {
			const frame = parseSubagentIpcFrame(value);
			if (!frame) {
				this.logger("invalid_frame", { reason: "schema" });
				continue;
			}
			if (frame.token !== this.options.token) {
				this.logger("unauthenticated_frame_dropped", { requestId: frame.requestId, owner: frame.owner });
				continue;
			}
			if (frame.kind === "response") this.receiveResponse(frame);
			else this.receiveRequest(frame);
		}
	}

	private receiveResponse(frame: SubagentIpcResponse): void {
		const pending = this.pending.get(frame.requestId);
		if (!pending || pending.owner !== frame.owner || frame.owner !== this.ownerValue) {
			this.logger("correlation_mismatch", { requestId: frame.requestId, owner: frame.owner });
			return;
		}
		this.pending.delete(frame.requestId);
		clearTimeout(pending.timer);
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(new Error(frame.error ?? "IPC request failed."));
	}

	private receiveRequest(frame: SubagentIpcRequest): void {
		if (!this.ownerValue) {
			if (frame.type !== "hello") {
				this.logger("owner_not_established", { requestId: frame.requestId, owner: frame.owner });
				return;
			}
			if (this.options.onOwner && !this.options.onOwner(frame.owner, this)) {
				this.logger("duplicate_owner_rejected", { owner: frame.owner });
				this.socket.destroy();
				return;
			}
			this.ownerValue = frame.owner;
		} else if (frame.owner !== this.ownerValue) {
			this.logger("owner_mismatch_dropped", { requestId: frame.requestId, owner: frame.owner });
			return;
		}

		if (frame.type === "hello") {
			this.respond(frame, { accepted: true, owner: this.ownerValue });
			return;
		}
		if (!this.options.onRequest) {
			this.respond(frame, undefined);
			return;
		}
		Promise.resolve(this.options.onRequest(frame, this)).then(
			(result) => this.respond(frame, result),
			(error) => this.respondError(frame, error),
		);
	}

	private sendResponse(response: SubagentIpcResponse): void {
		if (this.closed) return;
		try {
			this.socket.write(encodeSubagentIpcFrame(response));
		} catch (error) {
			this.logger("response_send_failed", { error: errorFrom(error).message });
		}
	}

	private finish(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.disconnectError = error;
		const failure = error ?? new SubagentIpcDisconnectedError();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.pending.clear();
		this.options.onDisconnect?.(this.ownerValue, error);
	}
}

export class SubagentIpcServer {
	readonly socketPath: string;
	readonly token: string;
	private readonly server = net.createServer((socket) => this.accept(socket));
	private readonly connections = new Map<string, SubagentIpcConnection>();
	private listening = false;

	constructor(private readonly options: SubagentIpcServerOptions) {
		this.socketPath = options.socketPath ?? resolveSubagentSocketPath(options.sessionId ?? crypto.randomUUID(), options.agentDir);
		this.token = options.token ?? createSubagentIpcToken();
		if (!boundedString(this.token, MAX_IDENTIFIER_BYTES)) throw new Error("IPC token must be non-empty and at most 128 bytes.");
	}

	async listen(): Promise<void> {
		if (this.listening) return;
		const directory = path.dirname(this.socketPath);
		fs.mkdirSync(directory, { recursive: true, mode: IPC_SOCKET_DIR_MODE });
		fs.chmodSync(directory, IPC_SOCKET_DIR_MODE);
		if (fs.existsSync(this.socketPath)) {
			if (!fs.lstatSync(this.socketPath).isSocket()) throw new Error(`IPC socket path is not a socket: ${this.socketPath}`);
			fs.unlinkSync(this.socketPath);
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				this.server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				this.server.off("error", onError);
				resolve();
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.socketPath);
		});
		fs.chmodSync(this.socketPath, IPC_SOCKET_MODE);
		this.listening = true;
	}

	getConnection(owner: string): SubagentIpcConnection | undefined {
		return this.connections.get(owner);
	}

	async close(): Promise<void> {
		await Promise.all([...this.connections.values()].map((connection) => connection.close()));
		this.connections.clear();
		if (this.listening) {
			await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
			this.listening = false;
		}
		if (fs.existsSync(this.socketPath) && fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
	}

	private accept(socket: net.Socket): void {
		let connection: SubagentIpcConnection;
		connection = new SubagentIpcConnection(socket, {
			...this.options,
			onOwner: (owner) => {
				if (this.connections.has(owner)) return false;
				this.connections.set(owner, connection);
				return true;
			},
			onDisconnect: (owner, error) => {
				if (owner && this.connections.get(owner) === connection) this.connections.delete(owner);
				this.options.onDisconnect?.(owner, error);
			},
		});
	}
}

export class SubagentIpcClient {
	private constructor(private readonly connection: SubagentIpcConnection) {}

	static async connect(options: SubagentIpcClientOptions): Promise<SubagentIpcClient> {
		validateIdentifier(options.owner, "owner");
		const timeoutMs = validateTimeout(options.connectTimeoutMs, "connectTimeoutMs");
		const socket = net.createConnection(options.socketPath);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`IPC connection timed out after ${timeoutMs} milliseconds.`));
			}, timeoutMs);
			const onConnect = () => {
				clearTimeout(timer);
				socket.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				clearTimeout(timer);
				socket.off("connect", onConnect);
				reject(error);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});
		const connection = new SubagentIpcConnection(socket, options);
		try {
			await connection.request("hello", { pid: process.pid }, { timeoutMs });
		} catch (error) {
			await connection.close().catch(() => undefined);
			throw error;
		}
		return new SubagentIpcClient(connection);
	}

	get owner(): string | undefined {
		return this.connection.owner;
	}

	get isClosed(): boolean {
		return this.connection.isClosed;
	}

	request<T = unknown>(type: SubagentIpcMessageType, payload?: unknown, options?: SubagentIpcRequestOptions): Promise<T> {
		return this.connection.request<T>(type, payload, options);
	}

	respond(request: SubagentIpcRequest, result?: unknown, options?: SubagentIpcResponseOptions): void {
		this.connection.respond(request, result, options);
	}

	close(): Promise<void> {
		return this.connection.close();
	}
}
