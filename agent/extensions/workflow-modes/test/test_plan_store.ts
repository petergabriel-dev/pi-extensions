import assert from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { clearPlan, readPlan, resolvePlanPath, sanitizeBranchName, writePlan } from "../plan-store.js";

const execFile = promisify(execFileCallback);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-plan-store-"));
const homeDir = path.join(tempDir, "home");
const repoDir = path.join(tempDir, "repo");
const options = { cwd: repoDir, homeDir, branch: "feature/durable-plans" };

console.log("Running test_plan_store...");

try {
	await fs.mkdir(repoDir, { recursive: true });
	await execFile("git", ["init", "--initial-branch=main"], { cwd: repoDir });
	await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	await execFile("git", ["config", "user.name", "Test"], { cwd: repoDir });
	await fs.writeFile(path.join(repoDir, "README.md"), "test\n");
	await execFile("git", ["add", "."], { cwd: repoDir });
	await execFile("git", ["commit", "-m", "initial"], { cwd: repoDir });

	const target = await resolvePlanPath(options);
	assert.match(target, /plans\/--.*repo--\/feature-durable-plans\.md$/);
	assert.deepStrictEqual(await writePlan("# Plan\nKeep this exact.", { ...options, planId: "plan-1", savedAt: "2026-07-14T00:00:00.000Z" }), {
		planId: "plan-1",
		savedAt: "2026-07-14T00:00:00.000Z",
		plan: "# Plan\nKeep this exact.",
	});
	assert.deepStrictEqual(await readPlan(options), {
		planId: "plan-1",
		savedAt: "2026-07-14T00:00:00.000Z",
		plan: "# Plan\nKeep this exact.",
	});
	await clearPlan(options);
	assert.strictEqual(await readPlan(options), null);

	assert.strictEqual(sanitizeBranchName("feature/child"), "feature-child");
	assert.throws(() => sanitizeBranchName("../../escape"), /invalid branch name/);

	await execFile("git", ["checkout", "--detach"], { cwd: repoDir });
	assert.match(await resolvePlanPath({ cwd: repoDir, homeDir }), /detached-[0-9a-f]+\.md$/);

	const nonGitDir = path.join(tempDir, "not-git");
	await fs.mkdir(nonGitDir);
	assert.match(await resolvePlanPath({ cwd: nonGitDir, homeDir }), /not-git--\/no-git\.md$/);

	const blockedHome = path.join(tempDir, "blocked-home");
	await fs.writeFile(path.join(tempDir, "blocked-home"), "not a directory");
	await assert.rejects(() => writePlan("plan", { cwd: repoDir, homeDir: blockedHome, branch: "main", planId: "plan-2" }));
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("test_plan_store passed!");
