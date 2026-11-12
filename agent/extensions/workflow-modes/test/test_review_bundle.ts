import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { openAttempt } from "../review-capture.js";
import { buildEvidenceBundle, evidenceDir, MAX_BUNDLE_BYTES, MAX_BUNDLE_HUNK_BYTES, outsideTaskFiles, writeEvidenceBundle } from "../review-bundle.js";
import { readReviewLog } from "../review-store.js";

console.log("Running test_review_bundle...");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-bundle-"));
const agentDir = path.join(root, "agent");
const GH_TOKEN = `ghp_${"Z9".repeat(18)}`;
const ENV_SECRET = "deploy-secret-value-42";
const env = { DEPLOY_TOKEN: ENV_SECRET };

function makeRepo(name: string): { dir: string; git: (...args: string[]) => string; commit: (message: string) => string } {
	const dir = path.join(root, name);
	execFileSync("mkdir", ["-p", dir]);
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	const commit = (message: string) => {
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message);
		return git("rev-parse", "HEAD");
	};
	return { dir, git, commit };
}

try {
	// outsideTaskFiles: exact, directory prefix, and globs.
	assert.deepEqual(outsideTaskFiles("a.txt, src/, docs/**/*.md, lib/*.ts", ["a.txt", "src/x/y.ts", "docs/a/b.md", "lib/k.ts", "lib/deep/k.ts", "other.ts"]), ["lib/deep/k.ts", "other.ts"]);
	assert.deepEqual(outsideTaskFiles(undefined, ["anything"]), []);
	assert.deepEqual(outsideTaskFiles("agent/extensions/workflow-modes", ["agent/extensions/workflow-modes/index.ts"]), [], "bare directory pattern covers its files");

	const repo = makeRepo("repo");
	await fs.writeFile(path.join(repo.dir, "a.txt"), "one\n");
	await fs.writeFile(path.join(repo.dir, "old.txt"), "rename me please, this content is long enough to be detected\n");
	const base = repo.commit("base");
	await fs.writeFile(path.join(repo.dir, "a.txt"), `one\ntwo ${GH_TOKEN}\nthree ${ENV_SECRET}\n`);
	await fs.mkdir(path.join(repo.dir, "src"));
	await fs.writeFile(path.join(repo.dir, "src/new.ts"), "export const x = 1;\n");
	await fs.writeFile(path.join(repo.dir, ".env"), `API_KEY=${GH_TOKEN}\n`);
	await fs.rename(path.join(repo.dir, "old.txt"), path.join(repo.dir, "moved.txt"));
	await fs.writeFile(path.join(repo.dir, `notes-${ENV_SECRET}.txt`), "named after a secret\n");
	const head = repo.commit("task");

	const attempt = openAttempt({ attemptId: "attempt-1", sessionId: "s1", planId: "plan-1", taskId: "task-1", startedAt: 0 });
	attempt.baseline = base;
	attempt.commands.push({ cmd: "npm test", exit: 1, ms: 5, tail: "fail" });
	attempt.redactions = 2;

	// Content: statuses, sensitive-path hunk drop, redaction, Files warnings, attempt evidence.
	const bundle = await buildEvidenceBundle({ cwd: repo.dir, planId: "plan-1", taskId: "task-1", by: "pi", commit: head, attempt, taskFiles: "a.txt, src/", env });
	assert.equal(bundle.baseline, base);
	assert.equal(bundle.commit, head);
	assert.deepEqual(bundle.files.map((file) => [file.status, file.path, file.from]).sort(), [["A", ".env", undefined], ["A", "notes-[REDACTED:env].txt", undefined], ["A", "src/new.ts", undefined], ["M", "a.txt", undefined], ["R", "moved.txt", "old.txt"]].sort(), "file paths are redacted");
	assert.deepEqual(bundle.hunks.map((hunk) => hunk.path).sort(), ["a.txt", "moved.txt", "notes-[REDACTED:env].txt", "src/new.ts"], "sensitive path hunk omitted");
	assert.ok(bundle.warnings.includes("omitted: hunks for sensitive path .env"));
	assert.ok(bundle.warnings.includes("outside task Files: .env") && bundle.warnings.includes("outside task Files: moved.txt"));
	assert.ok(!bundle.warnings.some((warning) => warning.includes("a.txt") || warning.includes("src/new.ts")));
	const serialized = JSON.stringify(bundle);
	assert.ok(!serialized.includes(GH_TOKEN) && !serialized.includes(ENV_SECRET), "bundle text is redacted");
	assert.ok(bundle.hunks.find((hunk) => hunk.path === "a.txt")!.text.includes("+two [REDACTED:pattern]"));
	assert.ok(bundle.redactions >= 4, "attempt and bundle redactions are counted");
	assert.deepEqual(bundle.commands, attempt.commands);

	// Write-once, content-addressed, private, logged.
	const written = await writeEvidenceBundle(agentDir, "s1", bundle);
	assert.equal(written.written, true);
	const bytes = await fs.readFile(written.path);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), written.bundleId, "id is the sha256 of the stored bytes");
	assert.ok(!bytes.includes(GH_TOKEN) && !bytes.includes(ENV_SECRET), "secrets absent from file bytes");
	assert.ok(bytes.length <= MAX_BUNDLE_BYTES);
	assert.equal((await fs.stat(written.path)).mode & 0o777, 0o600);
	assert.equal((await fs.stat(evidenceDir(agentDir, "s1"))).mode & 0o777, 0o700);
	const again = await writeEvidenceBundle(agentDir, "s1", bundle);
	assert.deepEqual([again.bundleId, again.written], [written.bundleId, false], "identical bundle is a no-op");
	const changed = await writeEvidenceBundle(agentDir, "s1", { ...bundle, warnings: [...bundle.warnings, "extra"] });
	assert.notEqual(changed.bundleId, written.bundleId);
	assert.ok((await fs.readFile(written.path)).equals(bytes), "different content never overwrites");
	const created = (await readReviewLog(agentDir, "s1")).events.filter((event) => event.ev === "bundle_created");
	assert.deepEqual(created.map((event) => event.bundleId), [written.bundleId, changed.bundleId]);
	assert.equal(created[0].commit, head);

	// Bridge tick without a Pi attempt: git-only with an explicit unavailable warning.
	const bridge = await buildEvidenceBundle({ cwd: repo.dir, planId: "plan-1", taskId: "task-1", by: "claude:peer-1", commit: head, env });
	assert.ok(bridge.warnings.some((warning) => warning.startsWith("unavailable: harness build commands")));
	assert.ok(bridge.warnings.includes("baseline inferred as the commit's parent"));
	assert.equal(bridge.baseline, base);
	assert.deepEqual(bridge.commands, []);
	assert.equal(bridge.files.length, 5, "git-only evidence still lists changes");

	// Pi tick with no attempt, no commit supplied: diff to HEAD, incomplete capture.
	const noCommit = await buildEvidenceBundle({ cwd: repo.dir, planId: "plan-1", taskId: "task-1", by: "pi", env });
	assert.equal(noCommit.commit, head);
	assert.ok(noCommit.warnings.includes("commit not supplied; diffed to HEAD at tick"));
	assert.ok(noCommit.warnings.some((warning) => warning.startsWith("incomplete: no captured attempt")));

	// Root commit: no parent, diffed against an empty tree.
	const rootRepo = makeRepo("root-repo");
	await fs.writeFile(path.join(rootRepo.dir, "first.txt"), "first\n");
	const first = rootRepo.commit("first");
	const rootBundle = await buildEvidenceBundle({ cwd: rootRepo.dir, planId: "plan-1", taskId: "task-1", by: "pi", commit: first, env });
	assert.deepEqual(rootBundle.files.map((file) => [file.status, file.path]), [["A", "first.txt"]]);
	assert.ok(rootBundle.hunks[0]?.text.includes("+first"));
	assert.ok(rootBundle.warnings.some((warning) => warning.startsWith("baseline unavailable")));

	// Caps: hunk bytes, then the whole-bundle byte limit.
	const bigRepo = makeRepo("big-repo");
	await fs.writeFile(path.join(bigRepo.dir, "seed.txt"), "seed\n");
	const bigBase = bigRepo.commit("seed");
	for (let index = 0; index < 3; index += 1) await fs.writeFile(path.join(bigRepo.dir, `big-${index}.txt`), `${"line of text\n".repeat(6000)}`);
	const bigHead = bigRepo.commit("big");
	const bigAttempt = openAttempt({ attemptId: "attempt-big", sessionId: "s1", planId: "plan-1", taskId: "task-1", startedAt: 0 });
	bigAttempt.baseline = bigBase;
	for (let index = 0; index < 50; index += 1) bigAttempt.commands.push({ cmd: "c".repeat(2000), exit: 1, ms: 1, tail: "t".repeat(2000) });
	for (let index = 0; index < 20; index += 1) bigAttempt.subagents.push({ owner: `w${index}`, agentName: "worker", status: "done", startedAt: 1, finishedAt: 2, tools: {}, files: [], failedCommands: Array.from({ length: 10 }, () => ({ cmd: "x".repeat(2000), exit: 1, tail: "y".repeat(2000) })), droppedFiles: 0, droppedFailedCommands: 0 });
	const big = await buildEvidenceBundle({ cwd: bigRepo.dir, planId: "plan-1", taskId: "task-1", by: "pi", commit: bigHead, attempt: bigAttempt, env });
	assert.ok(big.hunks.reduce((total, hunk) => total + Buffer.byteLength(hunk.text), 0) <= MAX_BUNDLE_HUNK_BYTES);
	assert.ok(big.warnings.some((warning) => warning.startsWith("truncated: hunks for big-")), "the hunk that crosses the cap is truncated");
	assert.ok(big.warnings.includes(`truncated: hunks for 1 file(s) omitted after ${MAX_BUNDLE_HUNK_BYTES} bytes`), "files past the hunk cap are skipped, not diffed");
	assert.ok(big.hunks.every((hunk) => hunk.text.length > 0), "no empty hunks");
	assert.ok(big.warnings.some((warning) => /dropped to fit/.test(warning)));
	const bigWritten = await writeEvidenceBundle(agentDir, "s-big", big);
	assert.ok((await fs.stat(bigWritten.path)).size <= MAX_BUNDLE_BYTES);

	// Not a git repository: explicit unavailable warning, no throw.
	const plain = path.join(root, "plain");
	await fs.mkdir(plain);
	const noGit = await buildEvidenceBundle({ cwd: plain, planId: "plan-1", taskId: "task-1", by: "pi", env });
	assert.ok(noGit.warnings.includes("unavailable: git (no commit or HEAD)"));
	assert.deepEqual(noGit.files, []);

	// The tick survives a bundle failure (evidence directory blocked by a file).
	const tickRepo = makeRepo("tick-repo");
	await fs.writeFile(path.join(tickRepo.dir, "t.txt"), "t\n");
	const tickHead = tickRepo.commit("t");
	const tickAgentDir = path.join(root, "tick-agent");
	await fs.mkdir(path.join(tickAgentDir, "plans", "session-tick"), { recursive: true });
	await fs.writeFile(path.join(tickAgentDir, "plans", "session-tick", "evidence"), "not a directory");
	const stubs = path.join(root, "stubs");
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-coding-agent"), { recursive: true });
	await fs.mkdir(path.join(stubs, "@earendil-works/pi-tui"), { recursive: true });
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-coding-agent/index.js"), "exports.DynamicBorder = class {}; exports.getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\n");
	await fs.writeFile(path.join(stubs, "@earendil-works/pi-tui/index.js"), "exports.Container = class {}; exports.matchesKey = () => false; exports.SelectList = class {}; exports.Text = class {}; exports.truncateToWidth = value => value; exports.wrapTextWithAnsi = value => [value];\n");
	const source = `
import assert from "node:assert/strict";
import workflowModesExtension, { PLAN_ENTRY } from "./index.ts";
const branch = [];
const listeners = new Map();
const events = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); }, emit(name, payload) { for (const handler of listeners.get(name) ?? []) handler(payload); } };
const handlers = new Map();
const tools = new Map();
const pi = { events, on(name, handler) { handlers.set(name, handler); }, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(type, data) { branch.push({ type: "custom", customType: type, data }); }, sendUserMessage() {}, sendMessage() {} };
workflowModesExtension(pi);
const ctx = { cwd: ${JSON.stringify(tickRepo.dir)}, hasUI: false, sessionManager: { getBranch: () => branch, getSessionId: () => "session-tick" }, ui: { setStatus() {}, notify() {} } };
(async () => {
	await handlers.get("session_start")({}, ctx);
	await new Promise((resolve) => { events.on("workflow-modes:save-plan-result", resolve); events.emit("workflow-modes:save-plan", { requestId: "s", planId: "plan-tick", plan: "# P\\n\\n## Section 4 — Tasks\\n- [ ] Only\\n" }); });
	const result = await tools.get("workflow_plan_tick").execute("t", { title: "Only", commit: ${JSON.stringify(tickHead)} }, undefined, undefined, ctx);
	assert.equal(result.details.progress.done, 1, "tick is recorded even though the bundle failed");
	assert.match(result.details.bundle.warning, /evidence bundle failed/);
	assert.match(result.content[0].text, /Evidence: evidence bundle failed/);
	assert.equal(branch.filter((entry) => entry.data?.event === "tick").length, 1);
})().catch((error) => { console.error(error); process.exit(1); });
`;
	await promisify(execFile)("./node_modules/.bin/tsx", ["-e", source], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_PATH: stubs, PI_CODING_AGENT_DIR: tickAgentDir },
	});
} finally {
	await fs.rm(root, { recursive: true, force: true });
}

console.log("test_review_bundle passed");
