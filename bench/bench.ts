// Benchmark pilot runner. Rules live in bench/PROTOCOL.md; this file implements them.
// Usage: npx --yes tsx bench/bench.ts <command> [...args]   (see `help`)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactText } from "../agent/extensions/workflow-modes/review-redact.ts";

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
const RUN_ID = /^(t[0-9]{1,3})-([ABC])-r([1-9][0-9]{0,2})$/;
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
	if (!/^[1-9][0-9]{0,2}$/.test(rep)) throw new Error("rep must be a positive integer");
	const task = await loadTask(taskId);
	const cfg = config();
	const hostAuth = path.join(cfg.hostAgentDir, "auth.json");
	if (!existsSync(hostAuth)) throw new Error(`no Pi login at ${hostAuth}; log in to Pi first (or set PI_CODING_AGENT_DIR)`);
	const runsDir = await safeRunsDir();
	const runId = `${taskId}-${workflow}-r${rep}`;
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
		schema: 1, runId, task: taskId, workflow, rep: Number(rep), createdAt: new Date().toISOString(), startCommit,
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

const HELP = `bench.ts — benchmark pilot runner (rules: bench/PROTOCOL.md)

  prepare <task> <A|B|C> <rep>      Create run <task>-<wf>-r<rep> outside the repo and print launch steps
  note <run> <kind> [text]          Record ${NOTE_KINDS.join("|")}
                                    handoff text starts with 'wait' or 'go'; context-miss with R<n>;
                                    abandon text may start with harness-error or tooling-failure
  score <run>                       Run hidden tests on the scored commit and append a results row
  check-tasks                       Verify every task: hidden tests fail on start, pass on solution

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
