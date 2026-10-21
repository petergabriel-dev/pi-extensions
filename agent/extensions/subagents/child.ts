import { Type, type Static, type TSchema } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentIpcClient } from "./ipc.ts";
import { readSubagentLoadout } from "./launch.ts";
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

const BrowserGotoParams = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 2_048 }),
	timeout: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
});
const BrowserEvalParams = Type.Object({
	expression: Type.String({ minLength: 1, maxLength: 10_000 }),
	timeout: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
});
const BrowserConsoleParams = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	filter: Type.Optional(Type.String({ maxLength: 1_000 })),
	clear: Type.Optional(Type.Boolean()),
});
const BrowserNetworkParams = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	urlFilter: Type.Optional(Type.String({ maxLength: 1_000 })),
	status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
	verbose: Type.Optional(Type.Boolean()),
	includeHeaders: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 })),
	clear: Type.Optional(Type.Boolean()),
});
const BrowserSelectorParams = Type.Object({
	selector: Type.String({ minLength: 1, maxLength: 2_048 }),
	timeout: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
});
const BrowserFillParams = Type.Object({
	selector: Type.String({ minLength: 1, maxLength: 2_048 }),
	value: Type.String({ maxLength: 100_000 }),
	timeout: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
});
const BrowserScreenshotParams = Type.Object({
	fullPage: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
});
const BrowserEmptyParams = Type.Object({});
const BrowserProxyParameters: Record<string, TSchema> = {
	browser_goto: BrowserGotoParams,
	browser_eval: BrowserEvalParams,
	browser_console: BrowserConsoleParams,
	browser_network: BrowserNetworkParams,
	browser_fill: BrowserFillParams,
	browser_click: BrowserSelectorParams,
	browser_screenshot: BrowserScreenshotParams,
	browser_close: BrowserEmptyParams,
};
const BROWSER_PROXY_NAMES = Object.keys(BrowserProxyParameters);
type BrowserProxyName = keyof typeof BrowserProxyParameters;

function browserProxyTimeout(params: Record<string, unknown>): number {
	const timeout = params.timeout;
	return typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 100 && timeout <= 120_000 ? Math.min(120_000, timeout + 1_000) : 32_000;
}

function requestBrowserProxy(client: SubagentIpcClient, tool: BrowserProxyName, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const request = client.request("browser", { tool, params }, { timeoutMs: browserProxyTimeout(params) });
	if (!signal) return request;
	return new Promise((resolve, reject) => {
		const finish = (action: () => void) => {
			signal.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => {
			void client.request("browser", { tool: "browser_close", params: {} }, { timeoutMs: 2_000 }).catch(() => undefined);
			finish(() => reject(new Error("Browser proxy request aborted.")));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		request.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
	});
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

	let loadout;
	try {
		loadout = readSubagentLoadout(process.env.PI_SUBAGENT_LOADOUT ?? "");
	} catch {
		loadout = undefined;
	}
	let client: SubagentIpcClient | undefined;
	const getClient = (): SubagentIpcClient => {
		client ??= SubagentIpcClient.create({ socketPath, token, owner });
		return client;
	};

	pi.registerTool({
		name: "ask_question",
		label: "Ask Parent",
		description: "Ask parent for information through the RPC dialog.",
		parameters: AskQuestionParams,
		async execute(_toolCallId, params: AskQuestionParams, _signal, _onUpdate, ctx) {
			const question = params.question.trim();
			const options = params.options?.map((option) => option.trim());
			const answer = options?.length ? await ctx.ui.select(question, options) : await ctx.ui.input(question);
			if (answer === undefined) throw new Error("Parent question was cancelled.");
			return { content: [{ type: "text", text: answer }], details: { ok: true } };
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
				const agentName = params.agent?.trim() || allowedAgents[0]!;
				const allowlistError = validateSubagentAgentAllowlist(allowedAgents, agentName);
				if (allowlistError) throw new Error(allowlistError);
				try {
					const response = await getClient().request<{ text?: unknown }>("spawn", {
						agent: agentName,
						task: params.task.trim(),
						...(params.fileOwnership ? { fileOwnership: params.fileOwnership } : {}),
					}, { noDeadline: true });
					if (!isRecord(response) || typeof response.text !== "string") throw new Error("Parent returned malformed nested subagent result.");
					return { content: [{ type: "text", text: response.text }], details: { ok: true, agent: agentName } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Nested subagent failed: ${message}`);
				}
			},
		});
	}

	for (const toolName of BROWSER_PROXY_NAMES) {
		if (!loadout?.tools.includes(toolName)) continue;
		const parameters = BrowserProxyParameters[toolName]!;
		pi.registerTool<TSchema, unknown>({
			name: toolName,
			label: toolName.replaceAll("_", " "),
			description: `Run ${toolName} through parent browser session; requires /browser on in parent. If gate is off, stop and report blocked: run /browser on.`,
			parameters,
			async execute(_toolCallId, params: unknown, signal) {
				try {
					const result = await requestBrowserProxy(getClient(), toolName, isRecord(params) ? params : {}, signal);
					if (isRecord(result) && Array.isArray(result.content)) return result as unknown as AgentToolResult<unknown>;
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ok: true, tool: toolName, result } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`${toolName} failed: ${message}`);
				}
			},
		});
	}
}
