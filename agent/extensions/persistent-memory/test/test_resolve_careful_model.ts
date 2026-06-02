import assert from "node:assert";
import { resolveCarefulModel } from "../model-resolution.js";

console.log("Running test_resolve_careful_model...");

type TestModel = { provider: string; id: string; name: string };

const ctxModel: TestModel = { provider: "session", id: "current-model", name: "Current Model" };
const envModel: TestModel = { provider: "env-provider", id: "env-model", name: "Env Model" };
const defaultModel: TestModel = { provider: "opencode-go", id: "glm-5.1", name: "GLM 5.1" };

function makeCtx(models: TestModel[], authedModels: TestModel[]) {
	return {
		model: ctxModel,
		modelRegistry: {
			getAll: () => models,
			hasConfiguredAuth: (model: TestModel) => authedModels.includes(model),
		},
	};
}

function withEnv(value: string | undefined, run: () => void) {
	const envName = "PERSISTENT_MEMORY_TEST_MODEL";
	const previous = process.env[envName];
	try {
		if (value === undefined) {
			delete process.env[envName];
		} else {
			process.env[envName] = value;
		}
		run();
	} finally {
		if (previous === undefined) {
			delete process.env[envName];
		} else {
			process.env[envName] = previous;
		}
	}
}

const logger = { warn: () => undefined };
const envName = "PERSISTENT_MEMORY_TEST_MODEL";

// Env override takes precedence over the pinned default.
withEnv("env-provider/env-model", () => {
	const ctx = makeCtx([envModel, defaultModel], [envModel, defaultModel]);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), envModel);
});

// Unset env resolves to the pinned default when it is present and authed.
withEnv(undefined, () => {
	const ctx = makeCtx([defaultModel], [defaultModel]);
	const infoMessages: unknown[][] = [];
	assert.strictEqual(resolveCarefulModel(envName, ctx, { ...logger, info: (...args) => infoMessages.push(args) }), defaultModel);
	assert.deepStrictEqual(infoMessages, [["[persistent-memory] Resolved careful model for PERSISTENT_MEMORY_TEST_MODEL: opencode-go/glm-5.1."]]);
});

// Unset env falls back to ctx.model when the pinned default is not found.
withEnv(undefined, () => {
	const ctx = makeCtx([envModel], [envModel]);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), ctxModel);
});

// Unset env falls back to ctx.model when the pinned default is present but auth is not configured.
withEnv(undefined, () => {
	const ctx = makeCtx([defaultModel], []);
	assert.strictEqual(resolveCarefulModel(envName, ctx, logger), ctxModel);
});

console.log("test_resolve_careful_model passed!");
