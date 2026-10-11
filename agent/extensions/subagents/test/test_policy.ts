import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BROWSER_PROXY_BUILD_TOOLS,
	MAX_SUBAGENT_DEPTH,
	subagentToolsMutateRepository,
	subagentToolsRequireBuild,
	validateSubagentAgentAllowlist,
	validateSubagentDepth,
	validateSubagentToolset,
} from "../policy.ts";
import { OwnershipLockManager, ownershipOverlaps } from "../ownership.ts";

assert.equal(subagentToolsRequireBuild(["read", "grep", "ask_question"]), false);
assert.equal(subagentToolsRequireBuild(["read", "powershell"]), true);
assert.equal(
	subagentToolsMutateRepository([
		" READ ",
		"grep",
		"find",
		"ls",
		"ASK_QUESTION",
		"SubAgent",
		...BROWSER_PROXY_BUILD_TOOLS.map((tool) => tool.toUpperCase()),
	]),
	false,
);
assert.equal(subagentToolsMutateRepository(["read", "unknown-tool"]), true);
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
assert.equal(ownershipOverlaps("C:\\repo\\src\\**", "C:\\repo\\src\\file.ts"), true);
assert.equal(ownershipOverlaps("src/a", "docs/a"), false);

const tempDir = mkdtempSync(join(tmpdir(), "subagent-ownership-"));
try {
	const cwd = join(tempDir, "project");
	const target = join(tempDir, "target");
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(target);
	symlinkSync(target, join(cwd, "alias"), "dir");

	const assertConflict = (existingPath: string, requestedPath: string): void => {
		const locks = new OwnershipLockManager();
		assert.deepEqual(locks.acquire("worker-a", [existingPath], cwd), { ok: true, paths: [existingPath] });
		const conflict = locks.acquire("worker-b", [requestedPath], cwd);
		assert.equal(conflict.ok, false, `${existingPath} should overlap ${requestedPath}`);
		assert.deepEqual(conflict.conflict, { owner: "worker-a", requestedPath, existingPath });
	};

	assertConflict("alias/a", join(target, "a"));
	assertConflict("./src/a", "src/a");
	assertConflict("src/../src/a", join(cwd, "src", "a"));
	assertConflict("src/a", "SRC/a");
	assertConflict("alias/new/deep.ts", join(target, "new", "deep.ts"));
	assertConflict("alias/**", join(target, "file.ts"));
	assertConflict("alias/*", join(target, "file.ts"));

	const locks = new OwnershipLockManager();
	assert.deepEqual(locks.acquire("worker-a", ["src/**"], cwd), { ok: true, paths: ["src/**"] });
	assert.equal(locks.acquire("worker-b", ["src/file.ts"], cwd).ok, false);
	locks.release("worker-a");
	assert.equal(locks.acquire("worker-b", ["src/file.ts"], cwd).ok, true);
	assert.equal(locks.acquire("worker-c", ["docs/a"], cwd).ok, true);
	assert.deepEqual(locks.snapshot(), { "worker-b": ["src/file.ts"], "worker-c": ["docs/a"] });

	const originalPaths = ["./src/a", "docs/**"];
	const snapshotLocks = new OwnershipLockManager();
	assert.deepEqual(snapshotLocks.acquire("worker-original", originalPaths, cwd), { ok: true, paths: originalPaths });
	assert.deepEqual(snapshotLocks.snapshot(), { "worker-original": originalPaths });
	assert.throws(() => snapshotLocks.acquire("worker-overflow", Array(101).fill("src/a"), cwd), /maximum of 100/);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
console.log("subagent policy tests passed");
