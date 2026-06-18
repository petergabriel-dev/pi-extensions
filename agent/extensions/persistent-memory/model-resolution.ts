import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

/** Pinned default for careful / extraction work (heavy model). */
const DEFAULT_CAREFUL_MODEL = "opencode-go/glm-5.1";

/** Pinned default for extraction. */
export const DEFAULT_EXTRACTION_MODEL = "opencode-go/deepseek-v4-flash";

/** Pinned default for adjudication / reconciliation judgements. */
export const DEFAULT_ADJUDICATION_MODEL = "opencode-go/deepseek-v4-flash";

export type MemoryModelRole = "extraction" | "adjudication";

type MemorySettings = {
	models?: Partial<Record<MemoryModelRole, string>>;
};

function settingsPath(): string {
	return path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "settings.json");
}

function readSettings(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function readMemorySettings(): MemorySettings {
	const value = readSettings().persistentMemory;
	return value && typeof value === "object" && !Array.isArray(value) ? value as MemorySettings : {};
}

export function readMemoryModelOverride(role: MemoryModelRole): string | undefined {
	const ref = readMemorySettings().models?.[role];
	return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

export function writeMemoryModelOverride(role: MemoryModelRole, modelRef: string): void {
	const settings = readSettings();
	const persistentMemory = readMemorySettings();
	settings.persistentMemory = {
		...persistentMemory,
		models: { ...(persistentMemory.models ?? {}), [role]: modelRef },
	};
	fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * Resolve a model by persisted override, env-var override, registry lookup, and auth check.
 * Falls back to `ctx.model` when resolution is not possible.
 */
function resolveModelWithDefault(
	role: MemoryModelRole | undefined,
	envName: string,
	pinnedDefault: string,
	label: string,
	ctx: { modelRegistry?: ModelRegistry; model?: any },
	logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
): any {
	const persistedOverride = role ? readMemoryModelOverride(role) : undefined;
	const envValue = process.env[envName]?.trim();
	const fallbackRef = envValue || pinnedDefault;

	if (!ctx.modelRegistry) {
		logger.warn(`[persistent-memory] Cannot resolve ${label} model "${persistedOverride ?? fallbackRef}" because modelRegistry is not available on context. Falling back to default model.`);
		return ctx.model;
	}

	try {
		const allModels = ctx.modelRegistry.getAll();
		if (!allModels || allModels.length === 0) {
			logger.warn(`[persistent-memory] Cannot resolve ${label} model "${persistedOverride ?? fallbackRef}" because no models are available in the registry. Falling back to default model.`);
			return ctx.model;
		}

		if (persistedOverride) {
			const overrideMatch = findModel(allModels, persistedOverride);
			if (!overrideMatch) {
				logger.warn(`[persistent-memory] Persisted ${label} model override "${persistedOverride}" not found in model registry. Falling back to ${envValue ? "env-var" : "pinned default"} model.`);
			} else if (!ctx.modelRegistry.hasConfiguredAuth(overrideMatch)) {
				logger.warn(`[persistent-memory] Persisted ${label} model override "${formatModelId(overrideMatch)}" is found but auth/API key is not configured. Falling back to ${envValue ? "env-var" : "pinned default"} model.`);
			} else {
				logger.info?.(`[persistent-memory] Resolved ${label} model from persisted override: ${formatModelId(overrideMatch)}.`);
				return overrideMatch;
			}
		}

		const matched = findModel(allModels, fallbackRef);
		if (!matched) {
			logger.warn(`[persistent-memory] Pinned ${label} model "${fallbackRef}" not found in model registry. Falling back to default model.`);
			return ctx.model;
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(matched)) {
			logger.warn(`[persistent-memory] Pinned ${label} model "${formatModelId(matched)}" is found but auth/API key is not configured. Falling back to default model.`);
			return ctx.model;
		}

		logger.info?.(`[persistent-memory] Resolved ${label} model for ${envName}: ${formatModelId(matched)}.`);
		return matched;
	} catch (error) {
		logger.warn(`[persistent-memory] Error resolving ${label} model "${persistedOverride ?? fallbackRef}": ${error instanceof Error ? error.message : String(error)}. Falling back to default model.`);
		return ctx.model;
	}
}

function findModel(allModels: any[], reference: string): any | undefined {
	const lowerVal = reference.toLowerCase();
	let matched = allModels.find(
		(m: any) =>
			m.id.toLowerCase() === lowerVal ||
			`${m.provider}/${m.id}`.toLowerCase() === lowerVal
	);

	if (!matched && reference.includes("/")) {
		const slashIdx = reference.indexOf("/");
		const providerPart = reference.substring(0, slashIdx).toLowerCase();
		const modelPart = reference.substring(slashIdx + 1).toLowerCase();
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

	return matched;
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
	return resolveModelWithDefault(undefined, envName, DEFAULT_CAREFUL_MODEL, "careful", ctx, logger);
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
	return resolveModelWithDefault("extraction", envName, DEFAULT_EXTRACTION_MODEL, "extraction", ctx, logger);
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
	return resolveModelWithDefault("adjudication", envName, DEFAULT_ADJUDICATION_MODEL, "adjudication", ctx, logger);
}

function formatModelId(model: any): string {
	const provider = typeof model?.provider === "string" ? model.provider : String(model?.provider ?? "unknown-provider");
	const id = typeof model?.id === "string" ? model.id : String(model?.id ?? model?.name ?? "unknown-model");
	return `${provider}/${id}`;
}
