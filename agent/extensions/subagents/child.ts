import * as crypto from "node:crypto";

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentIpcClient, type SubagentIpcRequest } from "./ipc.ts";
import { readSubagentLoadout, truncateSubagentResult } from "./launch.ts";
import { MAX_SUBAGENT_DEPTH, validateSubagentAgentAllowlist } from "./policy.ts";

const AskQuestionParams = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 50 * 1024 }),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 20 })),
});
type AskQuestionParams = Static<typeof AskQuestionParams>;

const NestedSubagentParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: 50 * 1024 }),
	agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	fileOwnership: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 100 })),
});
type NestedSubagentParams = Static<typeof NestedSubagentParams>;

function lastAssistantText(messages: readonly unknown[]): string {
	for (const rawMessage of [...messages].reverse()) {
		const message = rawMessage as { role?: unknown; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function subagentChildExtension(pi: ExtensionAPI): void {
	const socketPath = process.env.PI_SUBAGENT_SOCKET;
	const token = process.env.PI_SUBAGENT_TOKEN;
	const owner = process.env.PI_SUBAGENT_OWNER;
	const childSessionId = process.env.PI_SUBAGENT_CHILD_SESSION_ID;
	if (!socketPath || !token || !owner || !childSessionId) return;

	let client: SubagentIpcClient | undefined;
	let resultSent = false;
	let loadout;
	try {
		loadout = readSubagentLoadout(process.env.PI_SUBAGENT_LOADOUT ?? "");
	} catch {
		loadout = undefined;
	}
	const handleParentRequest = async (request: SubagentIpcRequest): Promise<unknown> => {
		if (request.type === "message") {
			if (!isRecord(request.payload) || typeof request.payload.text !== "string" || !request.payload.text.trim()) throw new Error("Parent message must contain non-empty text.");
			pi.sendUserMessage(request.payload.text, { deliverAs: "followUp" });
			return { accepted: true };
		}
		throw new Error(`Unsupported parent IPC message: ${request.type}.`);
	};

	pi.registerTool({
		name: "ask_question",
		label: "Ask Parent",
		description: "Ask parent for information. Child pauses until parent replies through subagent_message.",
		parameters: AskQuestionParams,
		async execute(_toolCallId, params: AskQuestionParams) {
			if (!client) return { content: [{ type: "text", text: "Parent IPC is not connected." }], details: { ok: false, questionId: undefined as string | undefined } };
			const questionId = crypto.randomUUID();
			try {
				const response = await client.request<{ answer?: unknown }>("question", {
					questionId,
					question: params.question.trim(),
					...(params.options ? { options: params.options.map((option) => option.trim()) } : {}),
				});
				if (!isRecord(response) || typeof response.answer !== "string") throw new Error("Parent returned malformed question answer.");
				return { content: [{ type: "text", text: response.answer }], details: { ok: true, questionId } };
			} catch (error) {
				return { content: [{ type: "text", text: `Parent question failed: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false, questionId } };
			}
		}
	});

	if (loadout?.subagentAgents?.length && loadout.depth < MAX_SUBAGENT_DEPTH) {
		const allowedAgents = loadout.subagentAgents;
		pi.registerTool<typeof NestedSubagentParams, unknown>({
			name: "subagent",
			label: "Subagent",
			description: "Start an allowlisted nested subagent and wait for its result.",
			parameters: NestedSubagentParams,
			async execute(_toolCallId, params: NestedSubagentParams) {
				if (!client) return { content: [{ type: "text", text: "Parent IPC is not connected." }], details: { ok: false } };
				const agentName = params.agent?.trim() || allowedAgents[0]!;
				const allowlistError = validateSubagentAgentAllowlist(allowedAgents, agentName);
				if (allowlistError) return { content: [{ type: "text", text: allowlistError }], details: { ok: false, error: allowlistError } };
				try {
					const response = await client.request<{ text?: unknown }>("spawn", {
						agent: agentName,
						task: params.task.trim(),
						...(params.fileOwnership ? { fileOwnership: params.fileOwnership } : {}),
					});
					if (!isRecord(response) || typeof response.text !== "string") throw new Error("Parent returned malformed nested subagent result.");
					return { content: [{ type: "text", text: response.text }], details: { ok: true, agent: agentName } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Nested subagent failed: ${message}` }], details: { ok: false, error: message, agent: agentName } };
				}
			},
		});
	}

	pi.on("session_start", async () => {
		client = await SubagentIpcClient.connect({ socketPath, token, owner, onRequest: handleParentRequest });
	});

	pi.on("agent_end", (event, ctx) => {
		if (!client || resultSent) return;
		resultSent = true;
		const text = truncateSubagentResult(lastAssistantText(event.messages));
		void client.request("result", { childSessionId, text })
			.then(() => ctx.shutdown())
			.catch(() => ctx.shutdown());
	});

	pi.on("session_shutdown", () => {
		void client?.close();
	});
}
