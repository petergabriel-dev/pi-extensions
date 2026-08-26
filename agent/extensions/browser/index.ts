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

export function resolveBrowserProfilePath(agentDir = getAgentDir(), env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_BROWSER_PROFILE?.trim();
	return configured ? resolve(configured) : join(agentDir, "browser", "profile");
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

const BROWSER_GOTO_PARAMETERS = Type.Object({
	url: Type.String({ minLength: 1, maxLength: MAX_BROWSER_URL_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

const BROWSER_EVAL_PARAMETERS = Type.Object({
	expression: Type.String({ minLength: 1, maxLength: MAX_BROWSER_EXPRESSION_LENGTH }),
	timeout: Type.Optional(Type.Integer({ minimum: MIN_BROWSER_TIMEOUT_MS, maximum: MAX_BROWSER_TIMEOUT_MS })),
});

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
