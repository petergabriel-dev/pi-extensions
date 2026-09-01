import assert from "node:assert/strict";

import {
	MAX_SUBAGENT_DEPTH,
	subagentToolsRequireBuild,
	validateSubagentAgentAllowlist,
	validateSubagentDepth,
	validateSubagentToolset,
} from "../policy.ts";
import { OwnershipLockManager, ownershipOverlaps } from "../ownership.ts";

assert.equal(subagentToolsRequireBuild(["read", "grep", "ask_question"]), false);
assert.equal(subagentToolsRequireBuild(["read", "powershell"]), true);
assert.equal(
	validateSubagentToolset(
		["read", "grep", "find", "ls", "ask_question", "browser_console", "browser_screenshot", "browser_network"],
		"discuss",
	),
	undefined,
);
for (const tool of ["bash", "edit", "write", "powershell"]) {
	assert.match(validateSubagentToolset(["read", tool], "discuss") ?? "", new RegExp(tool));
}
assert.match(validateSubagentToolset(["read", "powershell"], "discuss") ?? "", /outside Build mode/);
assert.equal(validateSubagentToolset(["read", "powershell"], "build"), undefined);

assert.equal(validateSubagentAgentAllowlist(["explorer"], "explorer"), undefined);
assert.match(validateSubagentAgentAllowlist(["explorer"], "worker") ?? "", /allowed child agents/);
assert.match(validateSubagentAgentAllowlist(undefined, "worker") ?? "", /no child agent allowlist/);
assert.equal(validateSubagentDepth(MAX_SUBAGENT_DEPTH), undefined);
assert.match(validateSubagentDepth(MAX_SUBAGENT_DEPTH + 1) ?? "", /exceeds maximum/);
assert.match(validateSubagentDepth(-1) ?? "", /non-negative/);
assert.equal(ownershipOverlaps("src/**", "src/file.ts"), true);
assert.equal(ownershipOverlaps("src/a", "docs/a"), false);

const locks = new OwnershipLockManager();
assert.deepEqual(locks.acquire("worker-a", ["src/**"]), { ok: true, paths: ["src/**"] });
const conflict = locks.acquire("worker-b", ["src/file.ts"]);
assert.equal(conflict.ok, false);
assert.equal(conflict.conflict?.owner, "worker-a");
locks.release("worker-a");
assert.equal(locks.acquire("worker-b", ["src/file.ts"]).ok, true);
assert.deepEqual(locks.snapshot(), { "worker-b": ["src/file.ts"] });
console.log("subagent policy tests passed");
