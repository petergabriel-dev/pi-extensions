import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";

export const BROWSER_STATE_ENTRY = "browser:state";
export const BROWSER_STATUS_KEY = "browser";
export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium";
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
