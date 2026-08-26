import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
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

let browserEnabled = false;
let browserContext: BrowserContext | undefined;
let browserPage: BrowserPage | undefined;
let launchPromise: Promise<{ context: BrowserContext; page: BrowserPage }> | undefined;
const consoleBuffer = new RingBuffer<ConsoleEntry>();
const networkBuffer = new RingBuffer<NetworkEntry>();

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
	return verbose === true || extra.length > 0 ? new Set([...KEEP_HEADERS, ...extra]) : new Set();
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

async function runBrowserOperation<T>(label: string, timeout: number, operation: () => Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	try {
		return await Promise.race([
			operation(),
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error("browser-operation-timeout"));
				}, timeout);
			}),
		]);
	} catch (error) {
		if (timedOut) {
			await closeBrowser().catch(() => undefined);
			throw new Error(`${label} timed out after ${timeout} milliseconds`);
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} failed: ${detail}`);
	} finally {
		if (timer) clearTimeout(timer);
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

async function browserGotoTool(_toolCallId: string, params: BrowserGotoInput) {
	const url = validateBrowserUrl(params.url);
	const timeout = validateBrowserTimeout(params.timeout);
	const result = await runBrowserOperation("browser_goto", timeout, async () => {
		const page = await ensureBrowserPage();
		const response = await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
		return { status: response?.status() ?? 0, finalUrl: page.url() };
	});
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
	};
}

async function browserEvalTool(_toolCallId: string, params: BrowserEvalInput) {
	const timeout = validateBrowserTimeout(params.timeout);
	const script = buildBrowserEvalScript(params.expression);
	const result = await runBrowserOperation("browser_eval", timeout, async () => {
		const page = await ensureBrowserPage();
		return page.evaluate(script);
	});
	const serialized = serializeBrowserEvalResult(result);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
		details: { result: serialized },
	};
}

type BrowserConsoleInput = { limit?: number; filter?: string; clear?: boolean };
type BrowserNetworkInput = { limit?: number; urlFilter?: string; status?: number; verbose?: boolean; includeHeaders?: string[]; clear?: boolean };

function validateOptionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

async function browserConsoleTool(_toolCallId: string, params: BrowserConsoleInput) {
	const limit = validateBrowserOutputLimit(params.limit);
	const filter = validateBrowserFilter(params.filter, "filter");
	const clear = validateOptionalBoolean(params.clear, "clear") ?? true;
	const entries = clear ? consoleBuffer.drain() : consoleBuffer.peek();
	const filtered = filter ? entries.filter((entry) => entry.text.includes(filter) || (entry.location ?? "").includes(filter)) : entries;
	const output = filtered.slice(-limit);
	const text = output.map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.type}: ${entry.text}${entry.location ? `  @ ${entry.location}` : ""}`).join("\n") || "(empty)";
	return { content: [{ type: "text" as const, text }], details: { entries: output } };
}

async function browserNetworkTool(_toolCallId: string, params: BrowserNetworkInput) {
	const limit = validateBrowserOutputLimit(params.limit);
	const urlFilter = validateBrowserFilter(params.urlFilter, "urlFilter");
	const status = validateBrowserStatus(params.status);
	const verbose = validateOptionalBoolean(params.verbose, "verbose") ?? false;
	const clear = validateOptionalBoolean(params.clear, "clear") ?? true;
	const extraHeaders = normalizeHeaderNames(params.includeHeaders);
	const entries = clear ? networkBuffer.drain() : networkBuffer.peek();
	const filtered = entries.filter((entry) => (!urlFilter || entry.url.includes(urlFilter)) && (status === undefined || entry.status === status));
	const output = filtered.slice(-limit);
	const allow = verbose || extraHeaders.length > 0 ? new Set([...KEEP_HEADERS, ...extraHeaders]) : new Set<string>();
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

function attachBrowserListeners(page: BrowserPage): void {
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
		void captureNetworkRequest(request);
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

async function captureNetworkRequest(request: BrowserRequest): Promise<void> {
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

async function launchBrowser(): Promise<{ context: BrowserContext; page: BrowserPage }> {
	const profileDir = resolveBrowserProfilePath();
	await mkdir(profileDir, { recursive: true });
	let context: BrowserContext | undefined;
	try {
		const { chromium } = await import("playwright-core");
		context = await chromium.launchPersistentContext(profileDir, { headless: !isBrowserHeadful() });
		const pages = context.pages();
		const page = pages.find((candidate) => !candidate.isClosed()) ?? await context.newPage();
		await Promise.allSettled(pages.filter((candidate) => candidate !== page).map((candidate) => candidate.close()));
		attachBrowserListeners(page);
		browserContext = context;
		browserPage = page;
		return { context, page };
	} catch (error) {
		await context?.close().catch(() => undefined);
		throw new Error(formatBrowserLaunchError(error));
	}
}

export async function ensureBrowserPage(): Promise<BrowserPage> {
	if (!browserEnabled) throw new Error("Browser gate is off. Run /browser on first.");
	if (browserContext && browserPage && !browserPage.isClosed()) return browserPage;
	if (browserContext) await closeBrowser();
	if (!launchPromise) {
		launchPromise = launchBrowser().finally(() => {
			launchPromise = undefined;
		});
	}
	return (await launchPromise).page;
}

export async function closeBrowser(): Promise<void> {
	const pending = launchPromise;
	if (pending) await pending.catch(() => undefined);
	const context = browserContext;
	browserContext = undefined;
	browserPage = undefined;
	if (!context) return;
	try {
		await context.close();
	} catch (error) {
		await context.browser()?.close().catch(() => undefined);
		throw new Error(`Could not close Chromium: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function closeBrowserTool() {
	await closeBrowser();
	return { content: [{ type: "text" as const, text: "Browser closed." }], details: { closed: true } };
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

function reconstructFromBranch(ctx: ExtensionContext): void {
	browserEnabled = resolveBrowserEnabled(ctx.sessionManager.getBranch());
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

	for (const name of ["browser_close", "browser_kill"] as const) {
		pi.registerTool({
			name,
			label: "Browser Close",
			description: "Close the session browser without disabling browser verification.",
			parameters: Type.Object({}),
			execute: closeBrowserTool,
		});
	}

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
			browserEnabled = false;
			syncBrowserTools(pi);
			updateStatus(ctx);
			return;
		}
		reconstructFromBranch(ctx);
		syncBrowserTools(pi);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructFromBranch(ctx);
		syncBrowserTools(pi);
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser();
	});
}
