import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";

export const BROWSER_STATE_ENTRY = "browser:state";
export const BROWSER_STATUS_KEY = "browser";
export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium";
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
export const MIN_BROWSER_TIMEOUT_MS = 100;
export const MAX_BROWSER_TIMEOUT_MS = 120_000;
export const MAX_BROWSER_URL_LENGTH = 2_048;
export const MAX_BROWSER_EXPRESSION_LENGTH = 10_000;
export const MAX_BROWSER_SELECTOR_LENGTH = 2_048;
export const MAX_BROWSER_FILL_VALUE_LENGTH = 100_000;
export const MAX_BROWSER_BUFFER_ENTRIES = 1_000;
export const DEFAULT_BROWSER_OUTPUT_LIMIT = 100;
export const MAX_BROWSER_OUTPUT_LIMIT = 1_000;
export const MAX_BROWSER_FILTER_LENGTH = 1_000;
export const MAX_BROWSER_HEADER_NAMES = 50;
export const MAX_BROWSER_HEADER_NAME_LENGTH = 100;
export const BROWSER_EVAL_GUIDANCE = "Use a single expression, function source, or IIFE. Wrap top-level return and multiple statements as `(() => { ... })()`.";
export const BROWSER_TOOL_NAMES = [
	"browser_goto",
	"browser_eval",
	"browser_console",
	"browser_network",
	"browser_fill",
	"browser_click",
	"browser_screenshot",
	"browser_close",
	"browser_kill",
] as const;

type BrowserContext = import("playwright-core").BrowserContext;
type BrowserPage = import("playwright-core").Page;
type BrowserConsoleMessage = import("playwright-core").ConsoleMessage;
type BrowserRequest = import("playwright-core").Request;

export const PARENT_BROWSER_OWNER = "parent";
export const MAX_BROWSER_OWNER_KEY_LENGTH = 256;
export const DEFAULT_BROWSER_CONCURRENCY_CAP = 3;
export const MAX_BROWSER_PAGES = DEFAULT_BROWSER_CONCURRENCY_CAP + 1;
export const BROWSER_REQUEST_EVENT = "browser:request";
export const BROWSER_RESULT_EVENT = "browser:result";
export const DEFAULT_BROWSER_CHANNEL_TIMEOUT_MS = 1_500;
export const MAX_BROWSER_CHANNEL_TIMEOUT_MS = 10_000;
export const MAX_BROWSER_REQUEST_ID_LENGTH = 256;
export type BrowserOwner = string;
export type BrowserToolName = typeof BROWSER_TOOL_NAMES[number];
export type BrowserChannelRequest = {
	requestId: string;
	owner: BrowserOwner;
	tool: BrowserToolName;
	params: Record<string, unknown>;
};
export type BrowserChannelResult = {
	requestId: string;
	owner?: BrowserOwner;
	ok: boolean;
	result?: unknown;
	error?: string;
};
export type BrowserEventBus = {
	on: (event: string, handler: (data: unknown) => void) => void;
	off?: (event: string, handler: (data: unknown) => void) => void;
	emit: (event: string, data: unknown) => void;
};

export class RingBuffer<T> {
	private readonly values: Array<T | undefined>;
	private start = 0;
	private size = 0;

	constructor(readonly capacity = MAX_BROWSER_BUFFER_ENTRIES) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("ring buffer capacity must be a positive integer");
		this.values = new Array<T | undefined>(capacity);
	}

	get length(): number {
		return this.size;
	}

	push(value: T): void {
		const index = (this.start + this.size) % this.capacity;
		this.values[index] = value;
		if (this.size < this.capacity) this.size += 1;
		else this.start = (this.start + 1) % this.capacity;
	}

	peek(): T[] {
		const output = new Array<T>(this.size);
		for (let index = 0; index < this.size; index += 1) output[index] = this.values[(this.start + index) % this.capacity] as T;
		return output;
	}

	drain(): T[] {
		const output = this.peek();
		this.values.fill(undefined);
		this.start = 0;
		this.size = 0;
		return output;
	}
}

export type ConsoleEntry = {
	ts: number;
	type: string;
	text: string;
	location?: string;
};

export type NetworkEntry = {
	ts: number;
	method: string;
	url: string;
	status?: number;
	statusText?: string;
	resourceType: string;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
	failure?: string;
};

export const KEEP_HEADERS = new Set([
	"authorization",
	"apikey",
	"content-type",
	"x-client-info",
	"accept-profile",
	"content-profile",
	"prefer",
	"location",
	"www-authenticate",
	"retry-after",
]);

type BrowserStateEntry = {
	enabled?: unknown;
};

type CustomEntry = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

export type BrowserPageState = {
	page: BrowserPage;
	consoleBuffer: RingBuffer<ConsoleEntry>;
	networkBuffer: RingBuffer<NetworkEntry>;
};
type BrowserPageEntry = BrowserPageState | Promise<BrowserPageState>;

export function createBrowserPageState(page: BrowserPage): BrowserPageState {
	return {
		page,
		consoleBuffer: new RingBuffer<ConsoleEntry>(),
		networkBuffer: new RingBuffer<NetworkEntry>(),
	};
}

export class BrowserPageRegistry {
	private readonly entries = new Map<BrowserOwner, BrowserPageEntry>();

	constructor(readonly capacity = MAX_BROWSER_PAGES) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("browser page capacity must be a positive integer");
	}

	get size(): number {
		return this.entries.size;
	}

	get(owner: BrowserOwner): BrowserPageEntry | undefined {
		return this.entries.get(owner);
	}

	set(owner: BrowserOwner, entry: BrowserPageEntry): void {
		if (!this.entries.has(owner) && this.entries.size >= this.capacity) throw new Error(`Browser page cap reached (${this.capacity} pages maximum).`);
		this.entries.set(owner, entry);
	}

	delete(owner: BrowserOwner): void {
		this.entries.delete(owner);
	}

	clear(): void {
		this.entries.clear();
	}

	async close(owner: BrowserOwner): Promise<void> {
		const entry = this.entries.get(owner);
		if (!entry) return;
		this.entries.delete(owner);
		let state: BrowserPageState;
		try {
			state = await entry;
		} catch {
			return;
		}
		await state.page.close();
	}
}

let browserEnabled = false;
let browserContext: BrowserContext | undefined;
let browserPages: BrowserPageRegistry | undefined;
let launchPromise: Promise<BrowserContext> | undefined;

function pageEntries(): BrowserPageRegistry {
	return browserPages ??= new BrowserPageRegistry();
}

export function validateBrowserOwner(owner: unknown): BrowserOwner {
	if (typeof owner !== "string" || owner.trim().length === 0) throw new Error("owner must be a non-empty string");
	const normalized = owner.trim();
	if (normalized.length > MAX_BROWSER_OWNER_KEY_LENGTH) throw new Error(`owner must be at most ${MAX_BROWSER_OWNER_KEY_LENGTH} characters`);
	if (normalized.includes("\0")) throw new Error("owner must not contain null bytes");
	return normalized;
}

export function validateBrowserRequestId(requestId: unknown): string {
	if (typeof requestId !== "string" || requestId.trim().length === 0) throw new Error("requestId must be a non-empty string");
	const normalized = requestId.trim();
	if (normalized.length > MAX_BROWSER_REQUEST_ID_LENGTH) throw new Error(`requestId must be at most ${MAX_BROWSER_REQUEST_ID_LENGTH} characters`);
	if (normalized.includes("\0")) throw new Error("requestId must not contain null bytes");
	return normalized;
}

export function validateBrowserChannelTimeout(timeout: unknown): number {
	if (timeout === undefined) return DEFAULT_BROWSER_CHANNEL_TIMEOUT_MS;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_BROWSER_CHANNEL_TIMEOUT_MS) {
		throw new Error(`channel timeout must be an integer from 1 to ${MAX_BROWSER_CHANNEL_TIMEOUT_MS} milliseconds`);
	}
	return timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBrowserChannelRequest(value: unknown): BrowserChannelRequest {
	if (!isRecord(value)) throw new Error("browser request must be an object");
	const requestId = validateBrowserRequestId(value.requestId);
	const owner = validateBrowserOwner(value.owner);
	if (typeof value.tool !== "string" || !BROWSER_TOOL_NAMES.includes(value.tool as BrowserToolName)) throw new Error("browser request tool is unknown");
	if (value.params !== undefined && !isRecord(value.params)) throw new Error("browser request params must be an object");
	return {
		requestId,
		owner,
		tool: value.tool as BrowserToolName,
		params: (value.params ?? {}) as Record<string, unknown>,
	};
}

export function requestBrowserTool(events: BrowserEventBus, value: unknown, timeout?: unknown): Promise<BrowserChannelResult> {
	const request = parseBrowserChannelRequest(value);
	const waitMs = validateBrowserChannelTimeout(timeout);
	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const onResult = (value: unknown) => {
			if (!isRecord(value) || value.requestId !== request.requestId) return;
			if (value.owner !== undefined && value.owner !== request.owner) return;
			if (value.ok === true && value.owner !== request.owner) return;
			if (value.ok !== true && value.ok !== false) {
				finish(() => reject(new Error("Malformed browser result: ok must be boolean.")));
				return;
			}
			if (value.ok === false && typeof value.error !== "string") {
				finish(() => reject(new Error("Malformed browser result: error is required.")));
				return;
			}
			finish(() => resolve({
				requestId: request.requestId,
				...(typeof value.owner === "string" ? { owner: value.owner } : {}),
				ok: value.ok as boolean,
				...(value.ok === true ? { result: value.result } : { error: value.error as string }),
			}));
		};
		const finish = (action: () => void) => {
			if (timer) clearTimeout(timer);
			events.off?.(BROWSER_RESULT_EVENT, onResult);
			action();
		};
		timer = setTimeout(() => finish(() => reject(new Error(`browser request ${request.requestId} timed out after ${waitMs} milliseconds.`))), waitMs);
		events.on(BROWSER_RESULT_EVENT, onResult);
		try {
			events.emit(BROWSER_REQUEST_EVENT, request);
		} catch (error) {
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
	});
}

export function resolveBrowserProfilePath(agentDir = getAgentDir(), env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_BROWSER_PROFILE?.trim();
	return configured ? resolve(configured) : join(agentDir, "extensions", "browser", ".profile");
}

export function isBrowserHeadful(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["1", "true", "yes", "on"].includes(env.PI_BROWSER_HEADFUL?.trim().toLowerCase() ?? "");
}

export function formatBrowserLaunchError(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Could not launch Chromium: ${detail}. Install it with ${BROWSER_INSTALL_COMMAND}.`;
}

export function resolveBrowserEnabled(branch: readonly unknown[]): boolean {
	let enabled = false;
	for (const rawEntry of branch) {
		const entry = rawEntry as CustomEntry;
		if (entry.type !== "custom" || entry.customType !== BROWSER_STATE_ENTRY) continue;
		const data = entry.data as BrowserStateEntry | undefined;
		if (typeof data?.enabled === "boolean") enabled = data.enabled;
	}
	return enabled;
}

export function browserStatus(enabled: boolean): string {
	return `Browser: ${enabled ? "ON" : "OFF"}`;
}

export function validateBrowserOutputLimit(limit: unknown): number {
	if (limit === undefined) return DEFAULT_BROWSER_OUTPUT_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BROWSER_OUTPUT_LIMIT) {
		throw new Error(`limit must be an integer from 1 to ${MAX_BROWSER_OUTPUT_LIMIT}`);
	}
	return limit;
}

export function validateBrowserFilter(filter: unknown, name: string): string | undefined {
	if (filter === undefined) return undefined;
	if (typeof filter !== "string" || filter.length > MAX_BROWSER_FILTER_LENGTH) throw new Error(`${name} must be at most ${MAX_BROWSER_FILTER_LENGTH} characters`);
	if (filter.includes("\0")) throw new Error(`${name} must not contain null bytes`);
	return filter;
}

export function normalizeHeaderNames(includeHeaders: unknown): string[] {
	if (includeHeaders === undefined) return [];
	if (!Array.isArray(includeHeaders) || includeHeaders.length > MAX_BROWSER_HEADER_NAMES) {
		throw new Error(`includeHeaders must contain at most ${MAX_BROWSER_HEADER_NAMES} names`);
	}
	return includeHeaders.map((header, index) => {
		if (typeof header !== "string" || header.trim().length === 0 || header.length > MAX_BROWSER_HEADER_NAME_LENGTH || header.includes("\0")) {
			throw new Error(`includeHeaders[${index}] must be a non-empty header name of at most ${MAX_BROWSER_HEADER_NAME_LENGTH} characters`);
		}
		return header.trim().toLowerCase();
	});
}

export function headersToShow(includeHeaders: unknown, verbose: unknown): Set<string> {
	const extra = normalizeHeaderNames(includeHeaders);
	return new Set([...(verbose === true ? KEEP_HEADERS : []), ...extra]);
}

export function filterHeaders(headers: Record<string, string> | undefined, allow: ReadonlySet<string>): Record<string, string> {
	if (!headers || allow.size === 0) return {};
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) if (allow.has(key.toLowerCase())) output[key] = value;
	return output;
}

export function validateBrowserStatus(status: unknown): number | undefined {
	if (status === undefined) return undefined;
	if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new Error("status must be an HTTP integer from 100 to 599");
	return status;
}

export function validateBrowserTimeout(timeout: unknown): number {
	if (timeout === undefined) return DEFAULT_BROWSER_TIMEOUT_MS;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < MIN_BROWSER_TIMEOUT_MS || timeout > MAX_BROWSER_TIMEOUT_MS) {
		throw new Error(`timeout must be an integer from ${MIN_BROWSER_TIMEOUT_MS} to ${MAX_BROWSER_TIMEOUT_MS} milliseconds`);
	}
	return timeout;
}

export function validateBrowserSelector(selector: unknown): string {
	if (typeof selector !== "string" || selector.trim().length === 0) throw new Error("selector must not be empty");
	if (selector.length > MAX_BROWSER_SELECTOR_LENGTH) throw new Error(`selector must be at most ${MAX_BROWSER_SELECTOR_LENGTH} characters`);
	if (selector.includes("\0")) throw new Error("selector must not contain null bytes");
	return selector;
}

export function validateBrowserFillValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("value must be a string");
	if (value.length > MAX_BROWSER_FILL_VALUE_LENGTH) throw new Error(`value must be at most ${MAX_BROWSER_FILL_VALUE_LENGTH} characters`);
	if (value.includes("\0")) throw new Error("value must not contain null bytes");
	return value;
}

export type BrowserSelectorKind = "css" | "text" | "role";
export type BrowserSelector = { kind: BrowserSelectorKind; value: string };

export function parseBrowserSelector(selector: unknown): BrowserSelector {
	const source = validateBrowserSelector(selector);
	if (source.startsWith("text=")) {
		const value = source.slice("text=".length).trim();
		if (!value) throw new Error("text selector must not be empty");
		return { kind: "text", value };
	}
	if (source.startsWith("role=")) {
		const value = source.slice("role=".length).trim();
		if (!value) throw new Error("role selector must not be empty");
		return { kind: "role", value };
	}
	return { kind: "css", value: source };
}

export type BrowserLocator = Pick<import("playwright-core").Locator, "click" | "fill">;
export type BrowserSelectorPage = {
	locator: (selector: string) => BrowserLocator;
	getByText: (text: string) => BrowserLocator;
};

export function locateBrowserSelector(page: BrowserSelectorPage, selector: unknown): BrowserLocator {
	const parsed = parseBrowserSelector(selector);
	if (parsed.kind === "text") return page.getByText(parsed.value);
	if (parsed.kind === "role") return page.locator(`role=${parsed.value}`);
	return page.locator(parsed.value);
}

export function buildBrowserScreenshotPath(directory: string): string {
	return join(directory, "screenshot.png");
}

export function validateBrowserUrl(url: unknown): string {
	if (typeof url !== "string" || url.trim().length === 0) throw new Error("url must not be empty");
	if (url.length > MAX_BROWSER_URL_LENGTH) throw new Error(`url must be at most ${MAX_BROWSER_URL_LENGTH} characters`);
	if (url.includes("\0")) throw new Error("url must not contain null bytes");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("url must be a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url must use http or https");
	return parsed.href;
}

function stripOuterParens(source: string): string {
	return source.startsWith("(") && source.endsWith(")") ? source.slice(1, -1).trim() : source;
}

function isFunctionSource(source: string): boolean {
	const candidate = stripOuterParens(source);
	return /^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/.test(candidate)
		|| /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(candidate);
}

function isIifeSource(source: string): boolean {
	return /^\s*\(/.test(source) && /\)\s*\(\s*\)\s*$/.test(source)
		&& (source.includes("=>") || /\(\s*(?:async\s+)?function\b/.test(source));
}

export type BrowserEvalKind = "expression" | "function" | "iife";

export function classifyBrowserEval(expression: unknown): BrowserEvalKind {
	if (typeof expression !== "string" || expression.trim().length === 0) throw new Error("expression must not be empty");
	if (expression.length > MAX_BROWSER_EXPRESSION_LENGTH) throw new Error(`expression must be at most ${MAX_BROWSER_EXPRESSION_LENGTH} characters`);
	const source = expression.trim();
	try {
		// Parse only. Never invoke untrusted source in Node; execution happens in page context.
		new Function(`return (${source});`);
	} catch {
		throw new Error(BROWSER_EVAL_GUIDANCE);
	}
	if (isIifeSource(source)) return "iife";
	if (isFunctionSource(source)) return "function";
	return "expression";
}

export function serializeBrowserEvalResult(value: unknown): unknown {
	const seen = new WeakSet<object>();
	function visit(candidate: unknown): unknown {
		if (candidate === undefined || typeof candidate === "function" || typeof candidate === "symbol") return null;
		if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
		if (typeof candidate === "bigint") return String(candidate);
		if (candidate === null || typeof candidate !== "object") return candidate;
		const node = candidate as { nodeType?: unknown; nodeName?: unknown };
		if ((typeof Node !== "undefined" && candidate instanceof Node) || (typeof node.nodeType === "number" && typeof node.nodeName === "string")) return "ref: <Node>";
		if (seen.has(candidate)) return "[Circular]";
		seen.add(candidate);
		if (Array.isArray(candidate)) return candidate.map(visit);
		const output: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(candidate)) {
			try {
				output[key] = visit(nested);
			} catch {
				output[key] = null;
			}
		}
		return output;
	}
	return visit(value);
}

export async function runBrowserOperation<T>(owner: BrowserOwner, label: string, timeout: number, operation: () => Promise<T>, signal?: AbortSignal, reap?: () => Promise<void>): Promise<T> {
	const ownerKey = validateBrowserOwner(owner);
	const reapPage = reap ?? (() => closeBrowser(ownerKey));
	let timer: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) {
		await reapPage().catch(() => undefined);
		throw new Error(`${label} aborted`);
	}
	try {
		const cancellation = signal
			? new Promise<T>((_, reject) => {
				abortHandler = () => {
					aborted = true;
					reject(new Error("browser-operation-aborted"));
				};
				signal.addEventListener("abort", abortHandler, { once: true });
			})
			: undefined;
		const result = await Promise.race([
			operation(),
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("browser-operation-timeout"));
				}, timeout);
			}),
			...(cancellation ? [cancellation] : []),
		]);
		return result;
	} catch (error) {
		if (timedOut) {
			await reapPage().catch(() => undefined);
			throw new Error(`${label} timed out after ${timeout} milliseconds`);
		}
		if (aborted) {
			await reapPage().catch(() => undefined);
			throw new Error(`${label} aborted`);
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} failed: ${detail}`);
	} finally {
		if (timer) clearTimeout(timer);
		if (abortHandler) signal?.removeEventListener("abort", abortHandler);
	}
}

export const BROWSER_SERIALIZER_SOURCE = `function serialize(value) {
	const seen = new WeakSet();
	function visit(candidate) {
		if (candidate === undefined || typeof candidate === "function" || typeof candidate === "symbol") return null;
		if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
		if (typeof candidate === "bigint") return String(candidate);
		if (candidate === null || typeof candidate !== "object") return candidate;
		const node = candidate;
		if ((typeof Node !== "undefined" && candidate instanceof Node) || (typeof node.nodeType === "number" && typeof node.nodeName === "string")) return "ref: <Node>";
		if (seen.has(candidate)) return "[Circular]";
		seen.add(candidate);
		if (Array.isArray(candidate)) return candidate.map(visit);
		const output = {};
		for (const [key, nested] of Object.entries(candidate)) {
			try { output[key] = visit(nested); } catch { output[key] = null; }
		}
		return output;
	}
	return visit(value);
}`;

export function buildBrowserEvalScript(expression: unknown): string {
	const kind = classifyBrowserEval(expression);
	const source = (expression as string).trim();
	const evaluated = kind === "expression" ? `(${source})` : kind === "function" ? `(${source})()` : source;
	return `(async () => { const serialize = (${BROWSER_SERIALIZER_SOURCE}); const value = await ${evaluated}; return serialize(value); })()`;
}

type BrowserGotoInput = { url: string; timeout?: number };
type BrowserEvalInput = { expression: string; timeout?: number };

async function browserGotoTool(_toolCallId: string, params: BrowserGotoInput, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const url = validateBrowserUrl(params.url);
	const timeout = validateBrowserTimeout(params.timeout);
	const result = await runBrowserOperation(owner, "browser_goto", timeout, async () => {
		const page = await ensureBrowserPage(owner);
		const response = await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
		return { status: response?.status() ?? 0, finalUrl: page.url() };
	}, signal);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
	};
}

async function browserEvalTool(_toolCallId: string, params: BrowserEvalInput, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const timeout = validateBrowserTimeout(params.timeout);
	const script = buildBrowserEvalScript(params.expression);
	const result = await runBrowserOperation(owner, "browser_eval", timeout, async () => {
		const page = await ensureBrowserPage(owner);
		return page.evaluate(script);
	}, signal);
	const serialized = serializeBrowserEvalResult(result);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
		details: { result: serialized },
	};
}

type BrowserConsoleInput = { limit?: number; filter?: string; clear?: boolean };
type BrowserNetworkInput = { limit?: number; urlFilter?: string; status?: number; verbose?: boolean; includeHeaders?: string[]; clear?: boolean };
type BrowserClickInput = { selector: string; timeout?: number };
type BrowserFillInput = { selector: string; value: string; timeout?: number };
type BrowserScreenshotInput = { fullPage?: boolean; timeout?: number };

function validateOptionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function pageState(owner: BrowserOwner): BrowserPageState | undefined {
	const entry = browserPages?.get(owner);
	if (!entry || entry instanceof Promise) return undefined;
	if (entry.page.isClosed()) {
		if (browserPages?.get(owner) === entry) browserPages.delete(owner);
		return undefined;
	}
	return entry;
}

async function browserConsoleTool(_toolCallId: string, params: BrowserConsoleInput, _signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const limit = validateBrowserOutputLimit(params.limit);
	const filter = validateBrowserFilter(params.filter, "filter");
	const clear = validateOptionalBoolean(params.clear, "clear") ?? true;
	const state = pageState(validateBrowserOwner(owner));
	const entries = clear ? state?.consoleBuffer.drain() ?? [] : state?.consoleBuffer.peek() ?? [];
	const filtered = filter ? entries.filter((entry) => entry.text.includes(filter) || (entry.location ?? "").includes(filter)) : entries;
	const output = filtered.slice(-limit);
	const text = output.map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.type}: ${entry.text}${entry.location ? `  @ ${entry.location}` : ""}`).join("\n") || "(empty)";
	return { content: [{ type: "text" as const, text }], details: { entries: output } };
}

async function browserNetworkTool(_toolCallId: string, params: BrowserNetworkInput, _signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const limit = validateBrowserOutputLimit(params.limit);
	const urlFilter = validateBrowserFilter(params.urlFilter, "urlFilter");
	const status = validateBrowserStatus(params.status);
	const verbose = validateOptionalBoolean(params.verbose, "verbose") ?? false;
	const clear = validateOptionalBoolean(params.clear, "clear") ?? true;
	const extraHeaders = normalizeHeaderNames(params.includeHeaders);
	const state = pageState(validateBrowserOwner(owner));
	const entries = clear ? state?.networkBuffer.drain() ?? [] : state?.networkBuffer.peek() ?? [];
	const filtered = entries.filter((entry) => (!urlFilter || entry.url.includes(urlFilter)) && (status === undefined || entry.status === status));
	const output = filtered.slice(-limit);
	const allow = headersToShow(extraHeaders, verbose);
	const lines: string[] = [];
	for (const entry of output) {
		lines.push(`${entry.status ?? "ERR"} ${entry.method} ${entry.url}${entry.failure ? `  (${entry.failure})` : ""}`);
		if (allow.size > 0) {
			for (const [key, value] of Object.entries(filterHeaders(entry.requestHeaders, allow))) lines.push(`  → ${key}: ${value}`);
			for (const [key, value] of Object.entries(filterHeaders(entry.responseHeaders, allow))) lines.push(`  ← ${key}: ${value}`);
		}
	}
	return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty)" }], details: { entries: output } };
}

async function browserClickTool(_toolCallId: string, params: BrowserClickInput, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const selector = validateBrowserSelector(params.selector);
	const timeout = validateBrowserTimeout(params.timeout);
	await runBrowserOperation(owner, "browser_click", timeout, async () => {
		const page = await ensureBrowserPage(owner);
		await locateBrowserSelector(page, selector).click({ timeout });
	}, signal);
	return { content: [{ type: "text" as const, text: `Clicked ${selector}.` }], details: { selector } };
}

async function browserFillTool(_toolCallId: string, params: BrowserFillInput, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const selector = validateBrowserSelector(params.selector);
	const value = validateBrowserFillValue(params.value);
	const timeout = validateBrowserTimeout(params.timeout);
	await runBrowserOperation(owner, "browser_fill", timeout, async () => {
		const page = await ensureBrowserPage(owner);
		await locateBrowserSelector(page, selector).fill(value, { timeout });
	}, signal);
	return { content: [{ type: "text" as const, text: `Filled ${selector}.` }], details: { selector } };
}

async function browserScreenshotTool(_toolCallId: string, params: BrowserScreenshotInput, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	const timeout = validateBrowserTimeout(params.timeout);
	const fullPage = validateOptionalBoolean(params.fullPage, "fullPage") ?? false;
	const path = await runBrowserOperation(owner, "browser_screenshot", timeout, async () => {
		const page = await ensureBrowserPage(owner);
		const directory = await mkdtemp(join(tmpdir(), "pi-browser-"));
		const screenshotPath = buildBrowserScreenshotPath(directory);
		await page.screenshot({ path: screenshotPath, fullPage, type: "png" });
		return screenshotPath;
	}, signal);
	return { content: [{ type: "text" as const, text: path }], details: { path } };
}

const BROWSER_GOTO_PARAMETERS = Type.Object({
	url: Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

const BROWSER_EVAL_PARAMETERS = Type.Object({
	expression: Type.String({ minLength: 1, maxLength: MAX_BROWSER_EXPRESSION_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

const BROWSER_CONSOLE_PARAMETERS = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BROWSER_OUTPUT_LIMIT })),
	filter: Type.Optional(Type.String({ maxLength: MAX_BROWSER_FILTER_LENGTH })),
	clear: Type.Optional(Type.Boolean()),
});

const BROWSER_NETWORK_PARAMETERS = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BROWSER_OUTPUT_LIMIT })),
	urlFilter: Type.Optional(Type.String({ maxLength: MAX_BROWSER_FILTER_LENGTH })),
	status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
	verbose: Type.Optional(Type.Boolean()),
	includeHeaders: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_BROWSER_HEADER_NAME_LENGTH }), { maxItems: MAX_BROWSER_HEADER_NAMES })),
	clear: Type.Optional(Type.Boolean()),
});

const BROWSER_SELECTOR_PARAMETERS = Type.Object({
	selector: Type.String({ minLength: 1, maxLength: MAX_BROWSER_SELECTOR_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

const BROWSER_FILL_PARAMETERS = Type.Object({
	selector: Type.String({ minLength: 1, maxLength: MAX_BROWSER_SELECTOR_LENGTH }),
	value: Type.String({ maxLength: MAX_BROWSER_FILL_VALUE_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

const BROWSER_SCREENSHOT_PARAMETERS = Type.Object({
	fullPage: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

function attachBrowserListeners(state: BrowserPageState): void {
	const { page, consoleBuffer, networkBuffer } = state;
	page.on("console", (message: BrowserConsoleMessage) => {
		const location = message.location();
		consoleBuffer.push({
			ts: Date.now(),
			type: message.type(),
			text: message.text(),
			...(location.url ? { location: `${location.url}:${location.lineNumber}` } : {}),
		});
	});
	page.on("pageerror", (error) => {
		consoleBuffer.push({ ts: Date.now(), type: "pageerror", text: `${error.name}: ${error.message}` });
	});
	page.on("requestfinished", (request: BrowserRequest) => {
		void captureNetworkRequest(request, networkBuffer);
	});
	page.on("requestfailed", (request: BrowserRequest) => {
		const failure = request.failure()?.errorText;
		networkBuffer.push({
			ts: Date.now(),
			method: request.method(),
			url: request.url(),
			resourceType: request.resourceType(),
			...(failure ? { failure } : {}),
		});
	});
}

async function captureNetworkRequest(request: BrowserRequest, networkBuffer: RingBuffer<NetworkEntry>): Promise<void> {
	try {
		const response = await request.response();
		networkBuffer.push({
			ts: Date.now(),
			method: request.method(),
			url: request.url(),
			status: response?.status(),
			statusText: response?.statusText(),
			resourceType: request.resourceType(),
			requestHeaders: await request.allHeaders(),
			...(response ? { responseHeaders: await response.allHeaders() } : {}),
		});
	} catch {
		// Request may have been aborted while headers were being collected.
	}
}

async function launchBrowser(): Promise<BrowserContext> {
	const profileDir = resolveBrowserProfilePath();
	await mkdir(profileDir, { recursive: true });
	let context: BrowserContext | undefined;
	try {
		const { chromium } = await import("playwright-core");
		context = await chromium.launchPersistentContext(profileDir, { headless: !isBrowserHeadful() });
		browserContext = context;
		return context;
	} catch (error) {
		await context?.close().catch(() => undefined);
		throw new Error(formatBrowserLaunchError(error));
	}
}

async function ensureBrowserContext(): Promise<BrowserContext> {
	if (browserContext) return browserContext;
	if (!launchPromise) {
		launchPromise = launchBrowser().finally(() => {
			launchPromise = undefined;
		});
	}
	return launchPromise;
}

export async function ensureBrowserPage(owner = PARENT_BROWSER_OWNER): Promise<BrowserPage> {
	if (!browserEnabled) throw new Error("Browser gate is off. Run /browser on first.");
	const ownerKey = validateBrowserOwner(owner);
	const pages = pageEntries();
	const existing = pages.get(ownerKey);
	if (existing) {
		const state = await existing;
		if (!state.page.isClosed()) return state.page;
		if (pages.get(ownerKey) === existing) pages.delete(ownerKey);
	}
	const context = await ensureBrowserContext();
	if (browserContext !== context) throw new Error("Browser context closed while opening page.");
	const current = pages.get(ownerKey);
	if (current) {
		const state = await current;
		if (!state.page.isClosed()) return state.page;
		if (pages.get(ownerKey) === current) pages.delete(ownerKey);
	}
	if (pages.size >= pages.capacity) throw new Error(`Browser page cap reached (${pages.capacity} pages maximum).`);
	let pending!: Promise<BrowserPageState>;
	pending = (async () => {
		const page = await context.newPage();
		const state = createBrowserPageState(page);
		if (browserPages !== pages || browserContext !== context || pages.get(ownerKey) !== pending) {
			await page.close().catch(() => undefined);
			throw new Error("Browser page reaped while opening.");
		}
		attachBrowserListeners(state);
		pages.set(ownerKey, state);
		return state;
	})().catch((error) => {
		if (browserPages === pages && pages.get(ownerKey) === pending) pages.delete(ownerKey);
		throw error;
	});
	pages.set(ownerKey, pending);
	return (await pending).page;
}

async function closeBrowserPage(owner: BrowserOwner): Promise<void> {
	const pages = browserPages;
	if (!pages) return;
	try {
		await pages.close(owner);
	} catch (error) {
		throw new Error(`Could not close browser page for ${owner}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function closeBrowserContext(): Promise<void> {
	const pending = launchPromise;
	if (pending) await pending.catch(() => undefined);
	const context = browserContext;
	browserContext = undefined;
	browserPages = undefined;
	if (!context) return;
	try {
		await context.close();
	} catch (error) {
		await context.browser()?.close().catch(() => undefined);
		throw new Error(`Could not close Chromium: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function closeBrowser(owner?: BrowserOwner): Promise<void> {
	if (owner === undefined) return closeBrowserContext();
	return closeBrowserPage(validateBrowserOwner(owner));
}

async function closeBrowserTool(_toolCallId?: string, _params?: unknown, _signal?: AbortSignal, _onUpdate?: unknown, _ctx?: unknown, owner = PARENT_BROWSER_OWNER) {
	await closeBrowser(owner);
	return { content: [{ type: "text" as const, text: "Browser page closed." }], details: { closed: true, owner } };
}

function optionalChannelRequestId(value: unknown): string | undefined {
	if (!isRecord(value) || value.requestId === undefined) return undefined;
	try {
		return validateBrowserRequestId(value.requestId);
	} catch {
		return undefined;
	}
}

function optionalChannelOwner(value: unknown): BrowserOwner | undefined {
	if (!isRecord(value) || value.owner === undefined) return undefined;
	try {
		return validateBrowserOwner(value.owner);
	} catch {
		return undefined;
	}
}

function emitBrowserChannelError(pi: ExtensionAPI, requestId: string, error: string, owner?: BrowserOwner): void {
	pi.events.emit(BROWSER_RESULT_EVENT, { requestId, ...(owner ? { owner } : {}), ok: false, error });
}

async function executeBrowserChannelRequest(request: BrowserChannelRequest): Promise<unknown> {
	const params = request.params;
	switch (request.tool) {
		case "browser_goto": return browserGotoTool(request.requestId, params as BrowserGotoInput, undefined, undefined, undefined, request.owner);
		case "browser_eval": return browserEvalTool(request.requestId, params as BrowserEvalInput, undefined, undefined, undefined, request.owner);
		case "browser_console": return browserConsoleTool(request.requestId, params as BrowserConsoleInput, undefined, undefined, undefined, request.owner);
		case "browser_network": return browserNetworkTool(request.requestId, params as BrowserNetworkInput, undefined, undefined, undefined, request.owner);
		case "browser_fill": return browserFillTool(request.requestId, params as BrowserFillInput, undefined, undefined, undefined, request.owner);
		case "browser_click": return browserClickTool(request.requestId, params as BrowserClickInput, undefined, undefined, undefined, request.owner);
		case "browser_screenshot": return browserScreenshotTool(request.requestId, params as BrowserScreenshotInput, undefined, undefined, undefined, request.owner);
		case "browser_close": return closeBrowserTool(request.requestId, params, undefined, undefined, undefined, request.owner);
		case "browser_kill": return closeBrowserTool(request.requestId, params, undefined, undefined, undefined, request.owner);
	}
}

async function handleBrowserChannelRequest(pi: ExtensionAPI, value: unknown): Promise<void> {
	let request: BrowserChannelRequest;
	try {
		request = parseBrowserChannelRequest(value);
	} catch (error) {
		const requestId = optionalChannelRequestId(value);
		if (requestId) emitBrowserChannelError(pi, requestId, `Malformed browser request: ${error instanceof Error ? error.message : String(error)}`, optionalChannelOwner(value));
		return;
	}
	if (!browserEnabled) {
		emitBrowserChannelError(pi, request.requestId, "Browser gate is off. Run /browser on first.", request.owner);
		return;
	}
	try {
		const result = await executeBrowserChannelRequest(request);
		pi.events.emit(BROWSER_RESULT_EVENT, { requestId: request.requestId, owner: request.owner, ok: true, result });
	} catch (error) {
		emitBrowserChannelError(pi, request.requestId, error instanceof Error ? error.message : String(error), request.owner);
	}
}

function syncBrowserTools(pi: ExtensionAPI): void {
	const registered = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = pi.getActiveTools().filter((name) => !BROWSER_TOOL_NAMES.includes(name as typeof BROWSER_TOOL_NAMES[number]));
	if (browserEnabled) active.push(...BROWSER_TOOL_NAMES.filter((name) => registered.has(name)));
	pi.setActiveTools([...new Set(active)]);
}

function updateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(BROWSER_STATUS_KEY, browserStatus(browserEnabled));
}

function showStatus(ctx: ExtensionContext): void {
	const status = browserStatus(browserEnabled);
	if (ctx.hasUI) ctx.ui.notify(status, "info");
	else console.log(status);
}

async function reconstructFromBranch(ctx: ExtensionContext): Promise<void> {
	const enabled = resolveBrowserEnabled(ctx.sessionManager.getBranch());
	if (!enabled) await closeBrowser();
	browserEnabled = enabled;
	updateStatus(ctx);
}

async function setBrowserEnabled(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): Promise<void> {
	let closeError: unknown;
	if (!enabled) {
		try {
			await closeBrowser();
		} catch (error) {
			closeError = error;
		}
	}
	await Promise.resolve(pi.appendEntry(BROWSER_STATE_ENTRY, { enabled, at: Date.now() }));
	browserEnabled = enabled;
	syncBrowserTools(pi);
	updateStatus(ctx);
	showStatus(ctx);
	if (closeError) throw closeError;
}

export default function browserExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "browser_goto",
		label: "Browser Goto",
		description: "Navigate the session browser to an HTTP or HTTPS URL and return status and final URL.",
		parameters: BROWSER_GOTO_PARAMETERS,
		execute: browserGotoTool,
	});

	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description: "Evaluate a bounded expression, function source, or IIFE in the current browser page.",
		parameters: BROWSER_EVAL_PARAMETERS,
		execute: browserEvalTool,
	});

	pi.registerTool({
		name: "browser_console",
		label: "Browser Console",
		description: "Read buffered console and page-error entries. Reads drain the full buffer by default; clear=false peeks.",
		parameters: BROWSER_CONSOLE_PARAMETERS,
		execute: browserConsoleTool,
	});

	pi.registerTool({
		name: "browser_network",
		label: "Browser Network",
		description: "Read buffered network requests. Default output is status method URL; verbose/includeHeaders surfaces curated headers without bodies.",
		parameters: BROWSER_NETWORK_PARAMETERS,
		execute: browserNetworkTool,
	});

	pi.registerTool({
		name: "browser_fill",
		label: "Browser Fill",
		description: "Fill an input matched by CSS, text=, or role= selector.",
		parameters: BROWSER_FILL_PARAMETERS,
		execute: browserFillTool,
	});

	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element matched by CSS, text=, or role= selector.",
		parameters: BROWSER_SELECTOR_PARAMETERS,
		execute: browserClickTool,
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Save current page as a PNG in a temporary directory and return its path for read.",
		parameters: BROWSER_SCREENSHOT_PARAMETERS,
		execute: browserScreenshotTool,
	});

	for (const name of ["browser_close", "browser_kill"] as const) {
		pi.registerTool({
			name,
			label: "Browser Close",
			description: "Close the session browser without disabling browser verification.",
			parameters: Type.Object({}),
			execute: closeBrowserTool,
		});
	}

	pi.events.on(BROWSER_REQUEST_EVENT, (value: unknown) => {
		void handleBrowserChannelRequest(pi, value);
	});

	pi.registerCommand("browser", {
		description: "Enable, disable, or show browser verification status",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "status") return showStatus(ctx);
			if (command === "on") return setBrowserEnabled(pi, ctx, true);
			if (command === "off" || command === "close" || command === "kill") return setBrowserEnabled(pi, ctx, false);
			const message = "Unknown browser command. Use on, off, or status.";
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.error(message);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new") {
			await closeBrowser();
			browserEnabled = false;
			syncBrowserTools(pi);
			updateStatus(ctx);
			return;
		}
		await reconstructFromBranch(ctx);
		syncBrowserTools(pi);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await reconstructFromBranch(ctx);
		syncBrowserTools(pi);
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser();
	});
}
