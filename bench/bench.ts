// Benchmark pilot runner. Rules live in bench/PROTOCOL.md; this file implements them.
// Usage: npx --yes tsx bench/bench.ts <command> [...args]   (see `help`)
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as bridgeClient from "../agent/claude-bridge-client/pi-bridge-mcp.js";
import { redactText } from "../agent/extensions/workflow-modes/review-redact.ts";
import { foldFindings, validateFindingInput } from "../agent/extensions/workflow-modes/review-state.ts";
import { readReviewLog } from "../agent/extensions/workflow-modes/review-store.ts";
import { SCRIPT_MARKER, startFakeModel, type ScriptStep } from "./fake-model.ts";

export const CAP_MINUTES = 90;
export const PI_MODEL = "openai-codex/gpt-6-luna";
export const PI_THINKING = "max";
export const CLAUDE_MODEL = "opus";
// Pinned at shakedown and recorded in PROTOCOL.md Amendments; null until then.
export const CURSOR_MODEL: string | null = null;
export const FIRST_PROMPT = "Implement the task described in SPEC.md.";
export const NOTE_KINDS = ["start", "handoff", "gate", "intervention", "context-miss", "timeout", "abandon"] as const;
const MAX_NOTE_CHARS = 500;
const MAX_TAIL_BYTES = 8 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_MATCHES = 20;
const HIDDEN_TIMEOUT_MS = 5 * 60_000;
const FIXED_DATE = "2026-01-01T00:00:00Z";
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid" };
const TASK_ID = /^t[0-9]{1,3}$/;
// Rep ids: r1, r2, ... for pilot runs; s1, s2, ... for shakedown runs (excluded from verdicts).
const RUN_ID = /^(t[0-9]{1,3})-([ABC])-([rs][1-9][0-9]{0,2})$/;
const REP = /^s?[1-9][0-9]{0,2}$/;
const repId = (rep: string) => (rep.startsWith("s") ? rep : `r${rep}`);
export const isShakedown = (runId: string) => /-s[1-9][0-9]{0,2}$/.test(runId);
const REQ_ID = /^R[1-9][0-9]{0,2}$/;

type Workflow = "A" | "B" | "C";
type Env = Record<string, string | undefined>;
interface Task { id: string; dir: string; category: string; budgetMinutes: number; requirements: string[]; hidden: string[] }
interface NoteEvent { at: string; kind: string; text: string }
interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
type ModelUsage = Record<string, Usage>;

// Resolved per call so tests can point everything at temp dirs through env.
export function config() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const benchRoot = path.resolve(process.env.BENCH_ROOT ?? here);
	return {
		repoRoot: path.resolve(here, ".."),
		benchRoot,
		resultsDir: path.join(benchRoot, "results"),
		runsDir: path.resolve(process.env.PI_BENCH_HOME ?? path.join(homedir(), ".pi-bench", "runs")),
		hostAgentDir: path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent")),
		claudeDir: path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")),
	};
}

// Like test-bridge-e2e.mjs: no Pi state, Git redirection, or credentials reach spawned commands.
export function scrubEnv(base: Env = process.env): Env {
	const env: Env = {};
	for (const [key, value] of Object.entries(base)) {
		if (/^(PI_|GIT_)/.test(key) || /(API_KEY|ACCESS_KEY|SECRET|TOKEN)$/i.test(key)) continue;
		env[key] = value;
	}
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

interface RunResult { ok: boolean; code: number | null; stdout: string; stderr: string }
function run(cmd: string, args: string[], opts: { cwd?: string; env?: Env; timeout?: number } = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? scrubEnv(), timeout: opts.timeout ?? 60_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
			// error.code is the exit code, or a string such as ENOENT when the command could not start.
			const raw = (error as { code?: unknown } | null)?.code;
			const code = !error ? 0 : typeof raw === "number" ? raw : null;
			resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}
const git = (cwd: string, args: string[], extra: Env = {}) => run("git", ["-C", cwd, ...args], { env: { ...scrubEnv(), ...extra } });
async function gitOk(cwd: string, args: string[], extra: Env = {}): Promise<string> {
	const result = await git(cwd, args, extra);
	if (!result.ok) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout;
}

// realpath of the nearest existing ancestor, so not-yet-created dirs compare correctly.
async function realish(target: string): Promise<string> {
	let current = path.resolve(target);
	const rest: string[] = [];
	while (!existsSync(current)) {
		rest.unshift(path.basename(current));
		current = path.dirname(current);
	}
	return path.join(await fs.realpath(current), ...rest);
}
const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

async function walk(dir: string, filter: (file: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	let entries;
	try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") out.push(...await walk(full, filter));
		else if (entry.isFile() && filter(full)) out.push(full);
	}
	return out.sort();
}

async function hashTree(dirs: string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const dir of dirs) {
		for (const file of await walk(dir, () => true)) {
			hash.update(path.relative(dir, file)).update("\0").update(await fs.readFile(file)).update("\0");
		}
	}
	return hash.digest("hex");
}

export async function loadTask(id: string): Promise<Task> {
	if (!TASK_ID.test(id)) throw new Error(`task id must look like t1, got ${JSON.stringify(id)}`);
	const dir = path.join(config().benchRoot, "tasks", id);
	let raw: unknown;
	try { raw = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8")); } catch (error) { throw new Error(`cannot read ${id}/task.json: ${(error as Error).message}`); }
	const value = raw as Partial<Task>;
	if (typeof value.category !== "string" || !value.category) throw new Error(`${id}/task.json: category is required`);
	if (value.budgetMinutes !== CAP_MINUTES) throw new Error(`${id}/task.json: budgetMinutes must be ${CAP_MINUTES} (PROTOCOL.md section 6)`);
	if (!Array.isArray(value.requirements) || value.requirements.length === 0 || !value.requirements.every((r) => typeof r === "string" && REQ_ID.test(r))) throw new Error(`${id}/task.json: requirements must be a non-empty list like ["R1","R2"]`);
	const hiddenDir = path.join(dir, "hidden");
	const hidden = (await walk(hiddenDir, (file) => file.endsWith(".test.ts"))).map((file) => path.relative(hiddenDir, file));
	if (hidden.length === 0) throw new Error(`${id}: hidden/ has no *.test.ts files`);
	return { id, dir, category: value.category, budgetMinutes: value.budgetMinutes, requirements: value.requirements, hidden };
}

async function applyPatch(repo: string, patchFile: string): Promise<void> {
	const text = existsSync(patchFile) ? await fs.readFile(patchFile, "utf8") : "";
	if (text.trim()) await gitOk(repo, ["apply", "--whitespace=nowarn", patchFile]);
}

// Fixture app + start.patch + SPEC.md in a fresh git repo; `.pi/` is ignored there.
async function materialize(task: Task, dest: string): Promise<void> {
	await fs.cp(path.join(config().benchRoot, "fixture", "app"), dest, { recursive: true, errorOnExist: true, force: false });
	await gitOk(dest, ["init", "-q", "-b", "main"]);
	await applyPatch(dest, path.join(task.dir, "start.patch"));
	await fs.copyFile(path.join(task.dir, "SPEC.md"), path.join(dest, "SPEC.md"));
	const ignore = path.join(dest, ".gitignore");
	const current = existsSync(ignore) ? await fs.readFile(ignore, "utf8") : "";
	if (!current.split("\n").includes(".pi/")) await fs.writeFile(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.pi/\n`);
}

async function version(cmd: string, args: string[] = ["--version"]): Promise<string> {
	const result = await run(cmd, args, { timeout: 10_000 });
	const line = (result.stdout || result.stderr).trim().split("\n")[0];
	return result.ok && line ? line.slice(0, 200) : "unavailable";
}

async function readJson(file: string): Promise<any> {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function safeRunsDir(): Promise<string> {
	const { runsDir, repoRoot, hostAgentDir } = config();
	const real = await realish(runsDir);
	const forbidden = [await realish(repoRoot), await realish(path.join(homedir(), ".pi")), await realish(hostAgentDir)];
	if (forbidden.some((dir) => isInside(real, dir))) throw new Error(`runs dir ${runsDir} is inside the repository or a Pi directory; set PI_BENCH_HOME to a directory outside both`);
	await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });
	await fs.chmod(runsDir, 0o700);
	return runsDir;
}

export async function prepare(taskId: string, workflow: string, rep: string): Promise<{ runId: string; runDir: string }> {
	if (!["A", "B", "C"].includes(workflow)) throw new Error("workflow must be A, B, or C");
	if (!REP.test(rep)) throw new Error("rep must be a positive integer, or s<n> for a shakedown run");
	const task = await loadTask(taskId);
	const cfg = config();
	const hostAuth = path.join(cfg.hostAgentDir, "auth.json");
	if (!existsSync(hostAuth)) throw new Error(`no Pi login at ${hostAuth}; log in to Pi first (or set PI_CODING_AGENT_DIR)`);
	const runsDir = await safeRunsDir();
	const runId = `${taskId}-${workflow}-${repId(rep)}`;
	const runDir = path.join(runsDir, runId);
	try { await fs.mkdir(runDir, { mode: 0o700 }); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run ${runId} already exists; use a new rep id (PROTOCOL.md section 11)`);
		throw error;
	}
	const repo = path.join(runDir, "repo");
	await materialize(task, repo);
	const dated = { ...GIT_IDENTITY, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
	await gitOk(repo, ["add", "-A"]);
	await gitOk(repo, ["commit", "-q", "-m", `Start state for ${taskId}`], dated);
	await gitOk(repo, ["tag", "start"]);
	const startCommit = (await gitOk(repo, ["rev-parse", "HEAD"])).trim();
	await fs.mkdir(path.join(repo, ".pi"));
	const agentDir = path.join(runDir, "agent");
	await fs.mkdir(agentDir, { mode: 0o700 });
	await fs.symlink(hostAuth, path.join(agentDir, "auth.json"));

	const repoHead = await git(cfg.repoRoot, ["rev-parse", "HEAD"]);
	const repoStatus = await git(cfg.repoRoot, ["status", "--porcelain"]);
	const repoPackage = await readJson(path.join(cfg.repoRoot, "package.json")).catch(() => ({}));
	const installed = await readJson(path.join(cfg.hostAgentDir, "npm", "node_modules", "@lopezpetergabriel", "pi-extensions", "package.json")).catch(() => ({}));
	const warnings: string[] = [];
	if (installed.version !== repoPackage.version) warnings.push(`installed pi-extensions ${installed.version ?? "unavailable"} differs from repo ${repoPackage.version ?? "unavailable"}`);
	if (workflow === "C" && !CURSOR_MODEL) warnings.push("Cursor model not pinned yet; set CURSOR_MODEL in bench/bench.ts at shakedown (PROTOCOL.md Amendments)");
	const runJson = {
		schema: 1, runId, task: taskId, workflow, rep: repId(rep), createdAt: new Date().toISOString(), startCommit,
		repoCommit: repoHead.ok ? repoHead.stdout.trim() : "unavailable", repoDirty: repoStatus.ok ? repoStatus.stdout.trim() !== "" : null,
		versions: { pi: await version("pi"), piPackageInstalled: installed.version ?? "unavailable", piPackageRepo: repoPackage.version ?? "unavailable", claude: await version("claude"), cursorAgent: await version("cursor-agent"), node: process.version },
		models: { pi: PI_MODEL, piThinking: PI_THINKING, claude: CLAUDE_MODEL, cursor: CURSOR_MODEL ?? "unpinned" },
		taskHash: await hashTree([path.join(cfg.benchRoot, "fixture", "app"), task.dir]),
		protocolHash: existsSync(path.join(cfg.benchRoot, "PROTOCOL.md")) ? createHash("sha256").update(await fs.readFile(path.join(cfg.benchRoot, "PROTOCOL.md"))).digest("hex") : "unavailable",
		warnings,
	};
	await fs.writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, { mode: 0o600 });

	const note = (kind: string) => `npx --yes tsx bench/bench.ts note ${runId} ${kind}`;
	const lines = [
		`Run ${runId} prepared (${task.category}).`,
		...warnings.map((w) => `WARNING: ${w}`),
		"",
		"Launch (separate terminals; no other Pi session may run):",
		`  Pi:     cd ${repo} && PI_CODING_AGENT_DIR=${agentDir} pi --no-extensions -e ${cfg.repoRoot} --model ${PI_MODEL} --thinking ${PI_THINKING}`,
		...(workflow !== "A" ? [`  Claude: cd ${repo} && claude --model ${CLAUDE_MODEL}`] : []),
		...(workflow === "C" ? [`  Cursor: cd ${repo} && cursor-agent --model ${CURSOR_MODEL ?? "<pinned model>"}`] : []),
		"",
		`Right before the first prompt: ${note("start")}`,
		`First prompt (to ${workflow === "A" ? "Pi in Plan mode" : "Claude Code /pi-plan"}): ${FIRST_PROMPT}`,
		`Hand-offs: ${note("handoff wait")}  then  ${note("handoff go")}`,
		`When done or at ${CAP_MINUTES} min: npx --yes tsx bench/bench.ts score ${runId}`,
	];
	await fs.writeFile(path.join(runDir, "commands.txt"), `${lines.join("\n")}\n`, { mode: 0o600 });
	console.log(lines.join("\n"));
	return { runId, runDir };
}

async function runPaths(runId: string) {
	const match = RUN_ID.exec(runId);
	if (!match) throw new Error(`run id must look like t1-A-r1, got ${JSON.stringify(runId)}`);
	const runDir = path.join(config().runsDir, runId);
	if (!existsSync(path.join(runDir, "run.json"))) throw new Error(`run ${runId} not found under ${config().runsDir}; run prepare first`);
	return { runDir, repo: path.join(runDir, "repo"), agentDir: path.join(runDir, "agent"), events: path.join(runDir, "events.jsonl"), task: match[1], workflow: match[2] as Workflow };
}

async function readEvents(file: string): Promise<NoteEvent[]> {
	if (!existsSync(file)) return [];
	return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as NoteEvent);
}

export async function note(runId: string, kind: string, textParts: string[] = []): Promise<NoteEvent> {
	const paths = await runPaths(runId);
	if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw new Error(`note kind must be one of ${NOTE_KINDS.join(", ")}`);
	const text = textParts.join(" ").trim();
	if (text.length > MAX_NOTE_CHARS) throw new Error(`note text is ${text.length} chars; max ${MAX_NOTE_CHARS}`);
	if (kind === "handoff" && !/^(wait|go)\b/.test(text)) throw new Error("handoff note must start with 'wait' or 'go'");
	if (kind === "context-miss" && !/^R[1-9][0-9]{0,2}\b/.test(text)) throw new Error("context-miss note must start with a requirement id, e.g. 'R2 missing from plan'");
	const events = await readEvents(paths.events);
	if (kind === "start" && events.some((e) => e.kind === "start")) throw new Error(`run ${runId} already started`);
	if (kind !== "start" && !events.some((e) => e.kind === "start")) throw new Error(`run ${runId} has no start note; record start first`);
	const event = { at: new Date().toISOString(), kind, text };
	await fs.appendFile(paths.events, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	console.log(`${kind} recorded for ${runId} at ${event.at}`);
	return event;
}

export function parseTap(output: string): Map<string, boolean> {
	const results = new Map<string, boolean>();
	for (const line of output.split("\n")) {
		const match = /^\s*(not ok|ok) \d+ - (.*)$/.exec(line);
		if (!match) continue;
		const req = /^(R[1-9][0-9]{0,2})\b/.exec(match[2]);
		if (!req) continue;
		const passed = match[1] === "ok" && !/#\s*(SKIP|TODO)\b/i.test(match[2]);
		results.set(req[1], (results.get(req[1]) ?? true) && passed);
	}
	return results;
}

// Hidden tests are copied into a scratch copy at their mirrored paths and run there only.
export async function runHidden(task: Task, tree: string): Promise<{ pass: boolean; exit: number | null; requirements: Record<string, boolean>; tail: string }> {
	const files: string[] = [];
	for (const rel of task.hidden) {
		const dest = path.join(tree, rel);
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.copyFile(path.join(task.dir, "hidden", rel), dest);
		files.push(rel);
	}
	const result = await run(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: tree, timeout: HIDDEN_TIMEOUT_MS });
	const byReq = parseTap(result.stdout);
	const requirements = Object.fromEntries(task.requirements.map((r) => [r, byReq.get(r) === true]));
	const output = `${result.stdout}\n${result.stderr}`;
	return { pass: result.code === 0 && Object.values(requirements).every(Boolean), exit: result.code, requirements, tail: output.slice(-MAX_TAIL_BYTES) };
}

function addUsage(target: ModelUsage, key: string, usage: Partial<Usage>) {
	const entry = (target[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) entry[field] += Number(usage[field]) || 0;
}

export async function piUsage(agentDir: string): Promise<{ usage: ModelUsage | null; piEstimate: number | null; files: string[] }> {
	const files = await walk(agentDir, (file) => file.endsWith(".jsonl"));
	const usage: ModelUsage = {};
	let estimate = 0;
	let seen = false;
	for (const file of files) {
		for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			const message = entry?.type === "message" ? entry.message : undefined;
			if (message?.role !== "assistant" || !message.usage) continue;
			seen = true;
			addUsage(usage, `${message.provider}/${message.model}`, message.usage);
			estimate += Number(message.usage.cost?.total) || 0;
		}
	}
	return { usage: seen ? usage : null, piEstimate: seen ? estimate : null, files };
}

export function claudeSlug(dir: string): string {
	return dir.replace(/[^A-Za-z0-9]/g, "-");
}

// Claude Code logs one message across several lines; the last line per message id wins.
export async function claudeUsage(repo: string): Promise<{ usage: ModelUsage | null; files: string[] }> {
	const dir = path.join(config().claudeDir, "projects", claudeSlug(await fs.realpath(repo)));
	const files = await walk(dir, (file) => file.endsWith(".jsonl"));
	const byId = new Map<string, { model: string; usage: any }>();
	for (const file of files) {
		for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			const message = entry?.message;
			if (!message?.usage || typeof message.id !== "string") continue;
			byId.set(message.id, { model: String(message.model), usage: message.usage });
		}
	}
	if (byId.size === 0) return { usage: null, files };
	const usage: ModelUsage = {};
	for (const { model, usage: u } of byId.values()) {
		addUsage(usage, `anthropic/${model}`, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
	}
	return { usage, files };
}

// null price for a field with tokens -> that model's cost is unavailable (PROTOCOL.md section 7).
export function estimateCost(usage: ModelUsage | null, prices: any): number | "unavailable" {
	if (!usage) return "unavailable";
	let total = 0;
	for (const [model, tokens] of Object.entries(usage)) {
		const price = prices?.models?.[model];
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (tokens[field] === 0) continue;
			if (typeof price?.[field] !== "number") return "unavailable";
			total += (tokens[field] * price[field]) / 1_000_000;
		}
	}
	return total;
}

// Redact secrets, then replace host paths so committed files carry no user-home paths.
function sanitize(text: string): string {
	const { repoRoot } = config();
	return redactText(text, process.env).text.split(repoRoot).join("<repo>").split(homedir()).join("~");
}
function clipBytes(text: string, max: number): string {
	return Buffer.byteLength(text) <= max ? text : `${Buffer.from(text).subarray(0, max).toString("utf8")}\n[truncated]\n`;
}

async function contamination(task: Task, logs: Array<{ source: string; file: string }>) {
	const benchReal = await fs.realpath(config().benchRoot);
	const needles: Array<[string, string]> = [[benchReal + path.sep, "<bench-root>/"], ["bench/tasks/", "bench/tasks/"], ["bench/review/", "bench/review/"], ...task.hidden.map((rel): [string, string] => [path.basename(rel), path.basename(rel)])];
	const matches: Array<{ source: string; needle: string }> = [];
	for (const log of logs) {
		const text = await fs.readFile(log.file, "utf8");
		for (const [needle, label] of needles) {
			if (matches.length >= MAX_MATCHES) break;
			if (text.includes(needle) && !matches.some((m) => m.source === log.source && m.needle === label)) matches.push({ source: log.source, needle: label });
		}
	}
	return matches;
}

function handoffWait(events: NoteEvent[], startMs: number, endMs: number): number {
	let wait = 0;
	let open: number | null = null;
	for (const e of events.filter((x) => x.kind === "handoff")) {
		const at = Math.min(Math.max(Date.parse(e.at), startMs), endMs);
		if (e.text.startsWith("wait") && open === null) open = at;
		else if (e.text.startsWith("go") && open !== null) { wait += at - open; open = null; }
	}
	if (open !== null) wait += endMs - open;
	return wait;
}

export async function score(runId: string): Promise<Record<string, unknown>> {
	const paths = await runPaths(runId);
	const cfg = config();
	const runJson = await readJson(path.join(paths.runDir, "run.json"));
	const task = await loadTask(paths.task);
	const events = await readEvents(paths.events);
	const start = events.find((e) => e.kind === "start");
	if (!start) throw new Error(`run ${runId} has no start note; nothing to score`);
	const startMs = Date.parse(start.at);
	const capMs = startMs + CAP_MINUTES * 60_000;
	const warnings: string[] = [];

	const log = (await gitOk(paths.repo, ["log", "--first-parent", "--format=%H %ct", "HEAD"])).trim().split("\n").map((line) => {
		const [sha, ct] = line.split(" ");
		return { sha, ms: Number(ct) * 1000 };
	});
	const inCap = log.find((c) => c.ms <= capMs);
	const scoredCommit = inCap?.sha ?? runJson.startCommit;
	const commitsAfterCap = log.filter((c) => c.ms > capMs).length;
	const noCommit = scoredCommit === runJson.startCommit;
	const timeout = events.some((e) => e.kind === "timeout") || commitsAfterCap > 0;
	const abandon = events.find((e) => e.kind === "abandon");
	const lastNoteMs = Math.max(...events.map((e) => Date.parse(e.at)));
	const endMs = timeout ? capMs : !noCommit && inCap ? inCap.ms : Math.min(abandon ? Date.parse(abandon.at) : lastNoteMs, capMs);
	const wallClockMs = Math.max(0, endMs - startMs);
	const handoffWaitMs = handoffWait(events, startMs, endMs);

	const scratch = await fs.mkdtemp(path.join(tmpdir(), `bench-score-${runId}-`));
	let hidden;
	try {
		const tar = path.join(scratch, "tree.tar");
		const tree = path.join(scratch, "tree");
		await gitOk(paths.repo, ["archive", "--format=tar", "-o", tar, scoredCommit]);
		await fs.mkdir(tree);
		const untar = await run("tar", ["-xf", tar, "-C", tree]);
		if (!untar.ok) throw new Error(`tar failed: ${untar.stderr.trim()}`);
		for (const rel of task.hidden) if (existsSync(path.join(tree, rel))) warnings.push(`hidden test path ${rel} existed in the scored tree and was replaced`);
		hidden = await runHidden(task, tree);
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}

	const prices = await readJson(path.join(cfg.benchRoot, "prices.json")).catch(() => null);
	if (!prices) warnings.push("bench/prices.json unreadable; every cost is unavailable");
	const pi = await piUsage(paths.agentDir);
	const claude = await claudeUsage(paths.repo);
	const used = { pi: true, claude: paths.workflow !== "A", cursor: paths.workflow === "C" };
	const role = (found: ModelUsage | null, isUsed: boolean) => found ?? (isUsed ? "unavailable" : "not-used");
	const tokens = { pi: role(pi.usage, used.pi), claude: role(claude.usage, used.claude), cursor: used.cursor ? "unavailable" : "not-used" };
	const cost = {
		pi: pi.usage ? estimateCost(pi.usage, prices) : tokens.pi,
		claude: claude.usage ? estimateCost(claude.usage, prices) : tokens.claude,
		cursor: tokens.cursor,
	};
	if (pi.usage && pi.files.length > 0 && !pi.files.some((f) => f.includes(`${path.sep}sessions${path.sep}`))) warnings.push("Pi usage found outside sessions/; check subagent session layout");

	const logs = [...pi.files.map((file) => ({ source: "pi", file })), ...claude.files.map((file) => ({ source: "claude", file }))];
	const matches = await contamination(task, logs);
	const workflowFailures: string[] = [];
	if (abandon) workflowFailures.push(/^(harness-error|tooling-failure)\b/.exec(abandon.text)?.[1] ?? "abandon");
	if (timeout) workflowFailures.push("timeout");
	if (noCommit) workflowFailures.push("no-commit");

	const results = path.join(cfg.resultsDir, "coding.jsonl");
	const prior = existsSync(results) ? (await fs.readFile(results, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.runId === runId) : [];
	const artifactDir = path.join(cfg.resultsDir, "artifacts");
	await fs.mkdir(artifactDir, { recursive: true });
	// Artifacts are never overwritten: a re-score (or a score that crashed before its row) gets the next suffix.
	let attempt = prior.length;
	while (existsSync(path.join(artifactDir, `${runId}${attempt ? `.s${attempt}` : ""}.patch`))) attempt += 1;
	const suffix = attempt ? `.s${attempt}` : "";
	const artifacts: string[] = [];
	const diff = await gitOk(paths.repo, ["diff", "--no-color", "--no-ext-diff", "start", scoredCommit]);
	const diffName = `${runId}${suffix}.patch`;
	await fs.writeFile(path.join(artifactDir, diffName), clipBytes(sanitize(diff), MAX_ARTIFACT_BYTES), { flag: "wx" });
	artifacts.push(`results/artifacts/${diffName}`);
	for (const plan of await walk(path.join(paths.agentDir, "plans"), (file) => file.endsWith(".md"))) {
		const name = `${runId}${suffix}.plan-${path.basename(plan)}`;
		await fs.writeFile(path.join(artifactDir, name), clipBytes(sanitize(await fs.readFile(plan, "utf8")), MAX_ARTIFACT_BYTES), { flag: "wx" });
		artifacts.push(`results/artifacts/${name}`);
	}

	const notesOf = (kind: string) => events.filter((e) => e.kind === kind).map((e) => sanitize(e.text)).slice(0, 50);
	const row = {
		schema: 1, runId, task: task.id, category: task.category, workflow: paths.workflow, rep: runJson.rep,
		scoredAt: new Date().toISOString(), ...(prior.length ? { rescoreOf: prior[prior.length - 1].scoredAt } : {}),
		startedAt: start.at, startCommit: runJson.startCommit, scoredCommit, commitsAfterCap,
		pass: hidden.pass, requirements: hidden.requirements, hiddenExit: hidden.exit, hiddenTail: clipBytes(sanitize(hidden.tail), MAX_TAIL_BYTES),
		wallClockMs, handoffWaitMs, agentMs: wallClockMs - handoffWaitMs,
		tokens, cost, piEstimate: pi.piEstimate ?? "unavailable", pricesAsOf: prices?.asOf ?? null,
		gates: notesOf("gate"), interventions: notesOf("intervention"), contextMisses: notesOf("context-miss"),
		contamination: { flagged: matches.length > 0, matches, unscanned: used.cursor ? ["cursor"] : [] },
		workflowFailures, pins: { repoCommit: runJson.repoCommit, repoDirty: runJson.repoDirty, versions: runJson.versions, models: runJson.models, taskHash: runJson.taskHash, protocolHash: runJson.protocolHash },
		artifacts, warnings: [...(runJson.warnings ?? []), ...warnings].map(sanitize),
	};
	await fs.appendFile(results, `${JSON.stringify(row)}\n`);

	const auth = path.join(paths.agentDir, "auth.json");
	const authStat = await fs.lstat(auth).catch(() => null);
	if (authStat?.isSymbolicLink()) await fs.unlink(auth);
	else if (authStat) console.warn(`WARNING: ${auth} is not a symlink; left in place`);

	console.log(`${runId}: ${hidden.pass ? "PASS" : "FAIL"} (${Object.entries(hidden.requirements).map(([r, ok]) => `${r}:${ok ? "ok" : "fail"}`).join(" ")}); failures: ${workflowFailures.join(", ") || "none"}; contamination: ${matches.length ? "FLAGGED" : "none"}`);
	return row;
}

export async function checkTasks(): Promise<boolean> {
	const tasksDir = path.join(config().benchRoot, "tasks");
	const ids = existsSync(tasksDir) ? (await fs.readdir(tasksDir)).filter((name) => TASK_ID.test(name)).sort() : [];
	if (ids.length === 0) throw new Error(`no tasks found in ${tasksDir}`);
	let allOk = true;
	for (const id of ids) {
		const problems: string[] = [];
		const scratch = await fs.mkdtemp(path.join(tmpdir(), `bench-check-${id}-`));
		try {
			const task = await loadTask(id);
			const spec = await fs.readFile(path.join(task.dir, "SPEC.md"), "utf8");
			for (const r of task.requirements) if (!new RegExp(`\\b${r}\\b`).test(spec)) problems.push(`SPEC.md does not mention ${r}`);
			for (const rel of task.hidden) {
				if (spec.includes(path.basename(rel))) problems.push(`SPEC.md names hidden test ${path.basename(rel)}`);
				// A visible file at the mirrored path would be replaced at score time and blur contamination scans.
				if (existsSync(path.join(config().benchRoot, "fixture", "app", rel))) problems.push(`hidden test ${rel} collides with a fixture file`);
			}
			const startTree = path.join(scratch, "start");
			await materialize(task, startTree);
			const before = await runHidden(task, startTree);
			if (before.pass) problems.push("hidden tests pass on the start state");
			const solvedTree = path.join(scratch, "solved");
			await materialize(task, solvedTree);
			await applyPatch(solvedTree, path.join(task.dir, "solution.patch"));
			// Visible tests first: runHidden copies hidden tests into the tree.
			const visible = await run("npm", ["test", "--silent"], { cwd: solvedTree, timeout: HIDDEN_TIMEOUT_MS });
			if (!visible.ok) problems.push("visible npm test fails on the solution");
			const after = await runHidden(task, solvedTree);
			if (!after.pass) problems.push(`hidden tests fail on the solution: ${Object.entries(after.requirements).filter(([, ok]) => !ok).map(([r]) => r).join(", ") || `exit ${after.exit}`}`);
		} catch (error) {
			problems.push((error as Error).message);
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
		console.log(`${id}: ${problems.length ? `FAIL - ${problems.join("; ")}` : "ok"}`);
		if (problems.length) allOk = false;
	}
	return allOk;
}

// ---------------------------------------------------------------------------
// Review evaluation (PROTOCOL.md section 9)

const REVIEW_FIXTURE_ID = /^r[0-9]{1,3}$/;
const REVIEW_RUN_ID = /^(r[0-9]{1,3})-(bundle|diff)-([rs][1-9][0-9]{0,2})$/;
export const REVIEW_TASK_TITLE = "Implement SPEC.md";
export const REVIEW_TICK_NOTE = "Implemented per SPEC.md.";
const SETUP_IDENTITY = { harness: "claude", id: "bench-setup" };
const FAKE_KEY = "bench-fake-key";
const PI_READY_MS = 30_000;
const SCRIPTED_TURN_MS = 120_000;

interface Label { file: string; lines: [number, number]; defect: string }
export interface ReviewFixture { id: string; dir: string; labels: Label[] }

export async function loadReviewFixture(id: string): Promise<ReviewFixture> {
	if (!REVIEW_FIXTURE_ID.test(id)) throw new Error(`review fixture id must look like r1, got ${JSON.stringify(id)}`);
	const dir = path.join(config().benchRoot, "review", id);
	for (const name of ["SPEC.md", "impl.patch", "labels.json"]) if (!existsSync(path.join(dir, name))) throw new Error(`${id}/${name} is missing`);
	const labels = JSON.parse(await fs.readFile(path.join(dir, "labels.json"), "utf8"));
	const valid = Array.isArray(labels) && labels.every((l) => typeof l?.file === "string" && Array.isArray(l.lines) && l.lines.length === 2 && l.lines.every(Number.isInteger) && l.lines[0] <= l.lines[1] && typeof l.defect === "string");
	if (!valid) throw new Error(`${id}/labels.json must be a list of { file, lines: [a, b], defect }`);
	return { id, dir, labels };
}

// The implementation's files: impl.patch applied to the working tree, read, then reverted.
async function implementationFiles(repo: string, patch: string): Promise<Array<{ path: string; content: string }>> {
	await gitOk(repo, ["apply", "--whitespace=nowarn", patch]);
	const status = (await gitOk(repo, ["status", "--porcelain=v1", "-uall"])).split("\n").filter(Boolean);
	const files: Array<{ path: string; content: string; untracked: boolean }> = [];
	for (const line of status) {
		const code = line.slice(0, 2);
		const rel = line.slice(3);
		if (!/^( M|\?\?)$/.test(code)) throw new Error(`impl.patch may only modify or add files; got "${code}" for ${rel}`);
		files.push({ path: rel, content: await fs.readFile(path.join(repo, rel), "utf8"), untracked: code === "??" });
	}
	await gitOk(repo, ["checkout", "--", "."]);
	for (const file of files) if (file.untracked) await fs.rm(path.join(repo, file.path));
	return files.sort((a, b) => (a.path < b.path ? -1 : 1)).map(({ path: p, content }) => ({ path: p, content }));
}

export function diffPrompt(spec: string, diff: string): string {
	return [
		"You are reviewing a change to the repository in the current directory. Do not modify any file.",
		"",
		"The change is the latest commit. It was meant to implement SPEC.md, shown below. Look for defects: anything that makes the change wrong or incomplete against SPEC.md, or that breaks existing behavior.",
		"",
		"Reply with only a JSON array of findings and nothing else. Each finding is an object with:",
		'- "file": repository-relative path of the file with the defect',
		'- "line": line number in the changed version of that file',
		'- "severity": "high", "medium", or "low"',
		'- "text": what is wrong',
		'- "fix" (optional): how to fix it',
		'- "repro" (optional): how to reproduce it',
		"If you find no defects, reply with [].",
		"",
		"## SPEC.md",
		"",
		spec.trim(),
		"",
		"## Diff",
		"",
		"```diff",
		diff.trimEnd(),
		"```",
		"",
	].join("\n");
}

function oneTaskPlan(files: string[]): string {
	return [
		"# Review fixture plan",
		"",
		"## Section 4 — Tasks",
		"",
		`- [ ] ${REVIEW_TASK_TITLE}`,
		"  - **Given** the repository at its current commit **When** the change described in SPEC.md is implemented **Then** SPEC.md's requirements hold",
		`  - **Files:** ${files.map((file) => `\`${file}\``).join(", ")}`,
		"",
	].join("\n");
}

interface PiProcess { child: ChildProcessWithoutNullStreams; notices: string[]; dialogs: string[]; stderr: string; prompt: (message: string) => void }

// RPC driver as in test-bridge-e2e.mjs: JSONL out, commands in, Pi's own dialogs answered.
function startPi(repo: string, agentDir: string, sessionId: string, env: Env): PiProcess {
	const cli = path.join(config().repoRoot, "agent/extensions/subagents/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
	if (!existsSync(cli)) throw new Error(`bundled Pi CLI missing at ${cli}; run npm run bootstrap first`);
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "-e", config().repoRoot, "--session-dir", path.join(agentDir, "sessions"), "--session-id", sessionId, "--model", "bench-fake/fake"], { cwd: repo, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
	const pi: PiProcess = { child, notices: [], dialogs: [], stderr: "", prompt: (message) => child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "prompt", message })}\n`) };
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let record: any;
			try { record = JSON.parse(line); } catch { continue; }
			if (record?.type !== "extension_ui_request") continue;
			if (record.method === "notify" && typeof record.message === "string") pi.notices.push(record.message);
			if (record.method !== "confirm" && record.method !== "select") continue;
			pi.dialogs.push(String(record.title ?? record.method));
			const reply = record.method === "confirm" ? { confirmed: true } : { value: record.options?.[0] };
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, ...reply })}\n`);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { pi.stderr = (pi.stderr + chunk).slice(-8_000); });
	return pi;
}

async function stopPi(pi: PiProcess): Promise<void> {
	if (pi.child.exitCode !== null || pi.child.signalCode !== null) return;
	const closed = new Promise((resolve) => pi.child.once("close", resolve));
	pi.child.stdin.end();
	pi.child.kill("SIGTERM");
	await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
	if (pi.child.exitCode === null && pi.child.signalCode === null) pi.child.kill("SIGKILL");
}

async function waitFor<T>(check: () => T | Promise<T>, label: string, timeoutMs: number, pi?: PiProcess): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		if (pi && (pi.child.exitCode !== null || pi.child.signalCode !== null)) throw new Error(`Pi exited while waiting for ${label}: ${pi.stderr.slice(-600)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for ${label}${pi ? `; Pi stderr: ${pi.stderr.slice(-600)}` : ""}`);
}

export interface ReviewHandle { runId: string; runDir: string; repo: string; implTree: string; bundleId?: string; bundlePath?: string; sessionId?: string; stop: () => Promise<void> }

export async function reviewPrepare(fixtureId: string, condition: string, rep: string): Promise<ReviewHandle> {
	if (condition !== "bundle" && condition !== "diff") throw new Error("condition must be bundle or diff");
	if (!REP.test(rep)) throw new Error("rep must be a positive integer, or s<n> for a shakedown run");
	const fixture = await loadReviewFixture(fixtureId);
	const cfg = config();
	const runsDir = await safeRunsDir();
	const runId = `${fixtureId}-${condition}-${repId(rep)}`;
	const runDir = path.join(runsDir, runId);
	try { await fs.mkdir(runDir, { mode: 0o700 }); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run ${runId} already exists; use a new rep id (PROTOCOL.md section 9)`);
		throw error;
	}
	const repo = path.join(runDir, "repo");
	const dated = { ...GIT_IDENTITY, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
	await fs.cp(path.join(cfg.benchRoot, "fixture", "app"), repo, { recursive: true, errorOnExist: true, force: false });
	await gitOk(repo, ["init", "-q", "-b", "main"]);
	await fs.copyFile(path.join(fixture.dir, "SPEC.md"), path.join(repo, "SPEC.md"));
	const ignore = path.join(repo, ".gitignore");
	const current = existsSync(ignore) ? await fs.readFile(ignore, "utf8") : "";
	if (!current.split("\n").includes(".pi/")) await fs.writeFile(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.pi/\n`);
	await gitOk(repo, ["add", "-A"]);
	await gitOk(repo, ["commit", "-q", "-m", "Start state"], dated);
	await gitOk(repo, ["tag", "start"]);
	const files = await implementationFiles(repo, path.join(fixture.dir, "impl.patch"));
	const runJson: Record<string, unknown> = { schema: 1, kind: "review", runId, fixture: fixtureId, condition, rep: repId(rep), createdAt: new Date().toISOString(), cursorModel: CURSOR_MODEL ?? "unpinned" };

	if (condition === "diff") {
		for (const file of files) await fs.writeFile(path.join(repo, file.path), file.content);
		await gitOk(repo, ["add", "-A"]);
		await gitOk(repo, ["commit", "-q", "-m", REVIEW_TASK_TITLE], dated);
		const implTree = (await gitOk(repo, ["rev-parse", "HEAD^{tree}"])).trim();
		const diff = await gitOk(repo, ["diff", "--no-color", "--no-ext-diff", "start", "HEAD"]);
		await fs.writeFile(path.join(runDir, "diff.patch"), diff, { mode: 0o600 });
		await fs.writeFile(path.join(runDir, "prompt.md"), diffPrompt(await fs.readFile(path.join(repo, "SPEC.md"), "utf8"), diff), { mode: 0o600 });
		Object.assign(runJson, { implCommit: (await gitOk(repo, ["rev-parse", "HEAD"])).trim(), implTree });
		await fs.writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, { mode: 0o600 });
		return { runId, runDir, repo, implTree, stop: async () => {} };
	}

	// bundle: a real Pi Build, driven by a scripted fake model, records the evidence.
	const agentDir = path.join(runDir, "agent");
	await fs.mkdir(agentDir, { mode: 0o700 });
	// The bridge finds its project by the nearest .pi/ marker.
	await fs.mkdir(path.join(repo, ".pi"));
	const script: ScriptStep[] = [
		...files.map((file): ScriptStep => ({ call: { name: "write", args: { path: file.path, content: file.content } } })),
		{ call: { name: "bash", args: { command: "npm test" } } },
		{ call: { name: "bash", args: { command: "git add -A" } } },
		{ call: { name: "bash", args: { command: `git commit -q -m "${REVIEW_TASK_TITLE}"` } } },
		{ call: { name: "bash", args: { command: "git rev-parse HEAD" } } },
		{ call: { name: "workflow_plan_tick", args: (last) => ({ title: REVIEW_TASK_TITLE, note: REVIEW_TICK_NOTE, ...(/[0-9a-f]{40}/.exec(last) ? { commit: /[0-9a-f]{40}/.exec(last)![0] } : {}) }) } },
		{ text: "Done." },
	];
	const fake = await startFakeModel(script, FAKE_KEY);
	let pi: PiProcess | undefined;
	const stop = async () => {
		if (pi) await stopPi(pi);
		await fake.close();
	};
	try {
		await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
			providers: { "bench-fake": { name: "Bench scripted model", api: "openai-completions", baseUrl: fake.baseUrl, apiKey: FAKE_KEY, models: [{ id: "fake", name: "fake", input: ["text"], reasoning: false, contextWindow: 65_536, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
		}), { mode: 0o600 });
		const sessionId = randomUUID();
		pi = startPi(repo, agentDir, sessionId, { ...scrubEnv(), PI_CODING_AGENT_DIR: agentDir, ...dated });
		const namespace = path.join(repo, ".pi", "memory", "bridge", "sessions", sessionId);
		await waitFor(() => existsSync(path.join(namespace, "presence.json")) && existsSync(path.join(namespace, "inflight")), "Pi bridge presence", PI_READY_MS, pi);
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result = await bridgeClient.callTool(name, { ...args, cwd: repo, sessionId: SETUP_IDENTITY.id, harness: SETUP_IDENTITY.harness });
			return result.structuredContent ?? JSON.parse(result.content[0].text);
		};
		await call("save_plan", { planText: oneTaskPlan(files.map((file) => file.path)), confirmed: true, planId: "review" });
		pi.prompt("/mode build");
		await waitFor(() => pi!.notices.some((notice) => /Mode: Build/.test(notice)), "Build mode", PI_READY_MS, pi);
		pi.prompt(SCRIPT_MARKER);
		const evidenceDir = path.join(agentDir, "plans", sessionId, "evidence");
		const bundleFile = await waitFor(async () => {
			if (!fake.state.done) return undefined;
			const names = existsSync(evidenceDir) ? (await fs.readdir(evidenceDir)).filter((name) => name.endsWith(".json")) : [];
			return names.length === 1 ? path.join(evidenceDir, names[0]) : undefined;
		}, "scripted Build turn and evidence bundle", SCRIPTED_TURN_MS, pi);
		if (fake.state.errors.length) throw new Error(`fake model errors: ${fake.state.errors.join("; ")}`);
		const implTree = (await gitOk(repo, ["rev-parse", "HEAD^{tree}"])).trim();
		const bundleId = path.basename(bundleFile, ".json");
		Object.assign(runJson, { sessionId, bundleId, implCommit: (await gitOk(repo, ["rev-parse", "HEAD"])).trim(), implTree });
		await fs.writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, { mode: 0o600 });
		return { runId, runDir, repo, implTree, bundleId, bundlePath: bundleFile, sessionId, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

async function reviewPrepareCommand(fixtureId: string, condition: string, rep: string): Promise<number> {
	const handle = await reviewPrepare(fixtureId, condition, rep);
	if (condition === "diff") {
		console.log(`Review run ${handle.runId} prepared (diff only).\nPrompt: ${path.join(handle.runDir, "prompt.md")}\nReviewer works in: ${handle.repo}`);
		return 0;
	}
	const pidFile = path.join(handle.runDir, "review.pid");
	await fs.writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
	console.log(`Review run ${handle.runId} prepared: evidence bundle ${handle.bundleId}.\nPi is running for the reviewer in ${handle.repo}; keep this terminal open.\nStop with: npx --yes tsx bench/bench.ts review-stop ${handle.runId}   (or Ctrl-C)`);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => resolve());
		process.once("SIGTERM", () => resolve());
	});
	await handle.stop();
	await fs.rm(pidFile, { force: true });
	console.log(`Pi stopped for ${handle.runId}.`);
	return 0;
}

export async function reviewStop(runId: string): Promise<void> {
	if (!REVIEW_RUN_ID.test(runId)) throw new Error(`review run id must look like r1-bundle-r1, got ${JSON.stringify(runId)}`);
	const pidFile = path.join(config().runsDir, runId, "review.pid");
	if (!existsSync(pidFile)) {
		console.log(`No running Pi for ${runId}.`);
		return;
	}
	const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`${pidFile} does not hold a valid pid`);
	try { process.kill(pid, "SIGTERM"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		await fs.rm(pidFile, { force: true });
	}
	console.log(`Asked review-prepare (pid ${pid}) to stop Pi for ${runId}.`);
}

const REVIEW_TIMEOUT_MS = 20 * 60_000;
const MAX_FINDING_TEXT_IN_ROW = 300;

async function reviewPaths(runId: string) {
	const match = REVIEW_RUN_ID.exec(runId);
	if (!match) throw new Error(`review run id must look like r1-bundle-r1, got ${JSON.stringify(runId)}`);
	const runDir = path.join(config().runsDir, runId);
	if (!existsSync(path.join(runDir, "run.json"))) throw new Error(`review run ${runId} not found under ${config().runsDir}; run review-prepare first`);
	const runJson = await readJson(path.join(runDir, "run.json"));
	return { runDir, repo: path.join(runDir, "repo"), agentDir: path.join(runDir, "agent"), fixture: match[1], condition: match[2] as "bundle" | "diff", runJson };
}

// Same framing as diffPrompt, then Cursor's own /pi-review procedure from this repository.
export function bundlePrompt(template: string): string {
	return [
		"Review the latest change in this repository. Do not modify any file and do not ask the user anything.",
		"",
		"The change was meant to implement SPEC.md. Look for defects: anything that makes the change wrong or incomplete against SPEC.md, or that breaks existing behavior. There is exactly one task to review. Submit every defect you find with submit_review_findings, giving file and line where you can.",
		"",
		"Follow this review procedure:",
		"",
		template.trim(),
		"",
	].join("\n");
}

export function cursorModelFor(requested?: string): string {
	if (CURSOR_MODEL && requested && requested !== CURSOR_MODEL) throw new Error(`Cursor model is pinned to ${CURSOR_MODEL}; got --model ${requested}`);
	const model = CURSOR_MODEL ?? requested;
	if (!model) throw new Error("Cursor model is not pinned yet; pass --model <model> at shakedown, then set CURSOR_MODEL in bench/bench.ts (PROTOCOL.md Amendments)");
	return model;
}

const isAlive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

export async function reviewRun(runId: string, requestedModel?: string): Promise<void> {
	const paths = await reviewPaths(runId);
	const model = cursorModelFor(requestedModel);
	if (existsSync(path.join(paths.runDir, "review-run.json"))) throw new Error(`run ${runId} was already reviewed; use a new rep id (PROTOCOL.md section 9)`);
	const args = ["-p", "--output-format", "json", "--model", model];
	let prompt: string;
	if (paths.condition === "bundle") {
		const pidFile = path.join(paths.runDir, "review.pid");
		const pid = existsSync(pidFile) ? Number((await fs.readFile(pidFile, "utf8")).trim()) : NaN;
		if (!Number.isInteger(pid) || !isAlive(pid)) throw new Error(`Pi is not running for ${runId}; start review-prepare for it and keep that terminal open`);
		prompt = bundlePrompt(await fs.readFile(path.join(config().repoRoot, "agent", "harness-commands", "cursor", "pi-review.md"), "utf8"));
		args.push("--approve-mcps");
	} else {
		prompt = await fs.readFile(path.join(paths.runDir, "prompt.md"), "utf8");
	}
	// Cursor keeps its own login; only Pi state and Git redirection are dropped.
	const env: Env = {};
	for (const [key, value] of Object.entries(process.env)) if (!/^(PI_|GIT_)/.test(key)) env[key] = value;
	const startedAt = new Date().toISOString();
	const result = await run("cursor-agent", [...args, prompt], { cwd: paths.repo, env, timeout: REVIEW_TIMEOUT_MS });
	await fs.writeFile(path.join(paths.runDir, "review-output.txt"), result.stdout, { mode: 0o600 });
	await fs.writeFile(path.join(paths.runDir, "review-stderr.txt"), result.stderr, { mode: 0o600 });
	await fs.writeFile(path.join(paths.runDir, "review-run.json"), `${JSON.stringify({ model, mode: "headless", startedAt, finishedAt: new Date().toISOString(), exit: result.code }, null, 2)}\n`, { mode: 0o600 });
	console.log(`${runId}: cursor-agent exited ${result.code ?? "abnormally"}. Next: npx --yes tsx bench/bench.ts review-score ${runId}`);
}

interface RawFinding { file?: string; line?: number; severity?: string; text: string; invalid?: string }
export interface ScoredFinding extends RawFinding { outcome: "tp" | "fp" | "duplicate"; label?: number; reason?: string }

// PROTOCOL.md section 9: same file and line within the label range ±3; first match wins.
export function matchFindings(findings: RawFinding[], labels: Label[]) {
	const matched = new Set<number>();
	const scored: ScoredFinding[] = [];
	for (const finding of findings) {
		if (finding.invalid) {
			scored.push({ ...finding, outcome: "fp", reason: finding.invalid });
			continue;
		}
		const file = finding.file?.replace(/^\.\//, "");
		const line = finding.line;
		const hits = labels.map((label, index) => ({ label, index })).filter(({ label }) => file === label.file && line !== undefined && line >= label.lines[0] - 3 && line <= label.lines[1] + 3);
		const fresh = hits.find(({ index }) => !matched.has(index));
		if (fresh) {
			matched.add(fresh.index);
			scored.push({ ...finding, outcome: "tp", label: fresh.index });
		} else if (hits.length > 0) {
			scored.push({ ...finding, outcome: "duplicate", label: hits[0].index });
		} else {
			scored.push({ ...finding, outcome: "fp", reason: !file ? "no file" : line === undefined ? "no line" : "matches no label" });
		}
	}
	const count = (outcome: ScoredFinding["outcome"]) => scored.filter((f) => f.outcome === outcome).length;
	return { findings: scored, tp: count("tp"), fp: count("fp"), duplicates: count("duplicate"), fn: labels.length - matched.size };
}

// Diff-condition output: Cursor's JSON envelope (or raw text) holding one JSON array of findings.
export function parseDiffFindings(output: string, commit: string): { findings: RawFinding[]; parseError?: string } {
	let body = output.trim();
	try {
		const outer = JSON.parse(body);
		if (Array.isArray(outer)) body = JSON.stringify(outer);
		else if (outer && typeof outer.result === "string") body = outer.result;
	} catch { /* not an envelope; search the raw text */ }
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start < 0 || end < start) return { findings: [], parseError: "no JSON array in reviewer output" };
	let list: unknown;
	try { list = JSON.parse(body.slice(start, end + 1)); } catch (error) { return { findings: [], parseError: `reviewer output is not valid JSON: ${(error as Error).message}` }; }
	if (!Array.isArray(list)) return { findings: [], parseError: "reviewer output is not a JSON array" };
	return {
		findings: list.map((entry): RawFinding => {
			try {
				const valid = validateFindingInput({ ...(entry && typeof entry === "object" ? entry : { value: entry }), planId: "review", taskId: "diff", commit });
				return { file: valid.file, line: valid.line, severity: valid.severity, text: valid.text };
			} catch (error) {
				const raw = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
				return { file: typeof raw.file === "string" ? raw.file : undefined, line: typeof raw.line === "number" ? raw.line : undefined, text: String(raw.text ?? JSON.stringify(entry)), invalid: (error as Error).message };
			}
		}),
	};
}

export async function reviewScore(runId: string): Promise<Record<string, unknown>> {
	const paths = await reviewPaths(runId);
	const fixture = await loadReviewFixture(paths.fixture);
	const runInfo = existsSync(path.join(paths.runDir, "review-run.json")) ? await readJson(path.join(paths.runDir, "review-run.json")) : null;
	const output = existsSync(path.join(paths.runDir, "review-output.txt")) ? await fs.readFile(path.join(paths.runDir, "review-output.txt"), "utf8") : "";
	let findings: RawFinding[] = [];
	let valid = true;
	let invalidReason: string | undefined;
	let parseError: string | undefined;
	if (paths.condition === "bundle") {
		const log = await readReviewLog(paths.agentDir, paths.runJson.sessionId);
		if (!log.events.some((event) => event.ev === "review_started")) {
			valid = false;
			invalidReason = "the reviewer never read the evidence (no review_started)";
		}
		findings = [...foldFindings(log.events).values()]
			.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
			.map((f) => ({ file: f.file, line: f.line, severity: f.severity, text: f.text }));
	} else {
		// Interactive fallback: the operator saves Cursor's reply as findings.json.
		const manual = path.join(paths.runDir, "findings.json");
		const source = existsSync(manual) ? await fs.readFile(manual, "utf8") : output;
		({ findings, parseError } = parseDiffFindings(source, paths.runJson.implCommit));
	}
	const scored = matchFindings(findings, fixture.labels);
	let usage: unknown = "unavailable";
	try {
		const envelope = JSON.parse(output);
		if (envelope && typeof envelope.usage === "object" && envelope.usage) usage = envelope.usage;
	} catch { /* no usage */ }

	const results = path.join(config().resultsDir, "review.jsonl");
	const prior = existsSync(results) ? (await fs.readFile(results, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.runId === runId) : [];
	const row = {
		schema: 1, kind: "review", runId, fixture: paths.fixture, condition: paths.condition, rep: paths.runJson.rep,
		scoredAt: new Date().toISOString(), ...(prior.length ? { rescoreOf: prior[prior.length - 1].scoredAt } : {}),
		mode: runInfo ? runInfo.mode : "interactive", model: runInfo?.model ?? (CURSOR_MODEL ?? "unpinned"),
		durationMs: runInfo ? Date.parse(runInfo.finishedAt) - Date.parse(runInfo.startedAt) : "unavailable",
		valid, ...(invalidReason ? { invalidReason } : {}), ...(parseError ? { parseError: sanitize(parseError) } : {}),
		labels: fixture.labels.length, tp: scored.tp, fp: scored.fp, fn: scored.fn, duplicates: scored.duplicates,
		findings: scored.findings.map((f) => ({ file: f.file, line: f.line, severity: f.severity, outcome: f.outcome, ...(f.reason ? { reason: sanitize(f.reason) } : {}), text: sanitize(f.text).slice(0, MAX_FINDING_TEXT_IN_ROW) })),
		usage, implTree: paths.runJson.implTree,
	};
	await fs.mkdir(config().resultsDir, { recursive: true });
	await fs.appendFile(results, `${JSON.stringify(row)}\n`);
	if (existsSync(path.join(paths.runDir, "review.pid"))) await reviewStop(runId);
	console.log(`${runId}: ${valid ? "" : "INVALID; "}tp ${scored.tp}, fp ${scored.fp}, fn ${scored.fn}, duplicates ${scored.duplicates}${parseError ? `; ${parseError}` : ""}`);
	return row;
}

// ---------------------------------------------------------------------------
// Report (PROTOCOL.md sections 7, 8, 11)

export const REPORT_START = "<!-- bench:generated:start (bench.ts report rewrites this block; edit outside it) -->";
export const REPORT_END = "<!-- bench:generated:end -->";
const WORKFLOWS = ["A", "B", "C"] as const;
const PAIRS = [["A", "B"], ["A", "C"], ["B", "C"]] as const;

async function readRows(file: string): Promise<any[]> {
	if (!existsSync(file)) return [];
	const latest = new Map<string, any>();
	for (const line of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		latest.set(row.runId, row);
	}
	return [...latest.values()];
}

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const minutes = (ms: number | null) => (ms === null ? "—" : (ms / 60_000).toFixed(1));
const totalTokens = (value: unknown): number | null => (value && typeof value === "object" ? Object.values(value as ModelUsage).reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheWrite, 0) : null);

// X beats Y only if X wins by >= 2 passes in total and out-passes Y on >= 2 tasks.
export function verdict(rows: any[], x: string, y: string): string {
	const tasks = [...new Set(rows.map((row) => row.task))];
	const passes = (wf: string, task: string) => rows.filter((row) => row.workflow === wf && row.task === task && row.pass === true).length;
	const decide = (a: string, b: string) => {
		const d = tasks.map((task) => passes(a, task) - passes(b, task));
		return d.reduce((sum, v) => sum + v, 0) >= 2 && d.filter((v) => v > 0).length >= 2;
	};
	if (decide(x, y)) return `${x} beats ${y}`;
	if (decide(y, x)) return `${y} beats ${x}`;
	return "no meaningful difference";
}

function table(header: string[], rows: string[][]): string {
	return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function renderReport(codingRows: any[], reviewRows: any[], incomplete: string[], pricesAsOf: string | null): string {
	const coding = codingRows.filter((row) => !isShakedown(row.runId));
	const review = reviewRows.filter((row) => !isShakedown(row.runId));
	const shakedown = [...codingRows, ...reviewRows].filter((row) => isShakedown(row.runId)).map((row) => row.runId).sort();
	const tasks = [...new Set(coding.map((row) => row.task))].sort();
	const byWf = (wf: string, rows = coding) => rows.filter((row) => row.workflow === wf);
	const out: string[] = [];
	out.push(`Coding runs scored: ${coding.length}. Review runs scored: ${review.length}. Every row is included; counts are descriptive, and nothing here is a claim of statistical significance (PROTOCOL.md section 8).`, "");

	out.push("### Hidden-test passes (passing runs / runs)", "");
	out.push(table(["Task", "Category", ...WORKFLOWS], tasks.map((task) => {
		const category = coding.find((row) => row.task === task)?.category ?? "";
		return [task, category, ...WORKFLOWS.map((wf) => {
			const runs = coding.filter((row) => row.task === task && row.workflow === wf);
			return runs.length ? `${runs.filter((row) => row.pass === true).length}/${runs.length}` : "—";
		})];
	})), "");
	const passCount = (wf: string) => byWf(wf).filter((row) => row.pass === true).length;
	out.push("```mermaid", "xychart-beta", '  title "Hidden-test passes per workflow"', "  x-axis [A, B, C]", `  y-axis "Passing runs" 0 --> ${Math.max(1, ...WORKFLOWS.map((wf) => byWf(wf).length))}`, `  bar [${WORKFLOWS.map(passCount).join(", ")}]`, "```", "");

	out.push("### Success-rule verdicts", "");
	const clean = coding.filter((row) => !row.contamination?.flagged);
	out.push(table(["Pair", "All runs", "Without contaminated runs", "Robust"], PAIRS.map(([x, y]) => {
		const all = verdict(coding, x, y);
		const without = verdict(clean, x, y);
		return [`${x}–${y}`, all, without, all === without ? "yes" : "no"];
	})), "");

	out.push("### Requirements failed (task × workflow, count of runs)", "");
	out.push(table(["Task", ...WORKFLOWS], tasks.map((task) => [task, ...WORKFLOWS.map((wf) => {
		const counts = new Map<string, number>();
		for (const row of coding.filter((r) => r.task === task && r.workflow === wf)) {
			for (const [req, ok] of Object.entries(row.requirements ?? {})) if (!ok) counts.set(req, (counts.get(req) ?? 0) + 1);
		}
		return counts.size ? [...counts].map(([req, n]) => `${req}×${n}`).join(", ") : "—";
	})])), "");

	out.push("### Time (median minutes)", "");
	out.push(table(["Workflow", "Runs", "Wall clock", "Agent time", "Hand-off wait"], WORKFLOWS.map((wf) => {
		const runs = byWf(wf);
		return [wf, String(runs.length), minutes(median(runs.map((r) => r.wallClockMs))), minutes(median(runs.map((r) => r.agentMs))), minutes(median(runs.map((r) => r.handoffWaitMs)))];
	})), "");

	out.push("### Tokens and estimated cost", "");
	out.push(`Medians over the runs where the value is available. Tokens include input, output, and cache tokens. Costs are estimates from list prices ${pricesAsOf ? `dated ${pricesAsOf}` : "that are not filled in yet"} (PROTOCOL.md section 7).`, "");
	const roleCell = (runs: any[], role: string, value: (row: any) => number | null) => {
		if (runs.every((row) => row.tokens?.[role] === "not-used")) return "not used";
		const values = runs.map(value).filter((v): v is number => typeof v === "number");
		const m = median(values);
		return m === null ? `unavailable (0 of ${runs.length})` : `${m.toLocaleString("en-US", { maximumFractionDigits: 4 })} (${values.length} of ${runs.length})`;
	};
	out.push(table(["Workflow", "Pi tokens", "Claude Code tokens", "Cursor tokens", "Pi est. USD", "Claude Code est. USD"], WORKFLOWS.map((wf) => {
		const runs = byWf(wf);
		return [wf, roleCell(runs, "pi", (r) => totalTokens(r.tokens?.pi)), roleCell(runs, "claude", (r) => totalTokens(r.tokens?.claude)), roleCell(runs, "cursor", (r) => totalTokens(r.tokens?.cursor)), roleCell(runs, "pi", (r) => (typeof r.cost?.pi === "number" ? r.cost.pi : null)), roleCell(runs, "claude", (r) => (typeof r.cost?.claude === "number" ? r.cost.claude : null))];
	})), "");

	out.push("### Human involvement, failures, and context", "");
	out.push(table(["Workflow", "Gates", "Interventions", "Context misses", "Workflow failures"], WORKFLOWS.map((wf) => {
		const runs = byWf(wf);
		const failures = new Map<string, number>();
		for (const row of runs) for (const kind of row.workflowFailures ?? []) failures.set(kind, (failures.get(kind) ?? 0) + 1);
		const sum = (key: string) => String(runs.reduce((n, row) => n + (row[key]?.length ?? 0), 0));
		return [wf, sum("gates"), sum("interventions"), sum("contextMisses"), failures.size ? [...failures].map(([k, n]) => `${k}×${n}`).join(", ") : "—"];
	})), "");
	const contaminated = coding.filter((row) => row.contamination?.flagged).map((row) => row.runId).sort();
	out.push(`Contaminated runs: ${contaminated.length ? contaminated.join(", ") : "none"}.`, "");

	out.push("### Review evaluation (valid reviews only)", "");
	out.push(table(["Condition", "Valid / all", "True pos.", "False pos.", "False neg.", "Duplicates", "Recall", "Precision", "False pos. on correct fixtures"], ["bundle", "diff"].map((condition) => {
		const all = review.filter((row) => row.condition === condition);
		const valid = all.filter((row) => row.valid);
		const sum = (key: string, rows = valid) => rows.reduce((n, row) => n + (row[key] ?? 0), 0);
		const tp = sum("tp"), fp = sum("fp"), fn = sum("fn");
		const ratio = (num: number, den: number) => (den ? (num / den).toFixed(2) : "n/a");
		return [condition, `${valid.length} / ${all.length}`, String(tp), String(fp), String(fn), String(sum("duplicates")), ratio(tp, tp + fn), ratio(tp, tp + fp), String(sum("fp", valid.filter((row) => row.labels === 0)))];
	})), "");
	const invalid = review.filter((row) => !row.valid).map((row) => `${row.runId} (${row.invalidReason ?? "invalid"})`);
	const interactive = review.filter((row) => row.mode === "interactive").map((row) => row.runId);
	out.push(`Invalid reviews: ${invalid.length ? invalid.join(", ") : "none"}. Interactive reviews: ${interactive.length ? interactive.join(", ") : "none"}.`, "");

	out.push("### Incomplete and shakedown runs", "");
	out.push(`Prepared but not scored: ${incomplete.length ? incomplete.join(", ") : "none"}.`, "");
	out.push(`Shakedown runs (excluded from the tables above): ${shakedown.length ? shakedown.join(", ") : "none"}.`);
	return out.join("\n");
}

export async function report(): Promise<string> {
	const cfg = config();
	const file = path.join(cfg.benchRoot, "REPORT.md");
	if (!existsSync(file)) throw new Error(`${file} is missing`);
	const text = await fs.readFile(file, "utf8");
	const start = text.indexOf(REPORT_START);
	const end = text.indexOf(REPORT_END);
	if (start < 0 || end < start || text.indexOf(REPORT_START, start + 1) >= 0) throw new Error("REPORT.md must contain exactly one generated block between its start and end markers");
	const coding = await readRows(path.join(cfg.resultsDir, "coding.jsonl"));
	const reviews = await readRows(path.join(cfg.resultsDir, "review.jsonl"));
	const scored = new Set([...coding, ...reviews].map((row) => row.runId));
	const runIds = existsSync(cfg.runsDir) ? (await fs.readdir(cfg.runsDir)).filter((name) => (RUN_ID.test(name) || REVIEW_RUN_ID.test(name)) && existsSync(path.join(cfg.runsDir, name, "run.json"))) : [];
	const incomplete = runIds.filter((id) => !scored.has(id)).sort();
	const prices = await readJson(path.join(cfg.benchRoot, "prices.json")).catch(() => null);
	const body = renderReport(coding, reviews, incomplete, prices?.asOf ?? null);
	const next = `${text.slice(0, start + REPORT_START.length)}\n\n${body}\n\n${text.slice(end)}`;
	await fs.writeFile(file, next);
	console.log(`REPORT.md regenerated from ${coding.length} coding and ${reviews.length} review rows; ${incomplete.length} incomplete run(s).`);
	return next;
}

const HELP = `bench.ts — benchmark pilot runner (rules: bench/PROTOCOL.md)

  prepare <task> <A|B|C> <rep>      Create run <task>-<wf>-r<rep> outside the repo and print launch steps
                                    (rep s1, s2, ... makes a shakedown run <task>-<wf>-s<n>)
  note <run> <kind> [text]          Record ${NOTE_KINDS.join("|")}
                                    handoff text starts with 'wait' or 'go'; context-miss with R<n>;
                                    abandon text may start with harness-error or tooling-failure
  score <run>                       Run hidden tests on the scored commit and append a results row
  check-tasks                       Verify every task: hidden tests fail on start, pass on solution
  review-prepare <rN> <bundle|diff> <rep>
                                    Build review run <rN>-<condition>-r<rep>; bundle keeps Pi running
  review-stop <run>                 Stop the Pi that review-prepare keeps running for a bundle run
  review-run <run> [--model <m>]    Run the Cursor reviewer headless (cursor-agent -p); --model only
                                    before CURSOR_MODEL is pinned
  review-score <run>                Match findings to hidden labels, append a review row, stop Pi.
                                    Interactive fallback: diff runs read findings.json in the run dir
  report                            Rewrite the generated block of bench/REPORT.md from results

Env: PI_BENCH_HOME (runs dir, default ~/.pi-bench/runs), PI_CODING_AGENT_DIR (host Pi dir for auth),
     CLAUDE_CONFIG_DIR (Claude Code dir for transcripts).`;

export async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	try {
		switch (command) {
			case "prepare":
				if (args.length !== 3) throw new Error("usage: prepare <task> <A|B|C> <rep>");
				await prepare(args[0], args[1], args[2]);
				return 0;
			case "note":
				if (args.length < 2) throw new Error("usage: note <run> <kind> [text]");
				await note(args[0], args[1], args.slice(2));
				return 0;
			case "score":
				if (args.length !== 1) throw new Error("usage: score <run>");
				await score(args[0]);
				return 0;
			case "check-tasks":
				return (await checkTasks()) ? 0 : 1;
			case "review-prepare":
				if (args.length !== 3) throw new Error("usage: review-prepare <rN> <bundle|diff> <rep>");
				return await reviewPrepareCommand(args[0], args[1], args[2]);
			case "review-stop":
				if (args.length !== 1) throw new Error("usage: review-stop <run>");
				await reviewStop(args[0]);
				return 0;
			case "review-run": {
				const modelAt = args.indexOf("--model");
				if (args.length !== 1 && !(args.length === 3 && modelAt === 1)) throw new Error("usage: review-run <run> [--model <m>]");
				await reviewRun(args[0], modelAt === 1 ? args[2] : undefined);
				return 0;
			}
			case "review-score":
				if (args.length !== 1) throw new Error("usage: review-score <run>");
				await reviewScore(args[0]);
				return 0;
			case "report":
				if (args.length !== 0) throw new Error("usage: report");
				await report();
				return 0;
			case undefined:
			case "help":
			case "--help":
				console.log(HELP);
				return 0;
			default:
				throw new Error(`unknown command ${JSON.stringify(command)}; see --help`);
		}
	} catch (error) {
		console.error(`error: ${(error as Error).message}`);
		return 1;
	}
}

// tsx compiles this file as CJS here, so no top-level await.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
