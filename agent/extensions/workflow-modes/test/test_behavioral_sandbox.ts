import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectLauncher, wrapCommand } from "../sandbox.js";

console.log("Running test_behavioral_sandbox...");

const launcher = detectLauncher();
if (launcher === "none") {
	const unwrapped = wrapCommand("pwd", { cwd: process.cwd(), launcher: "none" });
	assert.strictEqual(unwrapped.command, "pwd");
	assert.strictEqual(unwrapped.wrapped, false);
	console.log("test_behavioral_sandbox skipped: no sandbox launcher available");
	process.exit(0);
}

const repoDir = mkdtempSync(join(tmpdir(), "pi-sandbox-repo-"));
const scratchDir = mkdtempSync(join(tmpdir(), "pi-sandbox-scratch-"));
const repoFile = join(repoDir, "README.md");
const repoWrite = join(repoDir, "write-attempt.txt");
writeFileSync(repoFile, "sandbox-readable\n", "utf8");

function runSandboxed(command: string) {
	const wrapped = wrapCommand(command, { cwd: repoDir, scratchDir, launcher });
	assert.strictEqual(wrapped.wrapped, true);
	return spawnSync("/bin/bash", ["-lc", wrapped.command], { encoding: "utf8", timeout: 10_000 });
}

try {
	{
		const result = runSandboxed("cat README.md");
		assert.strictEqual(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /sandbox-readable/);
	}

	{
		const result = runSandboxed("printf ok > \"$TMPDIR/scratch-write.txt\" && cat \"$TMPDIR/scratch-write.txt\"");
		assert.strictEqual(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /ok/);
	}

	{
		const result = runSandboxed("printf nope > write-attempt.txt");
		assert.notStrictEqual(result.status, 0, "repo write unexpectedly succeeded");
		assert.strictEqual(existsSync(repoWrite), false);
	}

	{
		const result = runSandboxed("python3 -c \"import socket; socket.create_connection(('example.com', 80), timeout=2)\"");
		assert.notStrictEqual(result.status, 0, "network connection unexpectedly succeeded");
	}

	{
		const result = runSandboxed("python3 -c \"from pathlib import Path; print(Path('README.md').read_text().strip())\"");
		assert.strictEqual(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /sandbox-readable/);
	}
} finally {
	rmSync(repoDir, { recursive: true, force: true });
	rmSync(scratchDir, { recursive: true, force: true });
}

console.log("test_behavioral_sandbox passed!");
