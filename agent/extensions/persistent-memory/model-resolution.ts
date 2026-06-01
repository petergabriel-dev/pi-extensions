import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

const DEFAULT_CAREFUL_MODEL = "opencode-go/qwen3.6-plus";

export function resolveCarefulModel(
	envName: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void }
): any {
	const envValue = process.env[envName];
	const trimmed = envValue?.trim() || DEFAULT_CAREFUL_MODEL;

	if (!ctx.modelRegistry) {
		logger.warn(`[persistent-memory] Cannot resolve model "${trimmed}" because modelRegistry is not available on context. Falling back to default model.`);
		return ctx.model;
	}

	try {
		const allModels = ctx.modelRegistry.getAll();
		if (!allModels || allModels.length === 0) {
			logger.warn(`[persistent-memory] Cannot resolve model "${trimmed}" because no models are available in the registry. Falling back to default model.`);
			return ctx.model;
		}

		const lowerVal = trimmed.toLowerCase();
		let matched = allModels.find(
			(m: any) =>
				m.id.toLowerCase() === lowerVal ||
				`${m.provider}/${m.id}`.toLowerCase() === lowerVal
		);

		if (!matched && trimmed.includes("/")) {
			const slashIdx = trimmed.indexOf("/");
			const providerPart = trimmed.substring(0, slashIdx).toLowerCase();
			const modelPart = trimmed.substring(slashIdx + 1).toLowerCase();
			matched = allModels.find(
				(m: any) =>
					m.provider.toLowerCase() === providerPart &&
					m.id.toLowerCase() === modelPart
			);
		}

		if (!matched) {
			matched = allModels.find(
				(m: any) =>
					m.id.toLowerCase().includes(lowerVal) ||
					m.name.toLowerCase().includes(lowerVal)
			);
		}

		if (!matched) {
			logger.warn(`[persistent-memory] Pinned model "${trimmed}" not found in model registry. Falling back to default model.`);
			return ctx.model;
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(matched)) {
			logger.warn(`[persistent-memory] Pinned model "${matched.provider}/${matched.id}" is found but auth/API key is not configured. Falling back to default model.`);
			return ctx.model;
		}

		return matched;
	} catch (error) {
		logger.warn(`[persistent-memory] Error resolving pinned model "${trimmed}": ${error instanceof Error ? error.message : String(error)}. Falling back to default model.`);
		return ctx.model;
	}
}
