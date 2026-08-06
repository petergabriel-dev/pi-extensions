import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPlanFilePath, MAX_PLAN_BYTES, PLAN_RETENTION_MS, gcPlanFiles, readPlanFile, writePlanFile } from "../plan-file.js";

console.log("Running test_plan_file...");

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-plan-file-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	const expectedPath = path.join(agentDir, "plans", "session-a", "plan-a.md");
	assert.equal(getPlanFilePath("session-a", "plan-a"), expectedPath);
	assert.equal(await readPlanFile("session-a", "missing"), undefined);
	assert.equal(await writePlanFile("session-a", "plan-a", "# Plan A\n"), expectedPath);
	assert.equal(await readPlanFile("session-a", "plan-a"), "# Plan A\n");
	assert.deepEqual(await fs.readdir(path.dirname(expectedPath)), ["plan-a.md"]);

	await assert.rejects(() => writePlanFile("session-a", "too-large", "x".repeat(MAX_PLAN_BYTES + 1)), /exceeds/);
	const oversizedPath = path.join(agentDir, "plans", "session-a", "oversized.md");
	await fs.writeFile(oversizedPath, "x".repeat(MAX_PLAN_BYTES + 1));
	await assert.rejects(() => readPlanFile("session-a", "oversized"), /exceeds/);
	await assert.rejects(() => writePlanFile("../escape", "plan-a", "bad"), /path-safe/);
	await assert.rejects(() => writePlanFile("session-a", "../escape", "bad"), /path-safe/);

	const oldPath = await writePlanFile("session-b", "old", "old");
	const keptPath = await writePlanFile("session-b", "kept", "kept");
	const freshPath = await writePlanFile("session-b", "fresh", "fresh");
	const otherSessionPath = await writePlanFile("session-other", "old-other", "old-other");
	const now = Date.now();
	const oldTime = new Date(now - PLAN_RETENTION_MS - 1);
	await fs.utimes(oldPath, oldTime, oldTime);
	await fs.utimes(keptPath, oldTime, oldTime);
	await fs.utimes(otherSessionPath, oldTime, oldTime);
	const deleted = await gcPlanFiles("session-b", [{ planId: "kept" }], now);
	assert.deepEqual(deleted, [oldPath]);
	assert.equal(await readPlanFile("session-b", "old"), undefined);
	assert.equal(await readPlanFile("session-b", "kept"), "kept");
	assert.equal(await readPlanFile("session-b", "fresh"), "fresh");
	assert.equal(await readPlanFile("session-other", "old-other"), "old-other", "GC must not sweep another session");
	assert.deepEqual(await gcPlanFiles("session-b", [], now), [keptPath]);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await fs.rm(agentDir, { recursive: true, force: true });
}

console.log("test_plan_file passed");
