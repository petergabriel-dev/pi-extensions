import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildGlobalMemoryCurationPrompt, dispatchCurationPrompt, printCommandArgs, slashCommandArgs, writePrintNotice } from "./curation.js";
import { formatMemoryIndexBlock, migrateFlatFile, readMemoryEntry, readMemoryIndex, resolveMemoryDir, titleFromBody, writeMemoryFact } from "./store.js";

const MEMORY_FILE = "memory.md";
const MAX_REMEMBER_CHARS = 2_000;

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export interface PersonalMemoryOptions {
	memoryDir?: string;
	legacyMemoryPath?: string;
}

export default function personalMemory(pi: ExtensionAPI, options: PersonalMemoryOptions = {}) {
	const memoryDirPromise = options.memoryDir ? Promise.resolve(options.memoryDir) : Promise.resolve(resolveMemoryDir(getAgentDir()));
	const migrationPromise = memoryDirPromise.then((memoryDir) => migrateFlatFile(memoryDir, options.legacyMemoryPath));

	pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
		const memoryDir = await memoryDirPromise;
		await migrationPromise;
		const block = formatMemoryIndexBlock(await readMemoryIndex(memoryDir));
		if (!block) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	const prepareRememberPrompt = (args: string): { prompt?: string; error?: string } => {
		const text = normalizeRememberText(args);
		if (text && text.length > MAX_REMEMBER_CHARS) {
			return { error: `Memory too long (${text.length}/${MAX_REMEMBER_CHARS}). Keep personal memory small.` };
		}
		return { prompt: buildGlobalMemoryCurationPrompt(text) };
	};

	if (printCommandArgs("remember") !== null) {
		pi.on("input", (event) => {
			const args = slashCommandArgs(event.text, "remember");
			if (args === null) return { action: "continue" };
			const prepared = prepareRememberPrompt(args);
			if (prepared.error) {
				writePrintNotice(prepared.error);
				return { action: "handled" };
			}
			return { action: "transform", text: prepared.prompt! };
		});
	} else {
		pi.registerCommand("remember", {
			description: "Curate user-global Pi memory in the current chat",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const prepared = prepareRememberPrompt(args);
				if (prepared.error) {
					ctx.ui.notify(prepared.error, "warning");
					return;
				}
				const delivery = dispatchCurationPrompt(pi, ctx, prepared.prompt!);
				if (delivery === "queued") ctx.ui.notify("Memory curation queued as follow-up.", "info");
			},
		});
	}

	pi.registerTool?.({
		name: "remember",
		label: "Remember",
		description: "Best-effort save of short user-global personal memory to ~/.pi/memory/.",
		promptSnippet: "Persist curated user-global memory; provide slug when replacing an existing indexed entry.",
		promptGuidelines: [
			"Use remember for durable user preferences or lessons that should persist across sessions.",
			"Do not use remember for project facts; those belong in engineering docs.",
			"Keep remember entries small; provide the validated existing slug when replacing instead of duplicating.",
		],
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: {
				text: { type: "string", description: "Small durable personal memory to save." },
				slug: { type: "string", description: "Optional existing indexed entry slug to replace." },
			},
		},
		async execute(_toolCallId: string, params: { text?: unknown; slug?: unknown }) {
			const text = normalizeRememberText(params.text);
			if (!text) return toolText("No memory text supplied.");
			if (text.length > MAX_REMEMBER_CHARS) return toolText(`Memory too long (${text.length}/${MAX_REMEMBER_CHARS}). Keep personal memory small.`);
			await migrationPromise;
			const result = await writeRememberText(text, await memoryDirPromise, params.slug);
			return toolText(`Remembered in ${result.path}`);
		},
	});

	pi.registerTool?.({
		name: "recall_memory_entry",
		label: "Recall memory entry",
		description: "Fetch one user-global personal memory entry by slug from ~/.pi/memory/.",
		promptSnippet: "Use recall_memory_entry(slug) when the personal memory index has a relevant slug and full details are needed.",
		promptGuidelines: [
			"Fetch by slug from the injected personal memory index.",
			"Do not guess file paths; pass only the slug without .md.",
		],
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["slug"],
			properties: {
				slug: { type: "string", description: "Memory slug, without .md." },
			},
		},
		async execute(_toolCallId: string, params: { slug?: unknown }) {
			if (typeof params.slug !== "string" || !params.slug.trim()) return toolText("No memory slug supplied.");
			await migrationPromise;
			const entry = await readMemoryEntry(await memoryDirPromise, params.slug);
			return toolText(entry ?? `No memory entry found for slug: ${params.slug}`);
		},
	});
}

export function resolvePersonalMemoryPath(agentDir: string): string {
	const globalDir = path.basename(agentDir) === "agent" ? path.dirname(agentDir) : agentDir;
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

async function writeRememberText(text: string, memoryDir: string, slug?: unknown): Promise<{ slug: string; path: string; index: string }> {
	return writeMemoryFact({ name: titleFromBody(text), description: text, type: "user", body: text, slug }, memoryDir);
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

function toolText(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}
