import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import cccSearchExtension, { buildCccSearchArgs, MAX_OUTPUT_BYTES, runCccSearch } from "../index.js";

console.log("Running test_ccc_search...");

let registeredTool: { name?: string; description?: string } | undefined;
cccSearchExtension({ registerTool: (tool: typeof registeredTool) => { registeredTool = tool; } } as never);
assert.equal(registeredTool?.name, "ccc_search");
assert.match(registeredTool?.description ?? "", /without invoking a shell/);

assert.deepEqual(buildCccSearchArgs({ query: "auth middleware" }), [
	"search", "--offset", "0", "--limit", "10", "--", "auth middleware",
]);
assert.deepEqual(buildCccSearchArgs({
	query: "token; touch /tmp/pwned",
	languages: ["typescript", "python"],
	path: "src/**/*.ts",
	offset: 5,
	limit: 20,
	refresh: true,
}), [
	"search",
	"--lang", "typescript",
	"--lang", "python",
	"--path", "src/**/*.ts",
	"--offset", "5",
	"--limit", "20",
	"--refresh",
	"--",
	"token; touch /tmp/pwned",
]);

assert.throws(() => buildCccSearchArgs({ query: " " }), /query must not be empty/);
assert.throws(() => buildCccSearchArgs({ query: "x".repeat(1_001) }), /at most 1000/);
assert.throws(() => buildCccSearchArgs({ query: "x\0y" }), /null bytes/);
assert.throws(() => buildCccSearchArgs({ query: "x", offset: -1 }), /offset must be an integer/);
assert.throws(() => buildCccSearchArgs({ query: "x", limit: 101 }), /limit must be an integer/);
assert.throws(() => buildCccSearchArgs({ query: "x", languages: Array(21).fill("ts") }), /at most 20/);
assert.throws(() => buildCccSearchArgs({ query: "x", languages: [" "] }), /language must not be empty/);
assert.throws(() => buildCccSearchArgs({ query: "x", languages: ["--path"] }), /unsupported characters/);
assert.throws(() => buildCccSearchArgs({ query: "x", path: "/etc/passwd" }), /project-relative/);
assert.throws(() => buildCccSearchArgs({ query: "x", path: "--refresh" }), /project-relative/);
assert.throws(() => buildCccSearchArgs({ query: "x", path: "src/../secret" }), /must not traverse/);

const fixtureDir = mkdtempSync(join(tmpdir(), "ccc-search-test-"));
const fakeCcc = join(fixtureDir, "ccc");
const fakeEnv = { ...process.env, PATH: `${fixtureDir}${delimiter}${process.env.PATH ?? ""}` };

function installFakeCcc(body: string): void {
	writeFileSync(fakeCcc, `#!/usr/bin/env node\n${body}\n`, "utf8");
	chmodSync(fakeCcc, 0o755);
}

try {
	installFakeCcc(`process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
	const metacharResult = await runCccSearch({ query: "$(touch /tmp/pwned); echo nope" }, { cwd: fixtureDir, env: fakeEnv });
	assert.equal(metacharResult.ok, true);
	assert.deepEqual(JSON.parse(metacharResult.stdout), [
		"search", "--offset", "0", "--limit", "10", "--", "$(touch /tmp/pwned); echo nope",
	]);

	const missingResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: { ...process.env, PATH: "/nonexistent" } });
	assert.equal(missingResult.failureKind, "missing_executable");
	assert.match(missingResult.error!, /not found on PATH/);

	installFakeCcc(`process.stderr.write("Error: Not in an initialized project directory"); process.exit(1);`);
	const uninitializedResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: fakeEnv });
	assert.equal(uninitializedResult.failureKind, "uninitialized");
	assert.match(uninitializedResult.error!, /Build mode/);
	assert.match(uninitializedResult.stderr, /Not in an initialized project directory/);

	installFakeCcc(`process.stdout.write("partial stdout"); process.stderr.write("failure detail"); process.exit(7);`);
	const failedResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: fakeEnv });
	assert.equal(failedResult.failureKind, "exit");
	assert.equal(failedResult.exitCode, 7);
	assert.equal(failedResult.stdout, "partial stdout");
	assert.equal(failedResult.stderr, "failure detail");

	installFakeCcc(`process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES + 1}));`);
	const oversizedResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: fakeEnv });
	assert.equal(oversizedResult.failureKind, "output_limit");

	const pidPath = join(fixtureDir, "child.pid");
	installFakeCcc(`require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1_000);`);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const cancelledResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: fakeEnv, signal: controller.signal, timeoutMs: 5_000 });
	assert.equal(cancelledResult.failureKind, "cancelled");
	assert.ok(cancelledResult.durationMs < 2_000, `cancellation took ${cancelledResult.durationMs} ms`);
	const cancelledPid = Number(readFileSync(pidPath, "utf8"));
	let childAlive = true;
	for (let attempt = 0; attempt < 20 && childAlive; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		try {
			process.kill(cancelledPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") childAlive = false;
			else throw error;
		}
	}
	assert.equal(childAlive, false, "cancelled ccc child process remained alive");

	const timedOutResult = await runCccSearch({ query: "x" }, { cwd: fixtureDir, env: fakeEnv, timeoutMs: 50 });
	assert.equal(timedOutResult.failureKind, "timeout");
	assert.ok(timedOutResult.durationMs < 2_000, `timeout took ${timedOutResult.durationMs} ms`);
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}

console.log("test_ccc_search passed!");
