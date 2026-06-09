import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

/** Pinned default for careful / extraction work (heavy model). */
const DEFAULT_CAREFUL_MODEL = "opencode-go/glm-5.1";

/** Pinned default for extraction (same heavy model, kept for clarity). */
export const DEFAULT_EXTRACTION_MODEL = "opencode-go/glm-5.1";

/** Pinned default for adjudication / reconciliation judgements (small, fast model). */
export const DEFAULT_ADJUDICATION_MODEL = "opencode-go/glm-4-flash";

/**
 * Resolve a model by env-var override, registry lookup, and auth check.
 * Falls back to `ctx.model` when resolution is not possible.
 */
function resolveModelWithDefault(
	envName: string,
	pinnedDefault: string,
	label: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
): any {
	const envValue = process.env[envName];
	const trimmed = envValue?.trim() || pinnedDefault;

	if (!ctx.modelRegistry) {
		logger.warn(`[persistent-memory] Cannot resolve ${label} model "${trimmed}" because modelRegistry is not available on context. Falling back to default model.`);
		return ctx.model;
	}

	try {
		const allModels = ctx.modelRegistry.getAll();
		if (!allModels || allModels.length === 0) {
			logger.warn(`[persistent-memory] Cannot resolve ${label} model "${trimmed}" because no models are available in the registry. Falling back to default model.`);
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
			logger.warn(`[persistent-memory] Pinned ${label} model "${trimmed}" not found in model registry. Falling back to default model.`);
			return ctx.model;
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(matched)) {
			logger.warn(`[persistent-memory] Pinned ${label} model "${formatModelId(matched)}" is found but auth/API key is not configured. Falling back to default model.`);
			return ctx.model;
		}

		logger.info?.(`[persistent-memory] Resolved ${label} model for ${envName}: ${formatModelId(matched)}.`);
		return matched;
	} catch (error) {
		logger.warn(`[persistent-memory] Error resolving pinned ${label} model "${trimmed}": ${error instanceof Error ? error.message : String(error)}. Falling back to default model.`);
		return ctx.model;
	}
}

/**
 * Resolve the careful model (backward-compatible entrypoint).
 * Uses the pinned `DEFAULT_CAREFUL_MODEL` as the default.
 */
export function resolveCarefulModel(
	envName: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
): any {
	return resolveModelWithDefault(envName, DEFAULT_CAREFUL_MODEL, "careful", ctx, logger);
}

/**
 * Resolve the extraction model.
 * Uses the pinned `DEFAULT_EXTRACTION_MODEL` as the default.
 */
export function resolveExtractionModel(
	envName: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
): any {
	return resolveModelWithDefault(envName, DEFAULT_EXTRACTION_MODEL, "extraction", ctx, logger);
}

/**
 * Resolve the adjudication model (small, fast model for reconciliation judgements).
 * Uses the pinned `DEFAULT_ADJUDICATION_MODEL` as the default.
 */
export function resolveAdjudicationModel(
	envName: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
): any {
	return resolveModelWithDefault(envName, DEFAULT_ADJUDICATION_MODEL, "adjudication", ctx, logger);
}

function formatModelId(model: any): string {
	const provider = typeof model?.provider === "string" ? model.provider : String(model?.provider ?? "unknown-provider");
	const id = typeof model?.id === "string" ? model.id : String(model?.id ?? model?.name ?? "unknown-model");
	return `${provider}/${id}`;
}
