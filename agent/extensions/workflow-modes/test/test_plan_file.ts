import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gcEvidenceFiles, getPlanFilePath, MAX_PLAN_BYTES, PLAN_RETENTION_MS, gcPlanFiles, readPlanFile, writePlanFile } from "../plan-file.js";

console.log("Running test_plan_file...");

const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-plan-file-"));

try {
	const expectedPath = path.join(agentDir, "plans", "session-a", "plan-a.md");
	assert.equal(getPlanFilePath(agentDir, "session-a", "plan-a"), expectedPath);
	assert.equal(await readPlanFile(agentDir, "session-a", "missing"), undefined);
	assert.equal(await writePlanFile(agentDir, "session-a", "plan-a", "# Plan A\n"), expectedPath);
	assert.equal(await readPlanFile(agentDir, "session-a", "plan-a"), "# Plan A\n");
	assert.deepEqual(await fs.readdir(path.dirname(expectedPath)), ["plan-a.md"]);

	await assert.rejects(() => writePlanFile(agentDir, "session-a", "too-large", "x".repeat(MAX_PLAN_BYTES + 1)), /exceeds/);
	const oversizedPath = path.join(agentDir, "plans", "session-a", "oversized.md");
	await fs.writeFile(oversizedPath, "x".repeat(MAX_PLAN_BYTES + 1));
	await assert.rejects(() => readPlanFile(agentDir, "session-a", "oversized"), /exceeds/);
	await assert.rejects(() => writePlanFile(agentDir, "../escape", "plan-a", "bad"), /path-safe/);
	await assert.rejects(() => writePlanFile(agentDir, "session-a", "../escape", "bad"), /path-safe/);

	const oldPath = await writePlanFile(agentDir, "session-b", "old", "old");
	const keptPath = await writePlanFile(agentDir, "session-b", "kept", "kept");
	const freshPath = await writePlanFile(agentDir, "session-b", "fresh", "fresh");
	const otherSessionPath = await writePlanFile(agentDir, "session-other", "old-other", "old-other");
	const now = Date.now();
	const oldTime = new Date(now - PLAN_RETENTION_MS - 1);
	await fs.utimes(oldPath, oldTime, oldTime);
	await fs.utimes(keptPath, oldTime, oldTime);
	await fs.utimes(otherSessionPath, oldTime, oldTime);
	const deleted = await gcPlanFiles(agentDir, "session-b", [{ planId: "kept" }], now);
	assert.deepEqual(deleted, [oldPath]);
	assert.equal(await readPlanFile(agentDir, "session-b", "old"), undefined);
	assert.equal(await readPlanFile(agentDir, "session-b", "kept"), "kept");
	assert.equal(await readPlanFile(agentDir, "session-b", "fresh"), "fresh");
	assert.equal(await readPlanFile(agentDir, "session-other", "old-other"), "old-other", "GC must not sweep another session");
	assert.deepEqual(await gcPlanFiles(agentDir, "session-b", [], now), [keptPath]);

	// Evidence GC: old uncited bundles go; cited, recent, odd names, and reviews.jsonl stay.
	const evidenceDir = path.join(agentDir, "plans", "session-e", "evidence");
	await fs.mkdir(evidenceDir, { recursive: true });
	const bundle = (char: string) => path.join(evidenceDir, `${char.repeat(64)}.json`);
	for (const file of [bundle("a"), bundle("b"), bundle("c"), path.join(evidenceDir, "notes.json")]) await fs.writeFile(file, "{}");
	const reviewLog = path.join(agentDir, "plans", "session-e", "reviews.jsonl");
	await fs.writeFile(reviewLog, "");
	for (const file of [bundle("a"), bundle("b"), path.join(evidenceDir, "notes.json"), reviewLog]) await fs.utimes(file, oldTime, oldTime);
	assert.deepEqual(await gcEvidenceFiles(agentDir, "session-e", new Set(["b".repeat(64)]), now), [bundle("a")]);
	for (const kept of [bundle("b"), bundle("c"), path.join(evidenceDir, "notes.json"), reviewLog]) await fs.access(kept);
	assert.deepEqual(await gcEvidenceFiles(agentDir, "missing-session", new Set(), now), [], "missing evidence dir is a no-op");
	const linkedSession = path.join(agentDir, "plans", "session-link");
	await fs.mkdir(linkedSession, { recursive: true });
	await fs.symlink(evidenceDir, path.join(linkedSession, "evidence"));
	assert.deepEqual(await gcEvidenceFiles(agentDir, "session-link", new Set(), now), [], "a symlinked evidence dir is never swept");
	await assert.rejects(() => gcEvidenceFiles(agentDir, "../escape", new Set(), now), /path-safe/);
} finally {
	await fs.rm(agentDir, { recursive: true, force: true });
}

console.log("test_plan_file passed");
