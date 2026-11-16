// Focused test for bench/bench.ts. All state lives in a temp dir; no model, network, or ~/.pi writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as bridgeClient from "../agent/claude-bridge-client/pi-bridge-mcp.js";
import { CAP_MINUTES, checkTasks, claudeSlug, config, cursorModelFor, estimateCost, loadReviewFixture, matchFindings, note, parseDiffFindings, parseTap, prepare, REVIEW_TICK_NOTE, reviewPrepare, reviewRun, reviewScore, reviewStop, scrubEnv, score } from "./bench.ts";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCH_DIR, "..");

// Bundles of one fixture differ only by attempt id and timing. Timings also shift where the
// byte-bounded output tail starts, so tails are compared on the whole lines both end with.
function assertSameBundle(a: any, aRepo: string, b: any, bRepo: string) {
	const clean = (bundle: any, repo: string) => {
		const { attemptId: _attemptId, ...rest } = bundle;
		rest.commands = rest.commands.map(({ ms: _ms, ...command }: any) => ({
			...command,
			tail: String(command.tail).split(repo).join("<repo>").replace(/\(\d+(?:\.\d+)?ms\)/g, "(Nms)").replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms N").split("\n").slice(1),
		}));
		return rest;
	};
	const x = clean(a, aRepo);
	const y = clean(b, bRepo);
	x.commands.forEach((command: any, index: number) => {
		const other = y.commands[index];
		const keep = Math.min(command.tail.length, other?.tail.length ?? 0);
		command.tail = command.tail.slice(-keep || command.tail.length);
		if (other) other.tail = other.tail.slice(-keep || other.tail.length);
	});
	assert.deepEqual(x, y, "bundle content repeats except attempt id and timing");
}
const SK_TOKEN = `sk-benchtest${"Z9".repeat(10)}`;

async function write(file: string, text: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
}
const gitIn = (cwd: string, args: string[], env: Record<string, string> = {}) =>
	execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8", env: { ...scrubEnv(), ...env } as NodeJS.ProcessEnv }).trim();
const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;
async function rejects(fn: () => Promise<unknown>, pattern: RegExp) {
	await assert.rejects(fn, (error: Error) => pattern.test(error.message));
}

async function main() {
	console.log("Running test-bench...");
	const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "bench-test-")));
	const saved = { ...process.env };
	try {
		const benchRoot = path.join(root, "bench");
		const app = path.join(benchRoot, "fixture", "app");
		await write(path.join(app, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node --test test/*.test.ts" } }));
		await write(path.join(app, "src", "add.ts"), "export function add(a: number, b: number): number {\n\treturn a - b;\n}\n");
		await write(path.join(app, "test", "visible.test.ts"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.ts";\ntest("zero", () => assert.equal(add(4, 0), 4));\n');
		const t1 = path.join(benchRoot, "tasks", "t1");
		await write(path.join(t1, "task.json"), JSON.stringify({ category: "bug fix", budgetMinutes: 90, requirements: ["R1", "R2"] }));
		await write(path.join(t1, "SPEC.md"), "# Fix add\n\n- R1: add sums positive numbers.\n- R2: add sums negative numbers.\n");
		await write(path.join(t1, "start.patch"), "");
		await write(path.join(t1, "hidden", "test", "t1-hidden.test.ts"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.ts";\ntest("R1 sums positives", () => assert.equal(add(2, 3), 5));\ntest("R2 sums negatives", () => assert.equal(add(-2, -3), -5));\n');
		// solution.patch is a real git diff of the fix.
		const patchRepo = path.join(root, "patch-repo");
		await fs.cp(app, patchRepo, { recursive: true });
		gitIn(patchRepo, ["init", "-q"]);
		gitIn(patchRepo, ["add", "-A"]);
		gitIn(patchRepo, ["commit", "-q", "-m", "base"]);
		await fs.writeFile(path.join(patchRepo, "src", "add.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
		await write(path.join(t1, "solution.patch"), gitIn(patchRepo, ["diff"]) + "\n");
		await write(path.join(benchRoot, "PROTOCOL.md"), "# protocol\n");
		await write(path.join(benchRoot, "prices.json"), JSON.stringify({ asOf: "2026-11-16", models: { "openai-codex/gpt-6-luna": { input: 2, output: 8, cacheRead: 1, cacheWrite: 3 }, "anthropic/claude-opus-5-5": { input: null, output: null, cacheRead: null, cacheWrite: null } } }));

		const hostAgent = path.join(root, "host", "agent");
		await write(path.join(hostAgent, "auth.json"), "{}\n");
		const stubBin = path.join(root, "bin");
		for (const name of ["pi", "claude", "cursor-agent"]) {
			await write(path.join(stubBin, name), `#!/bin/sh\necho "${name} stub 1.0"\n`);
			await fs.chmod(path.join(stubBin, name), 0o755);
		}
		const claudeDir = path.join(root, "claude");
		process.env.BENCH_ROOT = benchRoot;
		process.env.PI_CODING_AGENT_DIR = hostAgent;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH}`;

		// scrubEnv drops Pi state, Git redirection, and credentials.
		const scrubbed = scrubEnv({ PI_X: "1", GIT_DIR: "/x", OPENAI_API_KEY: "k", GH_TOKEN: "t", AWS_SECRET: "s", PATH: "/bin", HOME: "/h" });
		assert.deepEqual(Object.keys(scrubbed).sort(), ["GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);

		assert.deepEqual([...parseTap("ok 1 - R1 a\n    not ok 2 - R2 b\nok 3 - R2 c\nok 4 - R3 d # SKIP\nok 5 - helper\n").entries()], [["R1", true], ["R2", false], ["R3", false]]);
		assert.equal(estimateCost({ "m/x": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }, { models: { "m/x": { input: 2, output: null } } }), 2);
		assert.equal(estimateCost({ "m/x": { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 } }, { models: { "m/x": { input: 2, output: null } } }), "unavailable");
		assert.equal(estimateCost(null, {}), "unavailable");

		// Refusals: runs dir inside the repo, missing host login.
		process.env.PI_BENCH_HOME = path.join(REPO_ROOT, "bench", "tmp-runs-must-not-exist");
		await rejects(() => prepare("t1", "A", "1"), /inside the repository/);
		assert.equal(existsSync(process.env.PI_BENCH_HOME), false);
		process.env.PI_BENCH_HOME = path.join(root, "runs");
		process.env.PI_CODING_AGENT_DIR = path.join(root, "no-host");
		await rejects(() => prepare("t1", "A", "1"), /no Pi login/);
		process.env.PI_CODING_AGENT_DIR = hostAgent;
		await rejects(() => prepare("t1", "D", "1"), /workflow must be/);

		const { runId, runDir } = await prepare("t1", "A", "1");
		assert.equal(runId, "t1-A-r1");
		const repo = path.join(runDir, "repo");
		const agentDir = path.join(runDir, "agent");
		assert.equal(await mode(config().runsDir), 0o700);
		assert.equal(await mode(runDir), 0o700);
		assert.equal(await mode(agentDir), 0o700);
		const authLink = path.join(agentDir, "auth.json");
		assert.ok((await fs.lstat(authLink)).isSymbolicLink(), "auth.json is a symlink, never a copy");
		assert.equal(await fs.readlink(authLink), path.join(hostAgent, "auth.json"));
		assert.ok(existsSync(path.join(repo, ".pi")));
		assert.match(await fs.readFile(path.join(repo, ".gitignore"), "utf8"), /^\.pi\/$/m);
		assert.equal(gitIn(repo, ["status", "--porcelain"]), "", "start state fully committed");
		const startSha = gitIn(repo, ["rev-parse", "start"]);
		const runJson = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
		assert.equal(runJson.versions.pi, "pi stub 1.0");
		assert.equal(runJson.startCommit, startSha);
		await rejects(() => prepare("t1", "A", "1"), /already exists/);

		// Note validation.
		await rejects(() => note(runId, "gate", ["too early"]), /no start note/);
		await note(runId, "start");
		await rejects(() => note(runId, "start"), /already started/);
		await rejects(() => note(runId, "handoff", ["later"]), /'wait' or 'go'/);
		await rejects(() => note(runId, "context-miss", ["missing"]), /requirement id/);
		await rejects(() => note(runId, "gate", ["x".repeat(501)]), /max 500/);
		await rejects(() => note(runId, "bogus"), /note kind/);
		await note(runId, "handoff", ["wait"]);
		await note(runId, "handoff", ["go"]);
		await note(runId, "gate", ["approved", "build", "lease"]);
		await note(runId, "context-miss", ["R2", "altered", "in", "plan"]);

		// Agent work: a fixing commit exactly at the cap (scored), then a breaking one a second later (ignored).
		const events = (await fs.readFile(path.join(runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const capSec = Math.floor((Date.parse(events[0].at) + CAP_MINUTES * 60_000) / 1000);
		await fs.writeFile(path.join(repo, "src", "add.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
		await fs.writeFile(path.join(repo, "notes.txt"), `debug key ${SK_TOKEN}\n`);
		gitIn(repo, ["add", "-A"]);
		gitIn(repo, ["commit", "-q", "-m", "fix"], { GIT_COMMITTER_DATE: `${capSec} +0000` });
		const fixSha = gitIn(repo, ["rev-parse", "HEAD"]);
		await fs.writeFile(path.join(repo, "src", "add.ts"), "export function add(a: number, b: number): number {\n\treturn a * b;\n}\n");
		gitIn(repo, ["commit", "-q", "-am", "late"], { GIT_COMMITTER_DATE: `${capSec + 1} +0000` });

		// Usage logs: Pi session (plus noise) and a Claude transcript with a repeated message id.
		const usage = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0.5 } };
		await write(path.join(agentDir, "sessions", "s", "a.jsonl"), [
			JSON.stringify({ type: "session", id: "s" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6-luna", usage } }),
			"not json",
			JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6-luna", usage } }),
		].join("\n"));
		await write(path.join(agentDir, "plans", "s", "p1.md"), `# plan\nUse ${SK_TOKEN} nowhere.\n`);
		const msg = (id: string, output: number, text = "") => JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", content: text, usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: output } } });
		await write(path.join(claudeDir, "projects", claudeSlug(repo), "t.jsonl"), [msg("m1", 5), msg("m1", 7, "peeked at bench/tasks/ folder"), msg("m2", 3)].join("\n"));

		const row = await score(runId) as any;
		assert.equal(row.scoredCommit, fixSha, "last commit at or before the cap is scored");
		assert.equal(row.commitsAfterCap, 1);
		assert.equal(row.pass, true);
		assert.deepEqual(row.requirements, { R1: true, R2: true });
		assert.ok(row.workflowFailures.includes("timeout"), "work after the cap marks timeout");
		assert.equal(row.wallClockMs, CAP_MINUTES * 60_000, "a timed-out run ends at the cap");
		assert.equal(row.agentMs, row.wallClockMs - row.handoffWaitMs);
		assert.deepEqual(row.tokens.pi, { "openai-codex/gpt-6-luna": { input: 200, output: 20, cacheRead: 100, cacheWrite: 0 } });
		assert.ok(Math.abs(row.cost.pi - (200 * 2 + 20 * 8 + 100 * 1) / 1_000_000) < 1e-12, `pi cost ${row.cost.pi}`);
		assert.equal(row.piEstimate, 1);
		assert.deepEqual(row.tokens.claude, { "anthropic/claude-opus-5-5": { input: 6, output: 10, cacheRead: 10, cacheWrite: 8 } }, "last line per message id wins");
		assert.equal(row.cost.claude, "unavailable", "null price -> unavailable");
		assert.equal(row.tokens.cursor, "not-used");
		assert.equal(row.contamination.flagged, true);
		assert.deepEqual(row.contamination.matches, [{ source: "claude", needle: "bench/tasks/" }]);
		assert.deepEqual(row.gates, ["approved build lease"]);
		assert.deepEqual(row.contextMisses, ["R2 altered in plan"]);
		assert.equal(row.pins.versions.claude, "claude stub 1.0");
		assert.ok(!JSON.stringify(row).includes(homedir()), "row carries no home paths");
		const patch = await fs.readFile(path.join(benchRoot, "results", "artifacts", `${runId}.patch`), "utf8");
		assert.ok(patch.includes("[REDACTED:pattern]") && !patch.includes(SK_TOKEN), "artifact diff is redacted");
		assert.ok(!(await fs.readFile(path.join(benchRoot, "results", "artifacts", `${runId}.plan-p1.md`), "utf8")).includes(SK_TOKEN), "plan artifact is redacted");
		assert.equal(existsSync(authLink), false, "auth symlink removed after score");
		assert.ok(existsSync(path.join(hostAgent, "auth.json")), "host login untouched");

		// Re-score appends; the first row is never rewritten.
		const results = path.join(benchRoot, "results", "coding.jsonl");
		const firstLine = (await fs.readFile(results, "utf8")).split("\n")[0];
		const again = await score(runId) as any;
		const lines = (await fs.readFile(results, "utf8")).split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		assert.equal(lines[0], firstLine);
		assert.equal(again.rescoreOf, row.scoredAt);
		assert.ok(existsSync(path.join(benchRoot, "results", "artifacts", `${runId}.s1.patch`)));

		// check-tasks: t1 is valid; a task whose hidden tests already pass is rejected.
		assert.equal(await checkTasks(), true);
		const t2 = path.join(benchRoot, "tasks", "t2");
		await fs.cp(t1, t2, { recursive: true });
		await fs.rename(path.join(t2, "hidden", "test", "t1-hidden.test.ts"), path.join(t2, "hidden", "test", "t2-hidden.test.ts"));
		await fs.writeFile(path.join(t2, "hidden", "test", "t2-hidden.test.ts"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("R1 trivially", () => assert.ok(true));\ntest("R2 trivially", () => assert.ok(true));\n');
		assert.equal(await checkTasks(), false, "hidden tests passing on start must fail check-tasks");

		// Review fixtures: a temp copy of the real fixture app and bench/review set, so results
		// stay out of the repository; runs in a temp runs dir; scripted model only.
		const reviewRoot = path.join(root, "bench-review");
		for (const dir of ["fixture", "review"]) await fs.cp(path.join(BENCH_DIR, dir), path.join(reviewRoot, dir), { recursive: true });
		process.env.BENCH_ROOT = reviewRoot;
		process.env.PI_BENCH_HOME = path.join(root, "review-runs");
		const fixture = await loadReviewFixture("r1");
		const first = await reviewPrepare("r1", "bundle", "1");
		let second;
		try {
			const bundle = JSON.parse(await fs.readFile(first.bundlePath!, "utf8"));
			const npmTest = bundle.commands.find((c: any) => c.cmd === "npm test");
			assert.ok(npmTest && npmTest.exit !== 0 && npmTest.exit !== null, "seeded fixture records a failing npm test");
			assert.equal(bundle.tickedBy, "pi");
			assert.deepEqual(bundle.warnings, []);
			const overview = await bridgeClient.callTool("recall_memory", { mode: "review", query: "review", cwd: first.repo, sessionId: "bench-test-reviewer", harness: "cursor" });
			const task = JSON.parse(overview.content[0].text).result.review.tasks[0];
			assert.equal(task.note, REVIEW_TICK_NOTE, "tick note is neutral");
			assert.equal(task.bundleId, first.bundleId);
			await rejects(() => reviewPrepare("r1", "bundle", "1"), /already exists/);
			second = await reviewPrepare("r1", "bundle", "2");
			const again = JSON.parse(await fs.readFile(second.bundlePath!, "utf8"));
			assertSameBundle(bundle, first.repo, again, second.repo);
		} finally {
			await first.stop();
			await second?.stop();
		}
		const diff = await reviewPrepare("r1", "diff", "1");
		assert.equal(diff.implTree, first.implTree, "both conditions review the same implementation tree");
		const prompt = await fs.readFile(path.join(diff.runDir, "prompt.md"), "utf8");
		assert.ok(prompt.includes("totalShipped") && prompt.includes("```diff"), "prompt carries SPEC and diff");
		for (const label of fixture.labels) assert.ok(!prompt.includes(label.defect), "labels never enter the prompt");
		assert.equal(gitIn(diff.repo, ["ls-files", "labels.json"]), "");
		await reviewStop("r1-bundle-r1");

		// Matching rule (PROTOCOL.md section 9).
		const labelA = { file: "src/a.ts", lines: [10, 12] as [number, number], defect: "a" };
		const matched = matchFindings([
			{ file: "src/a.ts", line: 7, text: "edge of range, -3" },
			{ file: "./src/a.ts", line: 15, text: "same label again, +3" },
			{ file: "src/a.ts", line: 16, text: "just outside" },
			{ file: "src/b.ts", line: 11, text: "other file" },
			{ text: "no file" },
			{ file: "src/a.ts", line: 11, text: "bad", invalid: "finding severity must be high, medium, or low" },
		], [labelA, { file: "src/c.ts", lines: [1, 1], defect: "c" }]);
		assert.deepEqual(matched.findings.map((f) => f.outcome), ["tp", "duplicate", "fp", "fp", "fp", "fp"]);
		assert.deepEqual({ tp: matched.tp, fp: matched.fp, fn: matched.fn, duplicates: matched.duplicates }, { tp: 1, fp: 4, fn: 1, duplicates: 1 });
		assert.equal(matched.findings[5].reason, "finding severity must be high, medium, or low");
		assert.deepEqual(matchFindings([{ file: "src/a.ts", line: 3, severity: "low", text: "nit" }], []), { findings: [{ file: "src/a.ts", line: 3, severity: "low", text: "nit", outcome: "fp", reason: "matches no label" }], tp: 0, fp: 1, duplicates: 0, fn: 0 }, "any finding on a correct fixture is a false positive");

		// Diff output parsing: Cursor's envelope, schema validation, and unusable output.
		const parsed = parseDiffFindings(JSON.stringify({ type: "result", result: 'Here you go:\n[{"file":"src/a.ts","line":2,"severity":"high","text":"x"},{"file":"src/a.ts","severity":"high","text":"y","title":"extra"}]' }), "a".repeat(40));
		assert.equal(parsed.findings.length, 2);
		assert.equal(parsed.findings[0].invalid, undefined);
		assert.match(parsed.findings[1].invalid ?? "", /unsupported field/);
		assert.match(parseDiffFindings("I found nothing worth reporting.", "a".repeat(40)).parseError ?? "", /no JSON array/);
		assert.throws(() => cursorModelFor(), /not pinned/);
		assert.equal(cursorModelFor("some-model"), "some-model");

		// Diff condition end to end through a stub cursor-agent.
		const envelope = JSON.stringify({ type: "result", result: JSON.stringify([{ file: "src/ledger.ts", line: 37, severity: "high", text: "adds negative quantities" }, { file: "src/cli.ts", line: 5, severity: "low", text: "nit" }]), usage: { inputTokens: 12, outputTokens: 3 } });
		await fs.writeFile(path.join(stubBin, "cursor-agent"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cursor-agent stub 1.0"; exit 0; fi\ncat <<'EOF'\n${envelope}\nEOF\n`);
		await reviewRun("r1-diff-r1", "stub-model");
		await rejects(() => reviewRun("r1-diff-r1", "stub-model"), /already reviewed/);
		const diffRow = await reviewScore("r1-diff-r1") as any;
		assert.deepEqual({ mode: diffRow.mode, model: diffRow.model, valid: diffRow.valid, tp: diffRow.tp, fp: diffRow.fp, fn: diffRow.fn }, { mode: "headless", model: "stub-model", valid: true, tp: 1, fp: 1, fn: 0 });
		assert.deepEqual(diffRow.usage, { inputTokens: 12, outputTokens: 3 });
		await rejects(() => reviewRun("r1-bundle-r1", "stub-model"), /Pi is not running/);

		// Bundle condition end to end over the real bridge: without reading evidence a review is
		// invalid; after reading it, the finding at the labeled line is a true positive.
		const reviewer = { sessionId: "bench-test-reviewer", harness: "cursor" };
		for (const [rep, reads] of [["3", false], ["4", true]] as const) {
			const handle = await reviewPrepare("r1", "bundle", rep);
			try {
				const ask = async (name: string, args: Record<string, unknown> = {}) => {
					const result = await bridgeClient.callTool(name, { ...args, cwd: handle.repo, ...reviewer });
					return result.structuredContent ?? JSON.parse(result.content[0].text);
				};
				const taskId = (await ask("read_plan_tasks")).result.tasks[0].id;
				const commit = gitIn(handle.repo, ["rev-parse", "HEAD"]);
				if (reads) await ask("read_task_evidence", { bundleId: handle.bundleId, section: "summary", page: 0 });
				await ask("submit_review_findings", { findings: [
					{ planId: "review", taskId, commit, file: "src/ledger.ts", line: 36, severity: "high", text: "Sums negative quantities, so the total is negative." },
					{ planId: "review", taskId, commit, file: "src/ledger.ts", line: 30, severity: "low", text: "Doc comment could mention the filter." },
				] });
				const row = await reviewScore(handle.runId) as any;
				assert.equal(row.mode, "interactive");
				assert.equal(row.valid, reads, reads ? "a review that read evidence is valid" : "missing review_started makes the review invalid");
				assert.deepEqual({ tp: row.tp, fp: row.fp, fn: row.fn }, { tp: 1, fp: 1, fn: 0 });
			} finally {
				await handle.stop();
			}
		}
		const reviewRows = (await fs.readFile(path.join(reviewRoot, "results", "review.jsonl"), "utf8")).split("\n").filter(Boolean);
		assert.equal(reviewRows.length, 3);
		assert.ok(!reviewRows.join("\n").includes(homedir()), "review rows carry no home paths");
		assert.equal(existsSync(path.join(BENCH_DIR, "results")), false, "the test never writes results into the repository");
		console.log("test-bench passed");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		await fs.rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
