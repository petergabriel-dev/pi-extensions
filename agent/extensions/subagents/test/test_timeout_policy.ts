import assert from "node:assert/strict";

import subagentsExtension, { BROWSER_PROXY_BUILD_TOOLS, BROWSER_PROXY_READ_ONLY_TOOLS, augmentBrowserProxyTools, browserProxyToolNames } from "../index.ts";
import {
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_MAX_TOTAL_MS,
	resolveSubagentTimeoutPolicy,
} from "../timeout-policy.ts";

type ToolSchema = { properties?: Record<string, unknown> };
type RegisteredTool = { name: string; parameters: ToolSchema };

const defaults = { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, maxTotalMs: DEFAULT_MAX_TOTAL_MS };

assert.deepEqual(browserProxyToolNames("build"), [...BROWSER_PROXY_BUILD_TOOLS]);
assert.deepEqual(browserProxyToolNames("discuss"), [...BROWSER_PROXY_READ_ONLY_TOOLS]);
assert.deepEqual(browserProxyToolNames(undefined), [...BROWSER_PROXY_READ_ONLY_TOOLS]);
assert.deepEqual(augmentBrowserProxyTools(["read", "browser_console"], BROWSER_PROXY_READ_ONLY_TOOLS), ["read", "browser_console", "browser_screenshot", "browser_network"]);
assert.deepEqual(augmentBrowserProxyTools(undefined, BROWSER_PROXY_BUILD_TOOLS), ["read", "grep", "find", "ls", ...BROWSER_PROXY_BUILD_TOOLS]);

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
	on() {},
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

for (const toolName of ["subagent", "subagents_list"]) {
	const tool = tools.get(toolName);
	assert.ok(tool, `${toolName} registered`);
}
assertNoRoleTimeoutFields("subagent", tools.get("subagent")!.parameters);
assert.deepEqual([...tools.keys()].sort(), ["subagent", "subagents_list"]);

console.log("subagent timeout policy tests passed");
