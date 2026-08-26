import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BROWSER_STATE_ENTRY = "browser:state";
export const BROWSER_STATUS_KEY = "browser";

type BrowserStateEntry = {
	enabled?: unknown;
};

type CustomEntry = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

let browserEnabled = false;

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
	await Promise.resolve(pi.appendEntry(BROWSER_STATE_ENTRY, { enabled, at: Date.now() }));
	browserEnabled = enabled;
	updateStatus(ctx);
	showStatus(ctx);
}

export default function browserExtension(pi: ExtensionAPI): void {
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
			updateStatus(ctx);
			return;
		}
		reconstructFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructFromBranch(ctx);
	});
}
