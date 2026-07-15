import assert from "node:assert/strict";

import subagentsExtension, { createNestedExplorerTool } from "../index.ts";
import {
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_MAX_TOTAL_MS,
	resolveSubagentTimeoutPolicy,
} from "../timeout-policy.ts";

type ToolSchema = { properties?: Record<string, unknown> };
type RegisteredTool = { name: string; parameters: ToolSchema };

const defaults = { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, maxTotalMs: DEFAULT_MAX_TOTAL_MS };

assert.deepEqual(resolveSubagentTimeoutPolicy(undefined), defaults);
assert.deepEqual(resolveSubagentTimeoutPolicy({ idleTimeoutMs: 900_000, maxTotalMs: 1_800_000 }), {
	idleTimeoutMs: 900_000,
	maxTotalMs: 1_800_000,
});
for (const settings of [
	{ idleTimeoutMs: "600000", maxTotalMs: 1_200_000 },
	{ idleTimeoutMs: 600_000.5, maxTotalMs: 1_200_000 },
	{ idleTimeoutMs: 4_999, maxTotalMs: 1_200_000 },
	{ idleTimeoutMs: 600_000, maxTotalMs: 7_200_001 },
	{ idleTimeoutMs: 1_200_000, maxTotalMs: 600_000 },
]) {
	assert.deepEqual(resolveSubagentTimeoutPolicy(settings), defaults);
}

const tools = new Map<string, RegisteredTool>();
subagentsExtension({
	registerCommand() {},
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
} as never);

function assertNoRoleTimeoutFields(toolName: string, schema: ToolSchema): void {
	for (const field of ["timeoutMs", "idleTimeoutMs", "maxTotalMs"]) {
		assert.equal(Object.hasOwn(schema.properties ?? {}, field), false, `${toolName} exposes ${field}`);
	}
}

for (const toolName of ["spawn_explorer", "spawn_worker", "subagents_debug_run_agent"]) {
	const tool = tools.get(toolName);
	assert.ok(tool, `${toolName} registered`);
	assertNoRoleTimeoutFields(toolName, tool.parameters);
}

const nestedExplorer = createNestedExplorerTool({ cwd: process.cwd() } as never, undefined, 1);
assertNoRoleTimeoutFields("nested spawn_explorer", nestedExplorer.parameters as ToolSchema);
assert.equal(Object.hasOwn(tools.get("subagents_inprocess_spike")?.parameters.properties ?? {}, "timeoutMs"), true);

console.log("subagent timeout policy tests passed");
