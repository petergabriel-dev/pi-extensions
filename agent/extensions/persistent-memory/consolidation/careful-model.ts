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

export const EXTRACTION_TIMEOUT_MS = 30_000;

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

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const callPromise = (async () => {
		const resourceLoader = new DefaultResourceLoader(
			isolatedResourceLoaderOptions(systemPrompt, cwd, agentDir, settingsManager),
		);
		await resourceLoader.reload();
		assertNoResources(resourceLoader);

		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			noTools: "all",
			tools: [],
			customTools: [],
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});
		session = result.session;

		if (timedOut) {
			session.dispose();
			throw new CarefulModelTimeoutError(timeoutMs);
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
			logger.error?.(`[persistent-memory] careful model call timed out after ${timeoutMs}ms.`);
			void session?.abort().catch(() => undefined);
			reject(new CarefulModelTimeoutError(timeoutMs));
		}, timeoutMs);
	});

	try {
		return await Promise.race([callPromise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		session?.dispose();
	}
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
