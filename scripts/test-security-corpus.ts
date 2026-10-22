import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyPlan, planInstall } from "../agent/extensions/harness-setup/setup.ts";
import type { Harness } from "../agent/extensions/harness-setup/manifest.ts";
import { isBashAllowedInMode } from "../agent/extensions/workflow-modes/policy.ts";
import { detectLauncher, wrapCommand } from "../agent/extensions/workflow-modes/sandbox.ts";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_CORPUS = path.join(PACKAGE_ROOT, "scripts", "security-corpus.json");
const COLUMNS = ["claude", "cursor", "opencode", "pi-discuss", "pi-plan"] as const;
const OUTCOMES = new Set(["allow", "wrap", "ask", "deny", "throw"]);
const CLASSES = new Set(["read", "write", "ambiguous"]);
const PLATFORM_KEYS = new Set(["darwin", "linux", "sandbox-disabled", "default"]);
const EXEC_TIMEOUT_MS = 10_000;

type Column = (typeof COLUMNS)[number];
type Outcome = "allow" | "wrap" | "ask" | "deny" | "throw";
type CaseClass = "read" | "write" | "ambiguous";
type Expectation = string | string[] | Record<string, string | string[]>;
type ExpectationMap = Partial<Record<Column, Expectation>>;
type CorpusDefaults = Partial<Record<CaseClass, ExpectationMap>>;

interface SecurityCase {
	id: string;
	class: CaseClass;
	kind: string;
	command?: string;
	tool?: string;
	server?: string;
	input?: unknown;
	identity?: string | null;
	execute: boolean;
	knownGap?: string;
	columns?: Column[];
	mutation: "none" | "allowed";
	expect: Partial<Record<Column, Expectation>>;
}

interface RunnerContext {
	runtime: string;
	home: string;
	repo: string;
	scratchDir: string;
	env: NodeJS.ProcessEnv;
	launcher: ReturnType<typeof detectLauncher>;
	sandboxDisabled: boolean;
	claudeCommand: string;
	cursorCommands: Partial<Record<"beforeShellExecution" | "beforeMCPExecution" | "preToolUse", string>>;
	opencodeHandler: (event: unknown) => Promise<void>;
}

interface RunResult {
	outcome: Outcome;
	command?: string;
	detail?: string;
}

interface ColumnStats {
	pass: number;
	fail: number;
	knownGap: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(message);
}

function validateOutcomeValue(value: unknown, where: string): void {
	if (typeof value === "string") {
		if (!OUTCOMES.has(value)) fail(`${where}: unknown outcome ${JSON.stringify(value)}`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) fail(`${where}: outcome list is empty`);
		for (const item of value) validateOutcomeValue(item, where);
		return;
	}
	if (isRecord(value)) {
		const keys = Object.keys(value);
		if (keys.length === 0) fail(`${where}: platform expectation is empty`);
		for (const key of keys) {
			if (!PLATFORM_KEYS.has(key)) fail(`${where}: unknown platform ${JSON.stringify(key)}`);
			validateOutcomeValue(value[key], `${where}.${key}`);
		}
		return;
	}
	fail(`${where}: expectation must be a string, string array, or platform map`);
}

function parseExpectationMap(value: unknown, where: string): ExpectationMap {
	if (!isRecord(value)) fail(`${where} must be an object`);
	const expectation: ExpectationMap = {};
	for (const [column, expectationValue] of Object.entries(value)) {
		if (!COLUMNS.includes(column as Column)) fail(`${where}: unknown column ${JSON.stringify(column)}`);
		validateOutcomeValue(expectationValue, `${where} ${column}`);
		expectation[column as Column] = expectationValue as Expectation;
	}
	return expectation;
}

function containmentViolation(command: string): string | null {
	if (/(^|[\s"'=])~(?=$|[\s"'/])/.test(command)) return "home-relative path";
	if (/\$(?:\{HOME\}|HOME\b)/.test(command)) return "$HOME reference";
	if (/(^|[\s"'=/])\.\.(?=$|[\s"'/])/.test(command)) return "parent path";
	for (const match of command.matchAll(/(^|[\s"'=<>|&;])(\/[^\s"';&|)]*)/g)) {
		const absolute = match[2];
		if (absolute !== "/dev/null") return `absolute path ${absolute}`;
	}
	return null;
}

function parseCase(value: unknown, index: number, defaults: CorpusDefaults): SecurityCase {
	if (!isRecord(value)) fail(`cases[${index}] must be an object`);
	const id = value.id;
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) {
		fail(`cases[${index}].id must be a lowercase identifier`);
	}
	const caseClass = value.class;
	if (typeof caseClass !== "string" || !CLASSES.has(caseClass)) {
		fail(`case ${id}: class must be read, write, or ambiguous`);
	}
	const kind = value.kind;
	if (typeof kind !== "string" || !kind) fail(`case ${id}: kind is required`);
	const execute = value.execute === undefined ? true : value.execute;
	if (typeof execute !== "boolean") fail(`case ${id}: execute must be boolean`);
	const command = value.command;
	if (kind === "shell") {
		if (typeof command !== "string" || !command.trim()) fail(`case ${id}: shell command is required`);
		if (execute) {
			const violation = containmentViolation(command);
			if (violation) fail(`case ${id}: executable command violates containment (${violation})`);
		}
	} else if (command !== undefined && typeof command !== "string") {
		fail(`case ${id}: command must be a string`);
	}
	const toolKind = kind === "tool" || kind === "mcp";
	const tool = value.tool;
	const server = value.server;
	const input = value.input;
	const identity = value.identity;
	if (toolKind) {
		if (typeof tool !== "string" || !tool.trim()) fail(`case ${id}: tool is required for ${kind} cases`);
		if (input !== undefined && input !== null && !isRecord(input)) fail(`case ${id}: input must be an object or null`);
		if (server !== undefined && typeof server !== "string") fail(`case ${id}: server must be a string`);
		if (identity !== undefined && identity !== null
			&& (typeof identity !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity))) {
			fail(`case ${id}: identity must be a safe id or null`);
		}
	}
	const knownGap = value.knownGap;
	if (knownGap !== undefined && (typeof knownGap !== "string" || !/^F\d+$/.test(knownGap))) {
		fail(`case ${id}: knownGap must use an F<n> finding id`);
	}
	let columns: Column[] | undefined;
	if (value.columns !== undefined) {
		if (!Array.isArray(value.columns) || value.columns.length === 0) fail(`case ${id}: columns must be a non-empty array`);
		columns = value.columns.map((column) => {
			if (typeof column !== "string" || !COLUMNS.includes(column as Column)) fail(`case ${id}: unknown column ${JSON.stringify(column)}`);
			return column as Column;
		});
		if (new Set(columns).size !== columns.length) fail(`case ${id}: columns contains duplicates`);
	}
	if (toolKind && (!columns || columns.some((column) => column.startsWith("pi-")))) {
		fail(`case ${id}: ${kind} cases must pin Claude, Cursor, or OpenCode columns`);
	}
	const ownExpectation = value.expect === undefined ? {} : parseExpectationMap(value.expect, `case ${id}`);
	const expectation: ExpectationMap = { ...(defaults[caseClass as CaseClass] ?? {}), ...ownExpectation };
	const targetColumns = columns ?? COLUMNS;
	for (const column of targetColumns) {
		if (expectation[column] === undefined) fail(`case ${id}: missing expectation for ${column}`);
	}
	const mutation = value.mutation === undefined ? "none" : value.mutation;
	if (mutation !== "none" && mutation !== "allowed") fail(`case ${id}: mutation must be none or allowed`);
	return {
		id,
		class: caseClass as CaseClass,
		kind,
		...(typeof command === "string" ? { command } : {}),
		...(typeof tool === "string" ? { tool } : {}),
		...(typeof server === "string" ? { server } : {}),
		...(input !== undefined ? { input } : {}),
		...(identity !== undefined ? { identity } : {}),
		execute,
		...(typeof knownGap === "string" ? { knownGap } : {}),
		...(columns ? { columns } : {}),
		mutation,
		expect: expectation,
	};
}

function loadCorpus(file: string): SecurityCase[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`cannot read corpus ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) fail("corpus root must be an object");
	if (parsed.version !== 1) fail("corpus version must be 1");
	if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) fail("corpus cases must be a non-empty array");
	const defaults: CorpusDefaults = {};
	if (parsed.defaults !== undefined) {
		if (!isRecord(parsed.defaults)) fail("corpus defaults must be an object");
		for (const [caseClass, value] of Object.entries(parsed.defaults)) {
			if (!CLASSES.has(caseClass)) fail(`unknown default class ${JSON.stringify(caseClass)}`);
			defaults[caseClass as CaseClass] = parseExpectationMap(value, `defaults.${caseClass}`);
		}
	}
	const cases = parsed.cases.map((value, index) => parseCase(value, index, defaults));
	const ids = new Set<string>();
	for (const entry of cases) {
		if (ids.has(entry.id)) fail(`duplicate case id ${entry.id}`);
		ids.add(entry.id);
	}
	return cases;
}

function outcomesFor(expectation: Expectation | undefined, column: Column, platform: string, sandboxDisabled: boolean): string[] {
	if (expectation === undefined) fail(`${column}: expectation is missing`);
	if (typeof expectation === "string") return [expectation];
	if (Array.isArray(expectation)) return expectation;
	const value = (sandboxDisabled ? expectation["sandbox-disabled"] : undefined) ?? expectation[platform] ?? expectation.default;
	if (value === undefined) fail(`${column}: no expectation for platform ${platform}`);
	return Array.isArray(value) ? value : [value];
}

function formatExpected(values: string[]): string {
	return values.join("|");
}

function spawnCaptured(command: string, input: string, cwd: string, env: NodeJS.ProcessEnv) {
	const result = spawnSync("sh", ["-c", command], {
		input,
		cwd,
		env,
		encoding: "utf8",
		timeout: EXEC_TIMEOUT_MS,
	});
	if (result.error) return { error: result.error, result };
	return { result };
}

function parseHookOutput(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	if (!trimmed) fail("hook returned no output");
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!isRecord(parsed)) fail("hook output is not a JSON object");
		return parsed;
	} catch (error) {
		fail(`hook output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function hookFailure(error: unknown, result: ReturnType<typeof spawnSync>): RunResult {
	const timedOut = isRecord(error) && error.code === "ETIMEDOUT";
	const detail = timedOut
		? `hook exceeded ${EXEC_TIMEOUT_MS}ms`
		: `hook exited ${typeof result.status === "number" ? result.status : "without status"}`;
	return { outcome: "throw", detail };
}

function claudeDecision(parsed: Record<string, unknown>, command?: string): RunResult {
	const hook = parsed.hookSpecificOutput;
	if (hook === undefined) {
		if (Object.keys(parsed).length === 0) return { outcome: "allow", ...(command !== undefined ? { command } : {}) };
		return { outcome: "throw", detail: "hook output is missing hookSpecificOutput" };
	}
	if (!isRecord(hook)) return { outcome: "throw", detail: "hookSpecificOutput is not an object" };
	const decision = hook.permissionDecision;
	if (decision === "deny") return { outcome: "deny" };
	if (decision === "ask") return { outcome: "ask" };
	if (decision !== "allow") return { outcome: "throw", detail: `unknown permissionDecision ${JSON.stringify(decision)}` };
	if (command !== undefined && isRecord(hook.updatedInput) && typeof hook.updatedInput.command === "string" && hook.updatedInput.command !== command) {
		return { outcome: "wrap", command: hook.updatedInput.command };
	}
	return { outcome: "allow", ...(command !== undefined ? { command } : {}) };
}

function claudeOutcome(testCase: SecurityCase, ctx: RunnerContext): RunResult {
	const command = testCase.command ?? "";
	const input = JSON.stringify({
		session_id: "claude-security-seed",
		cwd: ctx.repo,
		tool_name: "Bash",
		tool_input: { command },
	});
	const captured = spawnCaptured(ctx.claudeCommand, input, ctx.repo, ctx.env);
	if (captured.error) return hookFailure(captured.error, captured.result);
	if (captured.result.status !== 0) return hookFailure(captured.result.error, captured.result);
	return claudeDecision(parseHookOutput(captured.result.stdout), command);
}

function claudeToolOutcome(testCase: SecurityCase, ctx: RunnerContext): RunResult {
	const identity = testCase.identity === undefined ? "claude-security-seed" : testCase.identity;
	const input: Record<string, unknown> = {
		cwd: ctx.repo,
		tool_name: testCase.tool,
	};
	if (identity !== null) input.session_id = identity;
	if (testCase.input !== undefined && testCase.input !== null) input.tool_input = testCase.input;
	const captured = spawnCaptured(ctx.claudeCommand, JSON.stringify(input), ctx.repo, ctx.env);
	if (captured.error) return hookFailure(captured.error, captured.result);
	if (captured.result.status !== 0) return hookFailure(captured.result.error, captured.result);
	return claudeDecision(parseHookOutput(captured.result.stdout));
}

function cursorOutcome(testCase: SecurityCase, ctx: RunnerContext): RunResult {
	const command = testCase.command ?? "";
	const input = JSON.stringify({
		hook_event_name: "beforeShellExecution",
		cwd: ctx.repo,
		conversation_id: "cursor-security-seed",
		command,
	});
	const hook = ctx.cursorCommands.beforeShellExecution;
	if (!hook) fail("installed Cursor beforeShellExecution hook is missing");
	const captured = spawnCaptured(hook, input, ctx.repo, ctx.env);
	if (captured.error) return hookFailure(captured.error, captured.result);
	if (captured.result.status !== 0) return hookFailure(captured.result.error, captured.result);
	const parsed = parseHookOutput(captured.result.stdout);
	const permission = parsed.permission;
	if (permission === "allow") return { outcome: "allow", command };
	if (permission === "ask") return { outcome: "ask" };
	if (permission === "deny") return { outcome: "deny" };
	return { outcome: "throw", detail: `unknown Cursor permission ${JSON.stringify(permission)}` };
}

async function opencodeOutcome(testCase: SecurityCase, ctx: RunnerContext): Promise<RunResult> {
	const command = testCase.command ?? "";
	const input = { command };
	try {
		await ctx.opencodeHandler({
			tool: "shell",
			sessionID: "opencode-security-seed",
			input,
		});
	} catch (error) {
		return { outcome: "throw", detail: error instanceof Error ? error.message : String(error) };
	}
	if (input.command !== command) return { outcome: "wrap", command: input.command };
	return { outcome: "allow", command };
}

function cursorToolOutcome(testCase: SecurityCase, ctx: RunnerContext): RunResult {
	const identity = testCase.identity === undefined ? "cursor-security-seed" : testCase.identity;
	const event = testCase.kind === "mcp" ? "beforeMCPExecution" : "preToolUse";
	const input: Record<string, unknown> = {
		hook_event_name: event,
		cwd: ctx.repo,
	};
	if (identity !== null) input.conversation_id = identity;
	if (event === "beforeMCPExecution") {
		input.mcp_server_name = testCase.server ?? "";
		input.mcp_tool_name = testCase.tool;
	} else {
		input.tool_name = testCase.tool;
	}
	if (testCase.input !== undefined && testCase.input !== null) input.tool_input = testCase.input;
	const hook = ctx.cursorCommands[event];
	if (!hook) fail(`installed Cursor ${event} hook is missing`);
	const captured = spawnCaptured(hook, JSON.stringify(input), ctx.repo, ctx.env);
	if (captured.error) return hookFailure(captured.error, captured.result);
	if (captured.result.status !== 0) return hookFailure(captured.result.error, captured.result);
	const parsed = parseHookOutput(captured.result.stdout);
	const permission = parsed.permission;
	if (permission === "allow") return { outcome: "allow" };
	if (permission === "ask") return { outcome: "ask" };
	if (permission === "deny") return { outcome: "deny" };
	return { outcome: "throw", detail: `unknown Cursor permission ${JSON.stringify(permission)}` };
}

async function opencodeToolOutcome(testCase: SecurityCase, ctx: RunnerContext): Promise<RunResult> {
	const identity = testCase.identity === undefined ? "opencode-security-seed" : testCase.identity;
	const event: Record<string, unknown> = { tool: testCase.tool };
	if (identity !== null) event.sessionID = identity;
	if (testCase.input !== undefined && testCase.input !== null) event.input = testCase.input;
	try {
		await ctx.opencodeHandler(event);
	} catch (error) {
		return { outcome: "throw", detail: error instanceof Error ? error.message : String(error) };
	}
	return { outcome: "allow" };
}

function piOutcome(testCase: SecurityCase, column: "pi-discuss" | "pi-plan", ctx: RunnerContext): RunResult {
	const command = testCase.command ?? "";
	const mode = column === "pi-discuss" ? "discuss" : "plan";
	if (!isBashAllowedInMode(command, mode)) return { outcome: "deny" };
	if (ctx.launcher === "none") return { outcome: "allow", command };
	const wrapped = wrapCommand(command, {
		cwd: ctx.repo,
		scratchDir: ctx.scratchDir,
		launcher: ctx.launcher,
	});
	if (!wrapped.wrapped) return { outcome: "allow", command };
	return { outcome: "wrap", command: wrapped.command };
}

async function runColumn(testCase: SecurityCase, column: Column, ctx: RunnerContext): Promise<RunResult> {
	if (column === "pi-discuss" || column === "pi-plan") {
		if (testCase.kind !== "shell") fail(`case ${testCase.id}: ${testCase.kind} case cannot run on ${column}`);
		return piOutcome(testCase, column, ctx);
	}
	if (testCase.kind === "shell") {
		if (column === "claude") return claudeOutcome(testCase, ctx);
		if (column === "cursor") return cursorOutcome(testCase, ctx);
		return opencodeOutcome(testCase, ctx);
	}
	if (testCase.kind === "tool" || testCase.kind === "mcp") {
		if (column === "claude") return claudeToolOutcome(testCase, ctx);
		if (column === "cursor") return cursorToolOutcome(testCase, ctx);
		return opencodeToolOutcome(testCase, ctx);
	}
	fail(`case ${testCase.id}: unsupported kind ${testCase.kind}`);
}

function runGit(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
	const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: EXEC_TIMEOUT_MS });
	if (result.error) fail(`git ${args.join(" ")} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
	return result.stdout;
}

function snapshotRepo(repo: string, env: NodeJS.ProcessEnv): string {
	const lines: string[] = [];
	const walk = (directory: string, prefix: string): void => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const relative = prefix ? path.join(prefix, entry.name) : entry.name;
			const absolute = path.join(directory, entry.name);
			if (relative === path.join(".git", "index")) continue;
			if (entry.isSymbolicLink()) {
				lines.push(`L ${relative} ${readlinkSync(absolute)}`);
			} else if (entry.isDirectory()) {
				lines.push(`D ${relative}`);
				walk(absolute, relative);
			} else if (entry.isFile()) {
				lines.push(`F ${relative} ${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`);
			} else {
				lines.push(`O ${relative}`);
			}
		}
	};
	walk(repo, "");
	const listing = runGit(repo, ["ls-files", "-s"], env);
	return createHash("sha256").update(`${lines.join("\n")}\n--\n${listing}`).digest("hex");
}

function executeCommand(command: string, ctx: RunnerContext) {
	return spawnSync("sh", ["-c", command], {
		cwd: ctx.repo,
		env: ctx.env,
		encoding: "utf8",
		timeout: EXEC_TIMEOUT_MS,
	});
}

async function createContext(sandboxDisabled: boolean): Promise<RunnerContext> {
	const runtime = mkdtempSync(path.join(tmpdir(), "pi-security-corpus-"));
	const home = path.join(runtime, "home");
	const repo = path.join(runtime, "repo");
	const scratchDir = path.join(runtime, "tmp");
	const agentDir = path.join(home, ".pi", "agent");
	const roots = {
		claude: path.join(home, ".claude"),
		claudeMcp: path.join(home, ".claude.json"),
		cursor: path.join(home, ".cursor"),
		opencode: path.join(home, ".config", "opencode"),
	};
	for (const directory of [home, repo, scratchDir, agentDir]) mkdirSync(directory, { recursive: true });
	mkdirSync(path.join(repo, ".pi"), { recursive: true });
	writeFileSync(path.join(repo, "seed.txt"), "original\n", "utf8");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		TMPDIR: scratchDir,
		CLAUDE_PROJECT_DIR: repo,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC;
	if (sandboxDisabled) env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC = "1";
	runGit(repo, ["init", "-q"], env);
	runGit(repo, ["config", "user.email", "security-corpus@example.invalid"], env);
	runGit(repo, ["config", "user.name", "Security Corpus"], env);
	runGit(repo, ["add", "seed.txt"], env);
	runGit(repo, ["commit", "-qm", "seed"], env);

	try {
		for (const harness of ["claude", "cursor", "opencode"] as const satisfies Harness[]) {
			const plan = await planInstall(harness, { pkgRoot: PACKAGE_ROOT, roots, agentDir });
			const results = await applyPlan(plan);
			const failed = results.find((result) => !result.applied);
			if (failed) fail(`installing ${harness} failed at ${failed.path}: ${failed.reason ?? "unknown error"}`);
		}

		const claudeSettings = JSON.parse(readFileSync(path.join(roots.claude, "settings.json"), "utf8")) as Record<string, unknown>;
		const claudeCommand = installedHookCommand(claudeSettings, "PreToolUse", "pi-readonly-hook.js");
		if (!claudeCommand) fail("installed Claude PreToolUse command is missing");
		if (!claudeCommand.trimEnd().endsWith("|| exit 2")) fail("installed Claude PreToolUse command is missing the || exit 2 guard");

		const cursorHooks = JSON.parse(readFileSync(path.join(roots.cursor, "hooks.json"), "utf8")) as Record<string, unknown>;
		const cursorCommands: RunnerContext["cursorCommands"] = {};
		for (const event of ["beforeShellExecution", "beforeMCPExecution", "preToolUse"] as const) {
			const command = installedCursorHookCommand(cursorHooks, event);
			if (!command) fail(`installed Cursor ${event} hook is missing`);
			cursorCommands[event] = command;
		}

		const pluginPath = path.join(roots.opencode, "plugins", "pi-opencode-build-lease.js");
		if (!existsSync(pluginPath)) fail("installed OpenCode plugin is missing");
		const imported = (await import(`${pathToFileURL(pluginPath).href}?security-corpus=${Date.now()}`)) as {
			default?: { setup?: (context: unknown) => void };
		};
		const plugin = imported.default;
		if (!plugin || typeof plugin.setup !== "function") fail("installed OpenCode plugin has no setup export");
		let handler: ((event: unknown) => Promise<void>) | undefined;
		plugin.setup({
			location: { directory: repo },
			tool: {
				hook(name: unknown, callback: unknown) {
					if (name !== "execute.before") fail(`unexpected OpenCode hook ${String(name)}`);
					if (typeof callback !== "function") fail("OpenCode hook callback is not a function");
					handler = callback as (event: unknown) => Promise<void>;
				},
			},
		});
		if (!handler) fail("installed OpenCode plugin registered no execute.before hook");

		return {
			runtime,
			home,
			repo,
			scratchDir,
			env,
			launcher: detectLauncher(),
			sandboxDisabled,
			claudeCommand,
			cursorCommands,
			opencodeHandler: handler,
		};
	} catch (error) {
		rmSync(runtime, { recursive: true, force: true });
		throw error;
	}
}

function installedHookCommand(settings: Record<string, unknown>, event: string, script: string): string | undefined {
	const hooks = settings.hooks;
	if (!isRecord(hooks)) return undefined;
	const groups = hooks[event];
	if (!Array.isArray(groups)) return undefined;
	for (const group of groups) {
		if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
		for (const hook of group.hooks) {
			if (isRecord(hook) && typeof hook.command === "string" && hook.command.includes(script)) return hook.command;
		}
	}
	return undefined;
}

function installedCursorHookCommand(hooks: Record<string, unknown>, event: string): string | undefined {
	const container = hooks.hooks;
	if (!isRecord(container)) return undefined;
	const groups = container[event];
	if (!Array.isArray(groups)) return undefined;
	for (const group of groups) {
		if (!isRecord(group) || typeof group.command !== "string" || !group.command.includes("cursor-readonly-hook.js")) continue;
		if (group.failClosed !== true) fail(`installed Cursor ${event} hook is missing failClosed: true`);
		return group.command;
	}
	return undefined;
}

function reportFailure(testCase: SecurityCase, column: Column, expected: string[], outcome: string, detail?: string): void {
	console.error(`FAIL ${testCase.id} ${column} expected ${formatExpected(expected)} got ${outcome}`);
	if (detail) console.error(`  ${detail}`);
}

async function runCorpus(cases: SecurityCase[], ctx: RunnerContext, platform: string): Promise<number> {
	const stats = Object.fromEntries(COLUMNS.map((column) => [column, { pass: 0, fail: 0, knownGap: 0 }])) as Record<Column, ColumnStats>;
	const initial = snapshotRepo(ctx.repo, ctx.env);
	let failures = 0;

	for (const testCase of cases) {
		for (const column of testCase.columns ?? COLUMNS) {
			const expectation = testCase.expect[column];
			if (expectation === undefined) continue;
			const expected = outcomesFor(expectation, column, platform, ctx.sandboxDisabled);
			let result: RunResult;
			try {
				result = await runColumn(testCase, column, ctx);
			} catch (error) {
				result = { outcome: "throw", detail: error instanceof Error ? error.message : String(error) };
			}

			const matched = expected.includes(result.outcome);
			if (testCase.knownGap) {
				if (matched) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, `gap closed: remove knownGap marker ${testCase.knownGap}`);
				} else {
					stats[column].knownGap += 1;
				}
				continue;
			}
			if (!matched) {
				stats[column].fail += 1;
				failures += 1;
				reportFailure(testCase, column, expected, result.outcome, result.detail);
				continue;
			}

			if (testCase.kind === "shell" && testCase.execute && (result.outcome === "wrap" || result.outcome === "allow")) {
				const command = result.command ?? testCase.command;
				if (!command) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, "allowed shell outcome has no command");
					continue;
				}
				const executed = executeCommand(command, ctx);
				if (executed.error) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, `execution failed: ${executed.error.message}`);
					continue;
				}
				if (testCase.class === "read" && executed.status !== 0) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, `read command exited ${executed.status}`);
					continue;
				}
				const after = snapshotRepo(ctx.repo, ctx.env);
				const mutated = after !== initial;
				if (testCase.mutation === "allowed" && !mutated) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, "expected mutation but repository is unchanged");
					continue;
				}
				if (testCase.mutation === "none" && mutated) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, "repository changed unexpectedly");
					continue;
				}
			} else {
				const after = snapshotRepo(ctx.repo, ctx.env);
				if (after !== initial) {
					stats[column].fail += 1;
					failures += 1;
					reportFailure(testCase, column, expected, result.outcome, "repository changed without an executed command");
					continue;
				}
			}
			stats[column].pass += 1;
		}
	}

	console.log(`SUMMARY launcher=${ctx.launcher}`);
	for (const column of COLUMNS) {
		const entry = stats[column];
		console.log(`${column}: pass=${entry.pass} fail=${entry.fail} knownGap=${entry.knownGap}`);
	}
	return failures;
}

function corruptExpectation(cases: SecurityCase[]): void {
	const first = cases[0];
	if (!first) fail("corpus has no cases");
	const column = COLUMNS.find((candidate) => first.expect[candidate] !== undefined);
	if (!column) fail("first case has no expectation");
	first.expect[column] = "ask";
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const validateIndex = args.indexOf("--validate-corpus");
	if (validateIndex !== -1) {
		const file = args[validateIndex + 1];
		if (!file) fail("--validate-corpus requires a file path");
		const cases = loadCorpus(path.resolve(file));
		console.log(`Corpus valid: ${cases.length} cases.`);
		return;
	}
	const cases = loadCorpus(DEFAULT_CORPUS);
	if (args.includes("--corrupt-expectation")) corruptExpectation(cases);
	const sandboxDisabled = args.includes("--sandbox-disabled");
	const ctx = await createContext(sandboxDisabled);
	let previousHome: string | undefined;
	let previousTmpdir: string | undefined;
	let previousSandboxDisabled: string | undefined;
	try {
		previousHome = process.env.HOME;
		previousTmpdir = process.env.TMPDIR;
		previousSandboxDisabled = process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC;
		process.env.HOME = ctx.home;
		process.env.TMPDIR = ctx.scratchDir;
		if (sandboxDisabled) process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC = "1";
		else delete process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC;
		const failures = await runCorpus(cases, ctx, process.platform);
		if (failures > 0) process.exitCode = 1;
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		if (previousSandboxDisabled === undefined) delete process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC;
		else process.env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC = previousSandboxDisabled;
		rmSync(ctx.runtime, { recursive: true, force: true });
	}
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
