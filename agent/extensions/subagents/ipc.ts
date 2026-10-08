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

export type SubagentIpcCoreMessageType = "hello" | "ownership" | "browser" | "spawn";
export type SubagentIpcLegacyMessageType = "message" | "question" | "result" | "activity";
// ponytail: Keep legacy IPC types until tasks 4–5 migrate child/launch callers; remove them after RPC integration.
export type SubagentIpcMessageType = SubagentIpcCoreMessageType | SubagentIpcLegacyMessageType;
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
	noDeadline?: boolean;
}

export interface SubagentIpcResponseOptions {
	requestId?: string;
	owner?: string;
}

export interface SubagentIpcConnectionOptions {
	token?: string;
	owner?: string;
	logger?: SubagentIpcLogger;
	onRequest?: (request: SubagentIpcRequest, connection: SubagentIpcConnection) => Promise<unknown> | unknown;
	/** ponytail: Legacy hello metadata remains until task 5 removes the handshake. */
	onHello?: (owner: string, payload: unknown) => void;
	onAuthenticate?: (owner: string, token: string, connection: SubagentIpcConnection) => boolean;
	onDisconnect?: (owner: string | undefined, error?: Error) => void;
}

export interface SubagentIpcServerOptions extends Omit<SubagentIpcConnectionOptions, "token" | "owner" | "onAuthenticate" | "onDisconnect"> {
	socketPath?: string;
	sessionId?: string;
	agentDir?: string;
	onDisconnect?: (owner: string | undefined, error?: Error) => void;
}

export interface SubagentIpcClientOptions extends Omit<SubagentIpcConnectionOptions, "onAuthenticate"> {
	socketPath: string;
	owner: string;
	token: string;
	connectTimeoutMs?: number;
	helloPayload?: unknown;
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

function tokensMatch(expected: string | undefined, actual: string): boolean {
	if (!expected) return false;
	const expectedBytes = Buffer.from(expected, "utf8");
	const actualBytes = Buffer.from(actual, "utf8");
	const comparable = Buffer.alloc(expectedBytes.byteLength);
	actualBytes.copy(comparable, 0, 0, expectedBytes.byteLength);
	const equal = crypto.timingSafeEqual(expectedBytes, comparable);
	return equal && actualBytes.byteLength === expectedBytes.byteLength;
}

function validateIdentifier(value: string, label: string): void {
	if (!boundedString(value, MAX_IDENTIFIER_BYTES) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
	}
}

function isMessageType(value: unknown): value is SubagentIpcMessageType {
	return value === "hello" || value === "ownership" || value === "browser" || value === "message" || value === "question" || value === "result" || value === "spawn" || value === "activity";
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
	timer?: ReturnType<typeof setTimeout>;
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
	private tokenValue: string | undefined;
	private closed = false;
	private revoked = false;
	private disconnectError: Error | undefined;

	constructor(private readonly socket: net.Socket, private readonly options: SubagentIpcConnectionOptions) {
		this.logger = options.logger ?? defaultLogger;
		this.ownerValue = options.owner;
		this.tokenValue = options.token;
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

	revoke(): void {
		if (this.revoked) return;
		this.revoked = true;
		this.socket.destroy();
	}

	async request<T = unknown>(type: SubagentIpcMessageType, payload: unknown = {}, options: SubagentIpcRequestOptions = {}): Promise<T> {
		if (this.closed || this.revoked) throw this.disconnectError ?? new SubagentIpcDisconnectedError();
		if (!isMessageType(type)) throw new Error(`Unsupported IPC message type: ${String(type)}.`);
		if (!this.ownerValue) throw new Error("IPC owner is not established.");
		if (!this.tokenValue) throw new Error("IPC token is not established.");
		const requestId = options.requestId ?? crypto.randomUUID();
		validateIdentifier(requestId, "requestId");
		if (options.noDeadline !== undefined && typeof options.noDeadline !== "boolean") throw new Error("noDeadline must be a boolean.");
		// ponytail: Keep question no-deadline support until task 4 moves ask_question to RPC UI.
		if (options.noDeadline && type !== "spawn" && type !== "question") throw new Error("noDeadline is allowed only for spawn or question requests during RPC migration.");
		if (options.noDeadline && options.timeoutMs !== undefined) throw new Error("noDeadline requests cannot specify timeoutMs.");
		const timeoutMs = options.noDeadline ? undefined : validateTimeout(options.timeoutMs, "timeoutMs");
		const frame: SubagentIpcRequest = { kind: "request", token: this.tokenValue, requestId, owner: this.ownerValue, type, payload };
		return new Promise<T>((resolve, reject) => {
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`IPC request ${requestId} timed out after ${timeoutMs} milliseconds.`));
			}, timeoutMs);
			this.pending.set(requestId, { owner: this.ownerValue!, timer, resolve, reject });
			try {
				this.socket.write(encodeSubagentIpcFrame(frame));
			} catch (error) {
				if (timer) clearTimeout(timer);
				this.pending.delete(requestId);
				reject(errorFrom(error));
			}
		});
	}

	respond(request: SubagentIpcRequest, result?: unknown, options: SubagentIpcResponseOptions = {}): void {
		this.sendResponse({
			kind: "response",
			token: this.tokenValue!,
			requestId: options.requestId ?? request.requestId,
			owner: options.owner ?? this.ownerValue ?? request.owner,
			ok: true,
			result,
		});
	}

	respondError(request: SubagentIpcRequest, error: unknown): void {
		this.sendResponse({
			kind: "response",
			token: this.tokenValue!,
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
		if (this.revoked) return;
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
			if (!this.ownerValue) {
				if (frame.kind !== "request" || frame.type !== "hello") {
					this.logger("authentication_rejected", { reason: "first_frame" });
					this.socket.destroy();
					return;
				}
				let authenticated = false;
				try { authenticated = this.options.onAuthenticate?.(frame.owner, frame.token, this) ?? false; }
				catch { authenticated = false; }
				if (!authenticated) {
					this.logger("authentication_rejected", { reason: "owner_or_token" });
					this.socket.destroy();
					return;
				}
				this.ownerValue = frame.owner;
				this.tokenValue = frame.token;
				try { this.options.onHello?.(frame.owner, frame.payload); }
				catch { this.logger("hello_callback_failed", {}); }
			} else {
				if (frame.token !== this.tokenValue) {
					this.logger("unauthenticated_frame_dropped", {});
					continue;
				}
				if (frame.owner !== this.ownerValue) {
					this.logger("owner_mismatch_dropped", {});
					continue;
				}
			}
			if (frame.kind === "response") this.receiveResponse(frame);
			else this.receiveRequest(frame);
		}
	}

	private receiveResponse(frame: SubagentIpcResponse): void {
		const pending = this.pending.get(frame.requestId);
		if (!pending || pending.owner !== frame.owner || frame.owner !== this.ownerValue) {
			this.logger("correlation_mismatch", {});
			return;
		}
		this.pending.delete(frame.requestId);
		if (pending.timer) clearTimeout(pending.timer);
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(new Error(frame.error ?? "IPC request failed."));
	}

	private receiveRequest(frame: SubagentIpcRequest): void {
		if (frame.owner !== this.ownerValue || frame.token !== this.tokenValue) {
			this.logger("owner_mismatch_dropped", {});
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
		if (this.closed || this.revoked) return;
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
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.pending.clear();
		try { this.options.onDisconnect?.(this.ownerValue, error); }
		catch { this.logger("disconnect_callback_failed", {}); }
	}
}

export class SubagentIpcServer {
	readonly socketPath: string;
	private readonly server = net.createServer((socket) => this.accept(socket));
	private readonly runTokens = new Map<string, string>();
	private readonly connections = new Map<string, SubagentIpcConnection>();
	private readonly sockets = new Set<SubagentIpcConnection>();
	private listening = false;
	private closing = false;
	private listenPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(private readonly options: SubagentIpcServerOptions) {
		this.socketPath = options.socketPath ?? resolveSubagentSocketPath(options.sessionId ?? crypto.randomUUID(), options.agentDir);
	}

	registerRun(owner: string): string {
		validateIdentifier(owner, "owner");
		if (this.closing) throw new Error("Subagent IPC server is closed.");
		if (this.runTokens.has(owner)) throw new Error(`Subagent IPC owner is already registered: ${owner}`);
		const token = createSubagentIpcToken();
		this.runTokens.set(owner, token);
		return token;
	}

	async revokeRun(owner: string, options: { disconnect?: boolean } = {}): Promise<void> {
		this.runTokens.delete(owner);
		if (options.disconnect === false) return;
		const connection = this.connections.get(owner);
		if (!connection) return;
		connection.revoke();
		await connection.close();
	}

	async listen(): Promise<void> {
		if (this.closing && this.closePromise) {
			const closePromise = this.closePromise;
			await closePromise;
			if (this.closePromise === closePromise) {
				this.closing = false;
				this.closePromise = undefined;
			}
		}
		if (this.closing) throw new Error("Subagent IPC server is closed.");
		if (this.listening) return;
		if (this.listenPromise) return this.listenPromise;
		const promise = this.startListening().finally(() => {
			if (this.listenPromise === promise) this.listenPromise = undefined;
		});
		this.listenPromise = promise;
		return promise;
	}

	private async startListening(): Promise<void> {
		try {
			const directory = path.dirname(this.socketPath);
			fs.mkdirSync(directory, { recursive: true, mode: IPC_SOCKET_DIR_MODE });
			fs.chmodSync(directory, IPC_SOCKET_DIR_MODE);
			if (fs.existsSync(this.socketPath)) {
				if (!fs.lstatSync(this.socketPath).isSocket()) throw new Error(`IPC socket path is not a socket: ${this.socketPath}`);
				fs.unlinkSync(this.socketPath);
			}
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					this.server.off("error", onError);
					this.server.off("listening", onListening);
				};
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				this.server.once("error", onError);
				this.server.once("listening", onListening);
				try {
					this.server.listen(this.socketPath);
				} catch (error) {
					cleanup();
					reject(errorFrom(error));
				}
			});
			fs.chmodSync(this.socketPath, IPC_SOCKET_MODE);
			this.listening = true;
		} catch (error) {
			await this.resetAfterListenFailure();
			throw errorFrom(error);
		}
	}

	private async resetAfterListenFailure(): Promise<void> {
		this.listening = false;
		if (this.server.listening) {
			await new Promise<void>((resolve) => this.server.close(() => resolve()));
		}
		if (fs.existsSync(this.socketPath) && fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
	}

	getConnection(owner: string): SubagentIpcConnection | undefined {
		return this.connections.get(owner);
	}

	async closeOwner(owner: string): Promise<void> {
		await this.connections.get(owner)?.close();
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.runTokens.clear();
		this.closePromise = this.finishClose();
		return this.closePromise;
	}

	private async finishClose(): Promise<void> {
		await this.listenPromise?.catch(() => undefined);
		const connections = [...this.sockets];
		for (const connection of connections) connection.revoke();
		await Promise.all(connections.map((connection) => connection.close()));
		this.connections.clear();
		if (this.listening) {
			await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
			this.listening = false;
		}
		if (fs.existsSync(this.socketPath) && fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
	}

	private accept(socket: net.Socket): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		let connection: SubagentIpcConnection;
		connection = new SubagentIpcConnection(socket, {
			...this.options,
			onAuthenticate: (owner, token) => {
				const expectedToken = this.runTokens.get(owner);
				if (this.closing || !expectedToken || this.connections.has(owner) || !tokensMatch(expectedToken, token)) return false;
				this.connections.set(owner, connection);
				return true;
			},
			onDisconnect: (owner, error) => {
				this.sockets.delete(connection);
				if (owner && this.connections.get(owner) === connection) this.connections.delete(owner);
				try { this.options.onDisconnect?.(owner, error); }
				catch { /* Disconnect observers cannot interrupt IPC cleanup. */ }
			},
		});
		this.sockets.add(connection);
	}
}

export class SubagentIpcClient {
	private connection: SubagentIpcConnection | undefined;
	private socket: net.Socket | undefined;
	private connecting: Promise<SubagentIpcConnection> | undefined;
	private closed = false;

	private constructor(private readonly options: SubagentIpcClientOptions) {}

	static create(options: SubagentIpcClientOptions): SubagentIpcClient {
		validateIdentifier(options.owner, "owner");
		if (!boundedString(options.token, MAX_IDENTIFIER_BYTES)) throw new Error("IPC token must be non-empty and at most 128 bytes.");
		validateTimeout(options.connectTimeoutMs, "connectTimeoutMs");
		return new SubagentIpcClient(options);
	}

	// ponytail: Keep eager connect for child.ts until task 4 switches it to create().
	static async connect(options: SubagentIpcClientOptions): Promise<SubagentIpcClient> {
		const client = SubagentIpcClient.create(options);
		await client.ensureConnection();
		return client;
	}

	get owner(): string | undefined {
		return this.options.owner;
	}

	get isClosed(): boolean {
		return this.closed || this.connection?.isClosed === true;
	}

	async request<T = unknown>(type: SubagentIpcMessageType, payload?: unknown, options?: SubagentIpcRequestOptions): Promise<T> {
		const connection = await this.ensureConnection();
		return connection.request<T>(type, payload, options);
	}

	respond(request: SubagentIpcRequest, result?: unknown, options?: SubagentIpcResponseOptions): void {
		if (!this.connection || this.connection.isClosed) throw new SubagentIpcDisconnectedError();
		this.connection.respond(request, result, options);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.connection) await this.connection.close();
		else this.socket?.destroy();
	}

	private ensureConnection(): Promise<SubagentIpcConnection> {
		if (this.closed) return Promise.reject(new SubagentIpcDisconnectedError());
		if (this.connection && !this.connection.isClosed) return Promise.resolve(this.connection);
		if (this.connecting) return this.connecting;
		const connecting = this.openConnection().finally(() => {
			if (this.connecting === connecting) this.connecting = undefined;
		});
		this.connecting = connecting;
		return connecting;
	}

	private async openConnection(): Promise<SubagentIpcConnection> {
		const timeoutMs = validateTimeout(this.options.connectTimeoutMs, "connectTimeoutMs");
		const socket = net.createConnection(this.options.socketPath);
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				socket.off("connect", onConnect);
				socket.off("error", onError);
				socket.off("close", onClose);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onConnect = () => finish();
			const onError = (error: Error) => finish(error);
			const onClose = () => finish(new SubagentIpcDisconnectedError());
			timer = setTimeout(() => {
				finish(new Error(`IPC connection timed out after ${timeoutMs} milliseconds.`));
				socket.destroy();
			}, timeoutMs);
			socket.once("connect", onConnect);
			socket.once("error", onError);
			socket.once("close", onClose);
		});
		if (this.closed) {
			socket.destroy();
			throw new SubagentIpcDisconnectedError();
		}
		const connection = new SubagentIpcConnection(socket, this.options);
		this.connection = connection;
		try {
			await connection.request("hello", this.options.helloPayload ?? { pid: process.pid }, { timeoutMs });
		} catch (error) {
			await connection.close().catch(() => undefined);
			if (this.connection === connection) this.connection = undefined;
			throw error;
		}
		return connection;
	}
}
