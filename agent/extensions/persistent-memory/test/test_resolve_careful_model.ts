import assert from "node:assert";
import {
	resolveCarefulModel,
	resolveExtractionModel,
	resolveAdjudicationModel,
	DEFAULT_EXTRACTION_MODEL,
	DEFAULT_ADJUDICATION_MODEL,
} from "../model-resolution.js";

console.log("Running test_resolve_careful_model...");

type TestModel = { provider: string; id: string; name: string };

const ctxModel: TestModel = { provider: "session", id: "current-model", name: "Current Model" };
const envModel: TestModel = { provider: "env-provider", id: "env-model", name: "Env Model" };
const extractionDefault: TestModel = { provider: "opencode-go", id: "glm-5.1", name: "GLM 5.1" };
const adjudicationDefault: TestModel = { provider: "opencode-go", id: "glm-4-flash", name: "GLM 4 Flash" };

function makeCtx(models: TestModel[], authedModels: TestModel[]) {
	return {
		model: ctxModel,
		modelRegistry: {
			getAll: () => models,
			hasConfiguredAuth: (model: TestModel) => authedModels.includes(model),
		},
	};
}

function withEnv(name: string, value: string | undefined, run: () => void) {
	const previous = process.env[name];
	try {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
		run();
	} finally {
		if (previous === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = previous;
		}
	}
}

const logger = { warn: () => undefined };
const envName = "PERSISTENT_MEMORY_TEST_MODEL";

// === resolveCarefulModel (backward-compatible entrypoint) ===

// Env override takes precedence over the pinned default.
withEnv(envName, "env-provider/env-model", () => {
	const ctx = makeCtx([envModel, extractionDefault], [envModel, extractionDefault]);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), envModel);
});

// Unset env resolves to the pinned default when it is present and authed.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([extractionDefault], [extractionDefault]);
	const infoMessages: unknown[][] = [];
	assert.strictEqual(resolveCarefulModel(envName, ctx, { ...logger, info: (...args) => infoMessages.push(args) }), extractionDefault);
	assert.deepStrictEqual(infoMessages, [["[persistent-memory] Resolved careful model for PERSISTENT_MEMORY_TEST_MODEL: opencode-go/glm-5.1."]]);
});

// Unset env falls back to ctx.model when the pinned default is not found.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([envModel], [envModel]);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), ctxModel);
});

// Unset env falls back to ctx.model when the pinned default is present but auth is not configured.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([extractionDefault], []);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), ctxModel);
});

// === resolveExtractionModel ===

// Extraction default is unchanged (opencode-go/glm-5.1, the heavy model).
withEnv(envName, undefined, () => {
	const ctx = makeCtx([extractionDefault], [extractionDefault]);
	assert.strictEqual(resolveExtractionModel(envName, ctx, logger), extractionDefault);
});

// Extraction env override wins.
withEnv(envName, "env-provider/env-model", () => {
	const ctx = makeCtx([envModel, extractionDefault], [envModel, extractionDefault]);
	assert.strictEqual(resolveExtractionModel(envName, ctx, logger), envModel);
});

// Extraction falls back to ctx.model when default is not found.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([envModel], [envModel]);
	assert.strictEqual(resolveExtractionModel(envName, ctx, logger), ctxModel);
});

// Extraction falls back to ctx.model when default has no auth.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([extractionDefault], []);
	assert.strictEqual(resolveExtractionModel(envName, ctx, logger), ctxModel);
});

// Extraction falls back to ctx.model when registry is missing.
withEnv(envName, undefined, () => {
	const ctx = { model: ctxModel, modelRegistry: undefined as any };
	assert.strictEqual(resolveExtractionModel(envName, ctx, logger), ctxModel);
});

// === resolveAdjudicationModel ===

// Adjudication default is a small/fast model (opencode-go/glm-4-flash), distinct from extraction.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([adjudicationDefault, extractionDefault], [adjudicationDefault]);
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), adjudicationDefault);
	assert.notStrictEqual(resolveAdjudicationModel(envName, ctx, logger), extractionDefault);
});

// Adjudication env override wins over the small/fast default.
withEnv(envName, "env-provider/env-model", () => {
	const ctx = makeCtx([envModel, adjudicationDefault], [envModel, adjudicationDefault]);
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), envModel);
});

// Adjudication falls back to ctx.model when small/fast default is not found.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([extractionDefault], [extractionDefault]);
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), ctxModel);
});

// Adjudication falls back to ctx.model when small/fast default has no configured auth.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([adjudicationDefault, extractionDefault], [extractionDefault]); // adjudicationDefault present but not authed
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), ctxModel);
});

// Adjudication falls back to ctx.model when registry is missing.
withEnv(envName, undefined, () => {
	const ctx = { model: ctxModel, modelRegistry: undefined as any };
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), ctxModel);
});

// Adjudication falls back to ctx.model when registry has empty model list.
withEnv(envName, undefined, () => {
	const ctx = makeCtx([], []);
	assert.strictEqual(resolveAdjudicationModel(envName, ctx, logger), ctxModel);
});

// Verify exported defaults match expected values.
assert.strictEqual(DEFAULT_EXTRACTION_MODEL, "opencode-go/glm-5.1");
assert.strictEqual(DEFAULT_ADJUDICATION_MODEL, "opencode-go/glm-4-flash");

console.log("test_resolve_careful_model passed!");
