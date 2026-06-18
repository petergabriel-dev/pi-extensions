import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type {
	AuthStorage as AuthStorageType,
	createAgentSession as createAgentSessionType,
	DefaultResourceLoader as DefaultResourceLoaderType,
	ModelRegistry as ModelRegistryType,
	SettingsManager as SettingsManagerType,
} from "@mariozechner/pi-coding-agent";
import type { ExtractionLogger } from "./extract.js";
import { EXTRACTION_SYSTEM_PROMPT, RECONCILIATION_SYSTEM_PROMPT } from "./prompts.js";

const Type = await loadTypeBox();

export const EXTRACTION_TIMEOUT_MS = 30_000;
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export type KnownCarefulModelApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex";

export type ForcedSubmitPlanToolChoice =
	| { type: "function"; function: { name: typeof SUBMIT_PLAN_TOOL_NAME } }
	| { type: "tool"; name: typeof SUBMIT_PLAN_TOOL_NAME }
	| "any";

const FORCED_TOOL_CHOICE_BY_API: Record<KnownCarefulModelApi, ForcedSubmitPlanToolChoice | null> = {
	"openai-completions": { type: "function", function: { name: SUBMIT_PLAN_TOOL_NAME } },
	"mistral-conversations": { type: "function", function: { name: SUBMIT_PLAN_TOOL_NAME } },
	"anthropic-messages": { type: "tool", name: SUBMIT_PLAN_TOOL_NAME },
	"bedrock-converse-stream": { type: "tool", name: SUBMIT_PLAN_TOOL_NAME },
	"google-generative-ai": "any",
	"google-vertex": "any",
	"openai-responses": null,
	"azure-openai-responses": null,
	"openai-codex-responses": null,
};

export function forcedToolChoiceForApi(api: string): ForcedSubmitPlanToolChoice | null {
	return FORCED_TOOL_CHOICE_BY_API[api as KnownCarefulModelApi] ?? null;
}

export class CarefulModelTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Careful model call timed out after ${timeoutMs}ms.`);
		this.name = "CarefulModelTimeoutError";
	}
}

export interface CarefulModelOneShotOptions {
	cwd?: string;
	agentDir?: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	authStorage?: AuthStorageType;
	modelRegistry?: ModelRegistryType;
	timeoutMs?: number;
	logger?: ExtractionLogger;
}

export function isolatedResourceLoaderOptions(
	systemPrompt: string,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManagerType,
) {
	return {
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
		appendSystemPrompt: [],
		appendSystemPromptOverride: () => [],
	};
}

export async function callCarefulModelOneShot(
	systemPrompt: string,
	userPrompt: string,
	options: CarefulModelOneShotOptions = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
	const logger = options.logger ?? console;
	const {
		AuthStorage,
		createAgentSession,
		DefaultResourceLoader,
		getAgentDir,
		ModelRegistry,
		SessionManager,
		SettingsManager,
	} = await import("@mariozechner/pi-coding-agent");
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create();
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	} as never);

	if (options.model) {
		try {
			const forcedToolResult = await callCarefulModelWithForcedSubmitPlanTool(systemPrompt, userPrompt, {
				model: options.model,
				modelRegistry,
				thinkingLevel: options.thinkingLevel,
				timeoutMs,
			});
			if (forcedToolResult.toolArgumentsJson) return forcedToolResult.toolArgumentsJson;
			if (forcedToolResult.text.trim()) return forcedToolResult.text.trim();
			logger.warn?.("[persistent-memory] careful model returned no submit_plan tool call; falling back to free-text session path.");
		} catch (error) {
			if (error instanceof CarefulModelTimeoutError) throw error;
			logger.warn?.("[persistent-memory] forced submit_plan careful model call unavailable; falling back to free-text session path.");
		}
	}

	return callCarefulModelSessionFreeText(systemPrompt, userPrompt, {
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		timeoutMs,
		logger,
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		settingsManager,
	});
}

interface ForcedSubmitPlanCallOptions {
	model: Model<any>;
	modelRegistry: ModelRegistryType;
	thinkingLevel?: ThinkingLevel;
	timeoutMs: number;
}

interface ForcedSubmitPlanCallResult {
	toolArgumentsJson: string | null;
	text: string;
}

async function callCarefulModelWithForcedSubmitPlanTool(
	systemPrompt: string,
	userPrompt: string,
	options: ForcedSubmitPlanCallOptions,
): Promise<ForcedSubmitPlanCallResult> {
	const { complete } = await import("@mariozechner/pi-ai") as any;
	const auth = await (options.modelRegistry as any).getApiKeyAndHeaders(options.model as never);
	if (!auth.ok) throw new Error("Careful model auth unavailable.");
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const context = {
			systemPrompt,
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [buildSubmitPlanTool(systemPrompt)],
		};
		const message = await complete(options.model as never, context, {
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
			...(options.thinkingLevel ? { reasoningEffort: options.thinkingLevel, reasoning: options.thinkingLevel } : {}),
			timeoutMs: options.timeoutMs,
			signal: controller.signal,
			toolChoice: { type: "function", function: { name: SUBMIT_PLAN_TOOL_NAME } },
		});
		return {
			toolArgumentsJson: extractSubmitPlanToolArguments(message),
			text: extractAssistantMessageText(message),
		};
	} catch (error) {
		if (controller.signal.aborted) throw new CarefulModelTimeoutError(options.timeoutMs);
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

interface SessionFreeTextOptions {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorageType;
	modelRegistry: ModelRegistryType;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	timeoutMs: number;
	logger: ExtractionLogger;
	createAgentSession: typeof createAgentSessionType;
	DefaultResourceLoader: typeof DefaultResourceLoaderType;
	SessionManager: { inMemory: (cwd?: string) => unknown };
	settingsManager: SettingsManagerType;
}

async function callCarefulModelSessionFreeText(
	systemPrompt: string,
	userPrompt: string,
	options: SessionFreeTextOptions,
): Promise<string> {
	let session: Awaited<ReturnType<typeof createAgentSessionType>>["session"] | undefined;
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const callPromise = (async () => {
		const resourceLoader = new options.DefaultResourceLoader(
			isolatedResourceLoaderOptions(systemPrompt, options.cwd, options.agentDir, options.settingsManager),
		);
		await resourceLoader.reload();
		assertNoResources(resourceLoader);

		const result = await options.createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			noTools: "all",
			tools: [],
			customTools: [],
			resourceLoader,
			sessionManager: options.SessionManager.inMemory(options.cwd) as never,
			settingsManager: options.settingsManager,
		});
		session = result.session;

		if (timedOut) {
			session.dispose();
			throw new CarefulModelTimeoutError(options.timeoutMs);
		}

		const activeTools = session.getActiveToolNames();
		if (activeTools.length > 0) {
			throw new Error(`Extraction one-shot expected no tools, got: ${activeTools.join(", ")}`);
		}

		await session.prompt(userPrompt, { expandPromptTemplates: false, source: "extension" });
		return extractLastAssistantText(session).trim();
	})();

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			options.logger.error?.(`[persistent-memory] careful model call timed out after ${options.timeoutMs}ms.`);
			void session?.abort().catch(() => undefined);
			reject(new CarefulModelTimeoutError(options.timeoutMs));
		}, options.timeoutMs);
	});

	try {
		return await Promise.race([callPromise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		session?.dispose();
	}
}

export function buildSubmitPlanTool(systemPrompt: string): { name: string; description: string; parameters: unknown } {
	return {
		name: SUBMIT_PLAN_TOOL_NAME,
		description: "Submit the complete structured memory extraction or reconciliation plan. Do not include host-owned IDs or metadata unless the schema explicitly asks for them.",
		parameters: selectSubmitPlanSchema(systemPrompt),
	};
}

function selectSubmitPlanSchema(systemPrompt: string) {
	if (systemPrompt === EXTRACTION_SYSTEM_PROMPT) return extractionSubmitPlanSchema();
	if (systemPrompt === RECONCILIATION_SYSTEM_PROMPT) return reconciliationSubmitPlanSchema();
	return Type.Object({}, { additionalProperties: true });
}

function extractionSubmitPlanSchema() {
	const evidence = Type.Object({
		discussion_note_ids: Type.Optional(Type.Array(Type.Number())),
		lesson_candidate_marker_ids: Type.Optional(Type.Array(Type.String())),
	});
	const trigger = Type.Union([
		Type.Object({ type: Type.Literal("path"), value: Type.String() }),
		Type.Object({ type: Type.Literal("filename"), value: Type.String() }),
		Type.Object({ type: Type.Literal("topic"), value: Type.String() }),
		Type.Object({ type: Type.Literal("tool"), value: Type.String(), pattern: Type.Optional(Type.String()) }),
		Type.Object({ type: Type.Literal("command"), pattern: Type.String() }),
	]);
	return Type.Object({
		candidates: Type.Object({
			lessons: Type.Array(Type.Object({
				summary: Type.String(),
				detail: Type.String(),
				triggers: Type.Array(trigger),
				scope_suggestion: Type.String(),
				source_evidence: evidence,
			})),
			preferences: Type.Array(Type.Object({ text: Type.String(), source_evidence: evidence })),
			decisions: Type.Array(Type.Object({ summary: Type.String(), detail: Type.String(), source_evidence: evidence })),
			domain: Type.Array(Type.Object({ summary: Type.String(), detail: Type.String(), source_evidence: evidence })),
		}),
	});
}

function reconciliationSubmitPlanSchema() {
	const refs = Type.Array(Type.String());
	const trigger = Type.Union([
		Type.Object({ type: Type.Literal("path"), value: Type.String() }),
		Type.Object({ type: Type.Literal("filename"), value: Type.String() }),
		Type.Object({ type: Type.Literal("topic"), value: Type.String() }),
		Type.Object({ type: Type.Literal("tool"), value: Type.String(), pattern: Type.Optional(Type.String()) }),
		Type.Object({ type: Type.Literal("command"), pattern: Type.String() }),
	]);
	const lessonAction = Type.Union([
		Type.Object({ action: Type.Literal("add"), candidate_refs: refs, summary: Type.String(), detail: Type.String(), triggers: Type.Array(trigger) }),
		Type.Object({ action: Type.Literal("merge"), candidate_refs: refs, target_id: Type.String(), summary: Type.String(), detail: Type.String(), triggers: Type.Array(trigger) }),
		Type.Object({ action: Type.Literal("supersede"), candidate_refs: refs, target_id: Type.String(), summary: Type.String(), detail: Type.String(), triggers: Type.Array(trigger) }),
		Type.Object({ action: Type.Literal("discard"), candidate_refs: refs, reason: Type.String() }),
	]);
	const preferenceAction = Type.Union([
		Type.Object({ action: Type.Literal("add"), candidate_refs: refs, text: Type.String() }),
		Type.Object({ action: Type.Literal("merge"), candidate_refs: refs, target_id: Type.String(), text: Type.String() }),
		Type.Object({ action: Type.Literal("discard"), candidate_refs: refs, reason: Type.String() }),
	]);
	const summaryDetailAction = Type.Union([
		Type.Object({ action: Type.Literal("add"), candidate_refs: refs, summary: Type.String(), detail: Type.String() }),
		Type.Object({ action: Type.Literal("merge"), candidate_refs: refs, target_id: Type.String(), summary: Type.String(), detail: Type.String() }),
		Type.Object({ action: Type.Literal("discard"), candidate_refs: refs, reason: Type.String() }),
	]);
	return Type.Object({
		lessons: Type.Array(lessonAction),
		preferences: Type.Array(preferenceAction),
		decisions: Type.Array(summaryDetailAction),
		domain: Type.Array(summaryDetailAction),
	});
}

async function loadTypeBox(): Promise<any> {
	try {
		return (await import("@mariozechner/pi-ai") as any).Type;
	} catch {
		// ponytail: standalone extension tests lack pi package aliases. Keep TypeBox-shaped fallback; remove when test env links pi-ai.
		return {
			Object: (properties: Record<string, any>, options: Record<string, unknown> = {}) => {
				const entries = Object.entries(properties);
				return {
					type: "object",
					...(entries.some(([, value]) => !value?.__optional) ? { required: entries.filter(([, value]) => !value?.__optional).map(([key]) => key) } : {}),
					properties: Object.fromEntries(entries.map(([key, value]) => [key, value?.__schema ?? value])),
					...options,
				};
			},
			Array: (items: unknown) => ({ type: "array", items }),
			Union: (anyOf: unknown[]) => ({ anyOf }),
			Literal: (value: string) => ({ type: "string", const: value }),
			String: () => ({ type: "string" }),
			Number: () => ({ type: "number" }),
			Optional: (schema: unknown) => ({ __optional: true, __schema: schema }),
		};
	}
}

export function extractSubmitPlanToolArguments(message: any): string | null {
	for (const part of message.content) {
		if (part.type === "toolCall" && part.name === SUBMIT_PLAN_TOOL_NAME) return JSON.stringify(part.arguments ?? {});
	}
	return null;
}

function extractAssistantMessageText(message: any): string {
	return message.content
		.map((part) => part.type === "text" ? part.text : "")
		.filter(Boolean)
		.join("\n");
}

function assertNoResources(resourceLoader: DefaultResourceLoaderType): void {
	const extensions = resourceLoader.getExtensions().extensions.length;
	const skills = resourceLoader.getSkills().skills.length;
	const prompts = resourceLoader.getPrompts().prompts.length;
	const contextFiles = resourceLoader.getAgentsFiles().agentsFiles.length;
	if (extensions > 0 || skills > 0 || prompts > 0 || contextFiles > 0) {
		throw new Error(
			`Extraction one-shot expected no resources, got extensions=${extensions}, skills=${skills}, prompts=${prompts}, contextFiles=${contextFiles}`,
		);
	}
}

export function extractLastAssistantText(session: Awaited<ReturnType<typeof createAgentSessionType>>["session"]): string {
	const direct = session.getLastAssistantText();
	if (direct) return direct;
	for (const message of [...session.messages].reverse()) {
		if (message.role !== "assistant") continue;
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
		if (text) return text;
		return message.content
			.map((part) => (part.type === "thinking" ? extractThinkingText(part) : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function extractThinkingText(part: unknown): string {
	return stringifyThinkingValue(part);
}

function stringifyThinkingValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(stringifyThinkingValue).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	const item = value as { thinking?: unknown; text?: unknown; content?: unknown };
	return stringifyThinkingValue(item.thinking) || stringifyThinkingValue(item.text) || stringifyThinkingValue(item.content);
}
