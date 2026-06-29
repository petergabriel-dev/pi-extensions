import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MEMORY_FILE = "memory.md";
const MAX_REMEMBER_CHARS = 2_000;

export default function personalMemory(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
		const memoryPath = await resolvePersonalMemoryPath();
		const memory = await readPersonalMemory(memoryPath);
		if (!memory) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${formatPersonalMemoryBlock(memory)}` };
	});

	pi.registerCommand("remember", {
		description: "Append a small user-global personal memory to ~/.pi/memory.md",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = normalizeRememberText(args);
			if (!text) {
				ctx.ui.notify("Usage: /remember <small durable lesson>", "warning");
				return;
			}
			if (text.length > MAX_REMEMBER_CHARS) {
				ctx.ui.notify(`Memory too long (${text.length}/${MAX_REMEMBER_CHARS}). Keep ~/.pi/memory.md small.`, "warning");
				return;
			}
			const memoryPath = await resolvePersonalMemoryPath();
			await appendPersonalMemory(memoryPath, text);
			ctx.ui.notify(`Remembered in ${memoryPath}`, "success");
		},
	});

	pi.registerTool?.({
		name: "remember",
		label: "Remember",
		description: "Best-effort append of a short user-global personal memory to ~/.pi/memory.md.",
		promptSnippet: "Append a short user-global personal memory when explicitly asked to remember something.",
		promptGuidelines: [
			"Use remember only when the user explicitly asks to remember a small durable personal preference or lesson.",
			"Do not use remember for project facts; those belong in engineering docs.",
		],
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: {
				text: { type: "string", description: "Small durable personal memory to append." },
			},
		},
		async execute(_toolCallId: string, params: { text?: unknown }) {
			const text = normalizeRememberText(params.text);
			if (!text) return toolText("No memory text supplied.");
			if (text.length > MAX_REMEMBER_CHARS) return toolText(`Memory too long (${text.length}/${MAX_REMEMBER_CHARS}). Keep ~/.pi/memory.md small.`);
			const memoryPath = await resolvePersonalMemoryPath();
			await appendPersonalMemory(memoryPath, text);
			return toolText(`Remembered in ${memoryPath}`);
		},
	});
}

export async function resolvePersonalMemoryPath(agentDir?: string): Promise<string> {
	const resolvedAgentDir = agentDir ?? await resolveAgentDir();
	const globalDir = path.basename(resolvedAgentDir) === "agent" ? path.dirname(resolvedAgentDir) : resolvedAgentDir;
	return path.join(globalDir, MEMORY_FILE);
}

export async function readPersonalMemory(memoryPath: string): Promise<string | null> {
	try {
		const raw = await fs.readFile(memoryPath, "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export async function appendPersonalMemory(memoryPath: string, text: string, now = new Date()): Promise<void> {
	const normalized = normalizeRememberText(text);
	if (!normalized) throw new Error("memory text is required");
	if (normalized.length > MAX_REMEMBER_CHARS) throw new Error(`memory text exceeds ${MAX_REMEMBER_CHARS} characters`);
	await fs.mkdir(path.dirname(memoryPath), { recursive: true });
	await fs.appendFile(memoryPath, `${await filePrefix(memoryPath)}- ${dateStamp(now)} — ${normalized}\n`, "utf8");
}

export function formatPersonalMemoryBlock(memory: string): string {
	return [
		"# User-global personal memory",
		"Loaded from ~/.pi/memory.md. Keep this file small; user may prune it manually.",
		"",
		memory.trim(),
	].join("\n");
}

export function normalizeRememberText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

async function filePrefix(memoryPath: string): Promise<string> {
	try {
		const stat = await fs.stat(memoryPath);
		return stat.size > 0 ? "" : "# Personal memory\n\n";
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "# Personal memory\n\n";
		throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function dateStamp(date: Date): string {
	return date.toISOString().slice(0, 10);
}

async function resolveAgentDir(): Promise<string> {
	for (const specifier of ["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"]) {
		try {
			const module = await import(specifier) as { getAgentDir?: () => string };
			if (typeof module.getAgentDir === "function") return module.getAgentDir();
		} catch {
			// Try next package name; tests outside Pi fall back to ~/.pi/agent.
		}
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function toolText(text: string) {
	return { content: [{ type: "text", text }] };
}
