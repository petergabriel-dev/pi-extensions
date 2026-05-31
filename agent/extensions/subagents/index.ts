import * as fs from "node:fs";

import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TOOL_NAME = "subagents_inprocess_spike";
const DEFAULT_READ_PATH = "agent/AGENTS.md";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FINAL_TEXT_BYTES = 50 * 1024;

const SpikeParams = Type.Object({
	path: Type.Optional(
		Type.String({
			description: `File path the child session should read. Defaults to ${DEFAULT_READ_PATH}.`,
		}),
	),
	prompt: Type.Optional(Type.String({ description: "Optional full child prompt override." })),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Child session timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
			minimum: 1000,
			maximum: 120000,
		}),
	),
});

type SpikeParams = Static<typeof SpikeParams>;

interface ParentSnapshot {
	sessionFile: string | undefined;
	leafId: string | null;
	entryCount: number;
	branchLength: number;
}

interface ChildToolCallSummary {
	toolName: string;
	argsPreview: string;
}

interface SpikeDetails {
	ok: boolean;
	readToolCalled: boolean;
	childSessionFile?: string;
	childSessionFileExists: boolean;
	childActiveTools: string[];
	childEventCounts: Record<string, number>;
	childToolCalls: ChildToolCallSummary[];
	childFinalText: string;
	parentBefore: ParentSnapshot;
	parentAfter: ParentSnapshot;
	parentUnchangedDuringExecute: boolean;
	error?: string;
}

const CHILD_SYSTEM_PROMPT = `You are a throwaway in-process subagent spike.

Your job is only to prove that a child AgentSession can run inside an extension tool execute() without inheriting parent state.
Use only the read/grep tools you were given. Read the requested file before answering.
Return a concise final answer that starts with SPIKE_CHILD_OK and mentions the file you inspected.`;

function snapshotParent(ctx: ExtensionContext): ParentSnapshot {
	return {
		sessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		entryCount: ctx.sessionManager.getEntries().length,
		branchLength: ctx.sessionManager.getBranch().length,
	};
}

function sameSnapshot(a: ParentSnapshot, b: ParentSnapshot): boolean {
	return (
		a.sessionFile === b.sessionFile &&
		a.leafId === b.leafId &&
		a.entryCount === b.entryCount &&
		a.branchLength === b.branchLength
	);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[truncated to ${maxBytes} bytes]`;
}

function extractLastAssistantText(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string {
	const direct = session.getLastAssistantText();
	if (direct) return direct;
	for (const message of [...session.messages].reverse()) {
		if (message.role !== "assistant") continue;
		return message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function buildChildPrompt(params: SpikeParams): string {
	if (params.prompt?.trim()) return params.prompt.trim();
	const readPath = params.path?.trim() || DEFAULT_READ_PATH;
	return [
		`Use the read tool to read this file: ${readPath}`,
		"Then return a concise summary beginning with SPIKE_CHILD_OK.",
		"Do not edit files or run shell commands.",
	].join("\n");
}

async function selectModel(ctx: ExtensionContext): Promise<Model<any> | undefined> {
	if (ctx.model) return ctx.model;
	const available = await Promise.resolve(ctx.modelRegistry.getAvailable());
	return available[0];
}

function createIsolatedLoader(cwd: string, agentDir: string, settingsManager: SettingsManager): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: CHILD_SYSTEM_PROMPT,
		appendSystemPrompt: [],
		appendSystemPromptOverride: () => [],
	});
}

async function runInProcessSpike(
	params: SpikeParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<SpikeDetails> {
	const parentBefore = snapshotParent(ctx);
	const eventCounts: Record<string, number> = {};
	const childToolCalls: ChildToolCallSummary[] = [];
	let childSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;

	const baseDetails = (): Omit<SpikeDetails, "ok" | "parentAfter" | "parentUnchangedDuringExecute"> => ({
		readToolCalled: childToolCalls.some((call) => call.toolName === "read"),
		childSessionFile: childSession?.sessionFile,
		childSessionFileExists: Boolean(childSession?.sessionFile && fs.existsSync(childSession.sessionFile)),
		childActiveTools: childSession?.getActiveToolNames() ?? [],
		childEventCounts: { ...eventCounts },
		childToolCalls: [...childToolCalls],
		childFinalText: childSession ? truncateUtf8(extractLastAssistantText(childSession), MAX_FINAL_TEXT_BYTES) : "",
		parentBefore,
	});

	try {
		const model = await selectModel(ctx);
		if (!model) throw new Error("No model is available for the child spike session.");

		const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		} as never);
		const resourceLoader = createIsolatedLoader(ctx.cwd, agentDir, settingsManager);
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd: ctx.cwd,
			agentDir,
			model,
			modelRegistry: ctx.modelRegistry,
			tools: ["read", "grep"],
			resourceLoader,
			sessionManager: SessionManager.create(ctx.cwd),
			settingsManager,
		});
		childSession = result.session;

		unsubscribe = childSession.subscribe((event: any) => {
			eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
			if (event.type === "tool_execution_start") {
				childToolCalls.push({
					toolName: String(event.toolName ?? ""),
					argsPreview: truncateUtf8(JSON.stringify(event.args ?? {}), 1000),
				});
			}
		});

		const abortChild = () => {
			void childSession?.abort().catch(() => undefined);
		};
		if (signal) {
			if (signal.aborted) abortChild();
			signal.addEventListener("abort", abortChild, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", abortChild);
		}

		const promptPromise = childSession.prompt(buildChildPrompt(params), {
			expandPromptTemplates: false,
			source: "extension",
		});
		void promptPromise.catch(() => undefined);

		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => {
				abortChild();
				reject(new Error(`Child spike session timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
		});

		await Promise.race([promptPromise, timeoutPromise]);

		const parentAfter = snapshotParent(ctx);
		const childFinalText = truncateUtf8(extractLastAssistantText(childSession), MAX_FINAL_TEXT_BYTES);
		const readToolCalled = childToolCalls.some((call) => call.toolName === "read");
		const childSessionFileExists = Boolean(childSession.sessionFile && fs.existsSync(childSession.sessionFile));
		const parentUnchangedDuringExecute = sameSnapshot(parentBefore, parentAfter);
		const childActiveTools = childSession.getActiveToolNames();
		const ok = Boolean(childFinalText && readToolCalled && childSessionFileExists && parentUnchangedDuringExecute);

		return {
			ok,
			readToolCalled,
			childSessionFile: childSession.sessionFile,
			childSessionFileExists,
			childActiveTools,
			childEventCounts: { ...eventCounts },
			childToolCalls: [...childToolCalls],
			childFinalText,
			parentBefore,
			parentAfter,
			parentUnchangedDuringExecute,
		};
	} catch (error) {
		const parentAfter = snapshotParent(ctx);
		return {
			...baseDetails(),
			ok: false,
			parentAfter,
			parentUnchangedDuringExecute: sameSnapshot(parentBefore, parentAfter),
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		removeAbortListener?.();
		unsubscribe?.();
		childSession?.dispose();
	}
}

function formatToolResult(details: SpikeDetails): string {
	const lines = [
		details.ok ? "In-process subagent spike OK." : "In-process subagent spike FAILED.",
		`Child session file: ${details.childSessionFile ?? "(none)"}`,
		`Child session file exists: ${details.childSessionFileExists ? "yes" : "no"}`,
		`Child active tools: ${details.childActiveTools.join(", ") || "(none)"}`,
		`Child read tool called: ${details.readToolCalled ? "yes" : "no"}`,
		`Parent branch unchanged during execute: ${details.parentUnchangedDuringExecute ? "yes" : "no"}`,
	];
	if (details.error) lines.push(`Error: ${details.error}`);
	if (details.childFinalText) lines.push("", "Child final text:", details.childFinalText);
	return lines.join("\n");
}

export default function subagentsSpikeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagents In-Process Spike",
		description:
			"Throwaway verification spike: create a persisted child AgentSession in-process from this tool execute(), give it read/grep only, prompt it to read one file, stream events, return final text, and report parent branch isolation.",
		promptSnippet: "Run a throwaway in-process child session spike for subagent architecture validation.",
		promptGuidelines: [
			`Use ${TOOL_NAME} only when explicitly asked to run the subagents in-process spike.`,
			`${TOOL_NAME} is diagnostic-only; do not use it for ordinary code search or implementation work.`,
		],
		parameters: SpikeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await runInProcessSpike(params, ctx, signal);
			return {
				content: [{ type: "text", text: formatToolResult(details) }],
				details,
			};
		},
	});
}
