import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	readMemoryModelOverride,
	resolveExtractionModel,
	writeMemoryModelOverride,
} from "../model-resolution.js";

console.log("Running test_model_override...");

type TestModel = { provider: string; id: string; name: string };

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const settingsPath = path.join(agentDir, "settings.json");
const previousSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : undefined;

const ctxModel: TestModel = { provider: "session", id: "current-model", name: "Current Model" };
const overrideModel: TestModel = { provider: "override-provider", id: "override-model", name: "Override Model" };
const envModel: TestModel = { provider: "env-provider", id: "env-model", name: "Env Model" };
const defaultModel: TestModel = { provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" };
const unauthedModel: TestModel = { provider: "override-provider", id: "unauthed-model", name: "Unauthed Model" };

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

function writeSettings(value: unknown) {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const envName = "PERSISTENT_MEMORY_TEST_MODEL_OVERRIDE";

try {
	// Valid persisted override beats env var and pinned default.
	writeSettings({ subagents: { models: { worker: "keep/worker" } }, persistentMemory: { keep: true } });
	writeMemoryModelOverride("extraction", "override-provider/override-model");
	withEnv(envName, "env-provider/env-model", () => {
		const ctx = makeCtx([overrideModel, envModel, defaultModel], [overrideModel, envModel, defaultModel]);
		assert.strictEqual(resolveExtractionModel(envName, ctx, { warn: () => undefined }), overrideModel);
	});
	assert.strictEqual(readMemoryModelOverride("extraction"), "override-provider/override-model");
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).subagents, { models: { worker: "keep/worker" } });

	// Unknown override warns and falls back to env var.
	writeSettings({ persistentMemory: { models: { extraction: "missing-provider/missing-model" } } });
	withEnv(envName, "env-provider/env-model", () => {
		const warnings: unknown[][] = [];
		const ctx = makeCtx([envModel, defaultModel], [envModel, defaultModel]);
		assert.strictEqual(resolveExtractionModel(envName, ctx, { warn: (...args) => warnings.push(args) }), envModel);
		assert.strictEqual(warnings.length, 1);
		assert.match(String(warnings[0][0]), /Persisted extraction model override "missing-provider\/missing-model" not found/);
	});

	// Unauthed override warns and falls back to pinned default when env is absent.
	writeSettings({ persistentMemory: { models: { extraction: "override-provider/unauthed-model" } } });
	withEnv(envName, undefined, () => {
		const warnings: unknown[][] = [];
		const ctx = makeCtx([unauthedModel, defaultModel], [defaultModel]);
		assert.strictEqual(resolveExtractionModel(envName, ctx, { warn: (...args) => warnings.push(args) }), defaultModel);
		assert.strictEqual(warnings.length, 1);
		assert.match(String(warnings[0][0]), /auth\/API key is not configured/);
	});

	// Absent override preserves current env/default behavior.
	writeSettings({ persistentMemory: { models: {} } });
	withEnv(envName, "env-provider/env-model", () => {
		const ctx = makeCtx([envModel, defaultModel], [envModel, defaultModel]);
		assert.strictEqual(resolveExtractionModel(envName, ctx, { warn: () => undefined }), envModel);
	});
	withEnv(envName, undefined, () => {
		const ctx = makeCtx([defaultModel], [defaultModel]);
		assert.strictEqual(resolveExtractionModel(envName, ctx, { warn: () => undefined }), defaultModel);
	});
} finally {
	if (previousSettings === undefined) {
		fs.rmSync(settingsPath, { force: true });
	} else {
		fs.writeFileSync(settingsPath, previousSettings, "utf-8");
	}
}

console.log("test_model_override passed!");
