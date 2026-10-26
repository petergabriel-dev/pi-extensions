import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
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
import { HARNESS_MANIFEST } from "../agent/extensions/harness-setup/manifest.ts";
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
const LEASE_TTL_MS = 4 * 60 * 60 * 1000;
const LEASE_STATES = new Set([
	"none",
	"holder-self",
	"holder-other",
	"expired",
	"missing-expiry",
	"stale-heartbeat",
	"double-paired",
	"cross-session",
] as const);
const STDIN_KINDS = new Set(["empty", "non-json", "array", "oversized"] as const);
const CRASH_VARIANTS = ["missing", "syntax", "throws"] as const;

type Column = (typeof COLUMNS)[number];
type HarnessColumn = "claude" | "cursor" | "opencode";
type Outcome = "allow" | "wrap" | "ask" | "deny" | "throw";
type CaseClass = "read" | "write" | "ambiguous";
type LeaseState = "none" | "holder-self" | "holder-other" | "expired" | "missing-expiry" | "stale-heartbeat" | "double-paired" | "cross-session";
type StdinKind = "empty" | "non-json" | "array" | "oversized";
type CrashVariant = (typeof CRASH_VARIANTS)[number];
type SandboxEvidence = "P11";
type Expectation = string | string[] | Record<string, string | string[]>;
type ExpectationMap = Partial<Record<Column, Expectation>>;
type CorpusDefaults = Partial<Record<CaseClass, ExpectationMap>>;

const HARNESS_IDENTITIES: Record<HarnessColumn, { harness: HarnessColumn; id: string }> = {
	claude: { harness: "claude", id: "claude-security-seed" },
	cursor: { harness: "cursor", id: "cursor-security-seed" },
	opencode: { harness: "opencode", id: "opencode-security-seed" },
};

interface SecurityCase {
	id: string;
	class: CaseClass;
	kind: string;
	command?: string;
	tool?: string;
	server?: string;
	input?: unknown;
	identity?: string | null;
	lease?: LeaseState;
	stdin?: string;
	stdinKind?: StdinKind;
	event?: unknown;
	execute: boolean;
	knownGap?: string;
	sandboxEvidence?: SandboxEvidence;
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
	executed: number;
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

function expectationHasOutcome(value: Expectation | undefined, outcome: Outcome): boolean {
	if (typeof value === "string") return value === outcome;
	if (Array.isArray(value)) return value.includes(outcome);
	if (isRecord(value)) return Object.values(value).some((entry) => expectationHasOutcome(entry as Expectation, outcome));
	return false;
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
	const stdin = value.stdin;
	const stdinKind = value.stdinKind;
	const event = value.event;
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
	const sandboxEvidence = value.sandboxEvidence;
	if (sandboxEvidence !== undefined) {
		if (sandboxEvidence !== "P11") fail(`case ${id}: sandboxEvidence must be P11`);
		if (kind !== "shell") fail(`case ${id}: sandboxEvidence is only valid for shell cases`);
		if (execute) fail(`case ${id}: sandboxEvidence requires execute false`);
		if (knownGap !== undefined) fail(`case ${id}: use knownGap or sandboxEvidence, not both`);
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
	if (kind === "stdin") {
		if (!columns || columns.some((column) => column === "opencode" || column.startsWith("pi-"))) {
			fail(`case ${id}: stdin cases must pin Claude and/or Cursor columns`);
		}
		if (stdin !== undefined && typeof stdin !== "string") fail(`case ${id}: stdin must be a string`);
		if (stdinKind !== undefined && (typeof stdinKind !== "string" || !STDIN_KINDS.has(stdinKind as StdinKind))) {
			fail(`case ${id}: stdinKind must be empty, non-json, array, or oversized`);
		}
		if (stdin === undefined && stdinKind === undefined) fail(`case ${id}: stdin or stdinKind is required`);
		if (stdin !== undefined && stdinKind !== undefined) fail(`case ${id}: use stdin or stdinKind, not both`);
	} else if (stdin !== undefined || stdinKind !== undefined) {
		fail(`case ${id}: stdin fields are only valid for stdin cases`);
	}
	if (kind === "event") {
		if (!columns || columns.length !== 1 || columns[0] !== "opencode") fail(`case ${id}: event cases must pin the opencode column`);
		if (event === undefined) fail(`case ${id}: event is required for event cases`);
	} else if (event !== undefined) {
		fail(`case ${id}: event is only valid for event cases`);
	}
	const lease = value.lease;
	if (lease !== undefined) {
		if (typeof lease !== "string" || !LEASE_STATES.has(lease as LeaseState)) fail(`case ${id}: unknown lease state ${JSON.stringify(lease)}`);
		if (!columns || columns.some((column) => column.startsWith("pi-"))) fail(`case ${id}: lease cases must pin Claude, Cursor, or OpenCode columns`);
	}
	const ownExpectation = value.expect === undefined ? {} : parseExpectationMap(value.expect, `case ${id}`);
	const expectation: ExpectationMap = { ...(defaults[caseClass as CaseClass] ?? {}), ...ownExpectation };
	const targetColumns = columns ?? COLUMNS;
	for (const column of targetColumns) {
		if (expectation[column] === undefined) fail(`case ${id}: missing expectation for ${column}`);
	}
	const expectsWrap = targetColumns.some((column) => expectationHasOutcome(expectation[column], "wrap"));
	if (sandboxEvidence !== undefined && !expectsWrap) {
		fail(`case ${id}: sandboxEvidence requires an expected wrap outcome`);
	}
	if (kind === "shell" && !execute && knownGap === undefined && sandboxEvidence === undefined && expectsWrap) {
		fail(`case ${id}: non-executed wrapped shell case requires knownGap or sandboxEvidence P11`);
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
		...(typeof lease === "string" ? { lease: lease as LeaseState } : {}),
		...(typeof stdin === "string" ? { stdin } : {}),
		...(typeof stdinKind === "string" ? { stdinKind: stdinKind as StdinKind } : {}),
		...(event !== undefined ? { event } : {}),
		execute,
		...(typeof knownGap === "string" ? { knownGap } : {}),
		...(typeof sandboxEvidence === "string" ? { sandboxEvidence: sandboxEvidence as SandboxEvidence } : {}),
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

function stdinPayload(testCase: SecurityCase): string {
	if (testCase.stdin !== undefined) return testCase.stdin;
	switch (testCase.stdinKind) {
		case "empty":
			return "";
		case "non-json":
			return "{not json";
		case "array":
			return "[]";
		case "oversized":
			return "x".repeat(1024 * 1024);
		default:
			fail(`case ${testCase.id}: stdin payload is missing`);
	}
}

function stdinOutcome(testCase: SecurityCase, column: "claude" | "cursor", ctx: RunnerContext): RunResult {
	const command = column === "claude" ? ctx.claudeCommand : ctx.cursorCommands.beforeShellExecution;
	if (!command) fail(`installed ${column} stdin hook is missing`);
	const captured = spawnCaptured(command, stdinPayload(testCase), ctx.repo, ctx.env);
	if (captured.error) return hookFailure(captured.error, captured.result);
	if (captured.result.status !== 0) return hookFailure(captured.result.error, captured.result);
	const parsed = parseHookOutput(captured.result.stdout);
	if (column === "claude") return claudeDecision(parsed);
	const permission = parsed.permission;
	if (permission === "allow") return { outcome: "allow" };
	if (permission === "ask") return { outcome: "ask" };
	if (permission === "deny") return { outcome: "deny" };
	return { outcome: "throw", detail: `unknown Cursor permission ${JSON.stringify(permission)}` };
}

async function opencodeEventOutcome(testCase: SecurityCase, ctx: RunnerContext): Promise<RunResult> {
	try {
		await ctx.opencodeHandler(testCase.event);
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
	if (testCase.kind === "stdin") {
		if (column !== "claude" && column !== "cursor") fail(`case ${testCase.id}: stdin case cannot run on ${column}`);
		return stdinOutcome(testCase, column, ctx);
	}
	if (testCase.kind === "event") {
		if (column !== "opencode") fail(`case ${testCase.id}: event case cannot run on ${column}`);
		return opencodeEventOutcome(testCase, ctx);
	}
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

function createRunnerEnv(source: NodeJS.ProcessEnv, home: string, scratchDir: string, repo: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...source };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return {
		...env,
		HOME: home,
		TMPDIR: scratchDir,
		CLAUDE_PROJECT_DIR: repo,
		GIT_CONFIG_NOSYSTEM: "1",
		XDG_CONFIG_HOME: path.join(home, ".config"),
	};
}

function assertRunnerEnvIsolation(): void {
	const env = createRunnerEnv({
		GIT_DIR: "fixture",
		GIT_WORK_TREE: "fixture",
		GIT_INDEX_FILE: "fixture",
		XDG_CONFIG_HOME: "fixture",
	}, "/home", "/tmp", "/repo");
	assert.deepEqual(Object.keys(env).filter((key) => key.startsWith("GIT_")).sort(), ["GIT_CONFIG_NOSYSTEM"]);
	assert.equal(env.XDG_CONFIG_HOME, path.join("/home", ".config"));
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

	const env = createRunnerEnv(process.env, home, scratchDir, repo);
	delete env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC;
	if (sandboxDisabled) env.PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC = "1";

	try {
		runGit(repo, ["init", "-q"], env);
		runGit(repo, ["config", "user.email", "security-corpus@example.invalid"], env);
		runGit(repo, ["config", "user.name", "Security Corpus"], env);
		runGit(repo, ["add", "seed.txt"], env);
		runGit(repo, ["commit", "-qm", "seed"], env);
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
			executed: 0,
			claudeCommand,
			cursorCommands,
			opencodeHandler: handler,
		};
	} catch (error) {
		rmSync(runtime, { recursive: true, force: true });
		throw error;
	}
}

function harnessIdentity(column: HarnessColumn): { harness: HarnessColumn; id: string } {
	return HARNESS_IDENTITIES[column];
}

function otherHarnessIdentity(column: HarnessColumn): { harness: HarnessColumn; id: string } {
	return { harness: column, id: `${column}-other-security-seed` };
}

function makeLease(
	identity: { harness: HarnessColumn; id: string },
	options: { expired?: boolean; missingExpiry?: boolean } = {},
): Record<string, unknown> {
	const now = Date.now();
	const grantedAt = options.expired ? now - 10_000 : now;
	const lease: Record<string, unknown> = {
		harness: identity.harness,
		id: identity.id,
		planId: "security-plan",
		grantedAt,
	};
	if (!options.missingExpiry) lease.expiresAt = options.expired ? now - 1_000 : grantedAt + LEASE_TTL_MS;
	return lease;
}

function writePresence(
	ctx: RunnerContext,
	piSessionId: string,
	peers: Array<{ harness: HarnessColumn; id: string }>,
	buildLease?: Record<string, unknown>,
	heartbeatAt = new Date().toISOString(),
): void {
	const memory = path.join(ctx.repo, ".pi", "memory");
	const bridgeRoot = path.join(memory, "bridge");
	const sessions = path.join(bridgeRoot, "sessions");
	const namespace = path.join(sessions, piSessionId);
	const directories = [
		memory,
		bridgeRoot,
		sessions,
		namespace,
		path.join(namespace, "requests"),
		path.join(namespace, "responses"),
		path.join(namespace, "processed"),
	];
	for (const directory of directories) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}
	const presence = {
		schemaVersion: 2,
		piSessionId,
		name: `security ${piSessionId}`,
		mode: "plan",
		pid: process.pid,
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		heartbeatAt,
		peers: peers.map((peer) => ({ ...peer, pendingCount: 0, inboundPendingCount: 0 })),
		...(buildLease === undefined ? {} : { buildLease }),
	};
	const file = path.join(namespace, "presence.json");
	writeFileSync(file, `${JSON.stringify(presence, null, 2)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

function clearLeaseFixtures(ctx: RunnerContext): void {
	rmSync(path.join(ctx.repo, ".pi", "memory", "bridge"), { recursive: true, force: true });
}

function setupLease(testCase: SecurityCase, column: HarnessColumn, ctx: RunnerContext): void {
	clearLeaseFixtures(ctx);
	const state = testCase.lease;
	if (state === undefined || state === "none") return;
	const self = harnessIdentity(column);
	const other = otherHarnessIdentity(column);
	switch (state) {
		case "holder-self":
			writePresence(ctx, "pi-security-lease", [self], makeLease(self));
			return;
		case "holder-other":
			writePresence(ctx, "pi-security-lease", [self, other], makeLease(other));
			return;
		case "expired":
			writePresence(ctx, "pi-security-lease", [self], makeLease(self, { expired: true }));
			return;
		case "missing-expiry":
			writePresence(ctx, "pi-security-lease", [self], makeLease(self, { missingExpiry: true }));
			return;
		case "stale-heartbeat":
			writePresence(ctx, "pi-security-lease", [self], makeLease(self), new Date(Date.now() - 6_000).toISOString());
			return;
		case "double-paired":
			writePresence(ctx, "pi-security-a", [self], makeLease(self));
			writePresence(ctx, "pi-security-b", [self], makeLease(self));
			return;
		case "cross-session":
			writePresence(ctx, "pi-security-a", [self], makeLease(self));
			writePresence(ctx, "pi-security-b", [other], makeLease(other));
			return;
		default:
			fail(`case ${testCase.id}: unimplemented lease state ${JSON.stringify(state)}`);
	}
}

function resetRepo(ctx: RunnerContext): void {
	clearLeaseFixtures(ctx);
	runGit(ctx.repo, ["reset", "--hard", "HEAD"], ctx.env);
	runGit(ctx.repo, ["clean", "-fdx"], ctx.env);
	rmSync(path.join(ctx.repo, ".pi"), { recursive: true, force: true });
	mkdirSync(path.join(ctx.repo, ".pi"), { recursive: true });
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
	let failures = 0;

	for (const testCase of cases) {
		for (const column of testCase.columns ?? COLUMNS) {
			const expectation = testCase.expect[column];
			if (expectation === undefined) continue;
			const expected = outcomesFor(expectation, column, platform, ctx.sandboxDisabled);
			try {
				if (column === "claude" || column === "cursor" || column === "opencode") setupLease(testCase, column, ctx);
				const before = snapshotRepo(ctx.repo, ctx.env);
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
					ctx.executed += 1;
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
					const mutated = after !== before;
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
					if (after !== before) {
						stats[column].fail += 1;
						failures += 1;
						reportFailure(testCase, column, expected, result.outcome, "repository changed without an executed command");
						continue;
					}
				}
				stats[column].pass += 1;
			} finally {
				resetRepo(ctx);
			}
		}
	}

	console.log(`SUMMARY launcher=${ctx.launcher} executed=${ctx.executed}`);
	for (const column of COLUMNS) {
		const entry = stats[column];
		console.log(`${column}: pass=${entry.pass} fail=${entry.fail} knownGap=${entry.knownGap}`);
	}
	return failures;
}

function copyPackageAsset(sourceRoot: string, targetRoot: string, relative: string): void {
	const target = path.join(targetRoot, ...relative.split("/"));
	mkdirSync(path.dirname(target), { recursive: true });
	copyFileSync(path.join(sourceRoot, ...relative.split("/")), target);
}

function copyPackageForHarness(pkgRoot: string, harness: Harness): void {
	copyPackageAsset(PACKAGE_ROOT, pkgRoot, "package.json");
	for (const entry of HARNESS_MANIFEST[harness]) copyPackageAsset(PACKAGE_ROOT, pkgRoot, entry.script);
	if (harness === "opencode") {
		for (const script of ["pi-bridge-mcp.js", "pi-readonly-hook.js"]) {
			copyPackageAsset(PACKAGE_ROOT, pkgRoot, `agent/claude-bridge-client/${script}`);
		}
	}
}

function crashRoots(home: string): { claude: string; claudeMcp: string; cursor: string; opencode: string } {
	return {
		claude: path.join(home, ".claude"),
		claudeMcp: path.join(home, ".claude.json"),
		cursor: path.join(home, ".cursor"),
		opencode: path.join(home, ".config", "opencode"),
	};
}

function crashAsset(harness: Harness): string {
	if (harness === "claude") return "agent/claude-bridge-client/pi-readonly-hook.js";
	if (harness === "cursor") return "agent/cursor-bridge-client/cursor-readonly-hook.js";
	return "agent/opencode-bridge-client/pi-opencode-plugin.js";
}

function mutateCrashAsset(pkgRoot: string, harness: Harness, variant: CrashVariant): void {
	const file = path.join(pkgRoot, ...crashAsset(harness).split("/"));
	if (variant === "missing") {
		rmSync(file, { force: true });
		return;
	}
	if (variant === "syntax") {
		writeFileSync(file, "function broken( {\n", "utf8");
		return;
	}
	writeFileSync(file, "throw new Error(\"security corpus crash\");\n", "utf8");
}

async function installCrashPackage(
	ctx: RunnerContext,
	harness: Harness,
	variant: CrashVariant,
): Promise<{ home: string; pkgRoot: string; roots: ReturnType<typeof crashRoots> }> {
	const root = path.join(ctx.runtime, `crash-${harness}-${variant}`);
	const home = path.join(root, "home");
	const pkgRoot = path.join(root, "pkg");
	const agentDir = path.join(home, ".pi", "agent");
	for (const directory of [home, agentDir]) mkdirSync(directory, { recursive: true });
	copyPackageForHarness(pkgRoot, harness);
	const roots = crashRoots(home);
	const plan = await planInstall(harness, { pkgRoot, roots, agentDir });
	const results = await applyPlan(plan);
	const failed = results.find((result) => !result.applied);
	if (failed) fail(`installing crash package ${harness}/${variant} failed at ${failed.path}: ${failed.reason ?? "unknown error"}`);
	// Setup skips a missing package asset, so mutate the file the installed command points at.
	mutateCrashAsset(pkgRoot, harness, variant);
	return { home, pkgRoot, roots };
}

async function runCrashChecks(ctx: RunnerContext): Promise<number> {
	let pass = 0;
	let failures = 0;
	let hostLimits = 0;
	const stdin = JSON.stringify({ session_id: "claude-security-seed", cwd: ctx.repo, tool_name: "Read", tool_input: {} });

	for (const harness of ["claude", "cursor"] as const) {
		for (const variant of CRASH_VARIANTS) {
			try {
				const installed = await installCrashPackage(ctx, harness, variant);
				if (harness === "claude") {
					const settings = JSON.parse(readFileSync(path.join(installed.roots.claude, "settings.json"), "utf8")) as Record<string, unknown>;
					const command = installedHookCommand(settings, "PreToolUse", "pi-readonly-hook.js");
					if (!command) fail("installed Claude PreToolUse command is missing");
					if (!command.trimEnd().endsWith("|| exit 2")) fail("installed Claude PreToolUse command is missing the || exit 2 guard");
					const captured = spawnCaptured(command, stdin, ctx.repo, ctx.env);
					if (captured.error) throw captured.error;
					if (captured.result.status !== 2) {
						fail(`installed Claude command exited ${captured.result.status ?? "without status"}: ${captured.result.stderr.trim()}`);
					}
					pass += 1;
					console.log(`CRASH claude ${variant} installed-command-exit=2`);
				} else {
					const hooks = JSON.parse(readFileSync(path.join(installed.roots.cursor, "hooks.json"), "utf8")) as Record<string, unknown>;
					for (const event of ["beforeShellExecution", "beforeMCPExecution", "preToolUse"] as const) {
						if (!installedCursorHookCommand(hooks, event)) fail(`installed Cursor ${event} hook is missing`);
					}
					const command = installedCursorHookCommand(hooks, "beforeShellExecution");
					if (!command) fail("installed Cursor beforeShellExecution command is missing");
					const captured = spawnCaptured(command, stdin, ctx.repo, ctx.env);
					if (captured.error) throw captured.error;
					const status = captured.result.status;
					if (typeof status !== "number" || status === 0) fail(`broken Cursor hook exited ${status ?? "without status"}`);
					pass += 1;
					hostLimits += 1;
					console.log(`CRASH cursor ${variant} installed-hook-exit=${status} failClosed=true`);
					console.log(`HOST_LIMIT cursor ${variant}: Cursor host enforcement of failClosed after a nonzero hook exit is outside this in-process runner.`);
				}
			} catch (error) {
				failures += 1;
				console.error(`FAIL CRASH ${harness} ${variant}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	try {
		const installed = await installCrashPackage(ctx, "opencode", "throws");
		const pluginPath = path.join(installed.roots.opencode, "plugins", "pi-opencode-build-lease.js");
		if (!existsSync(pluginPath)) fail("installed OpenCode plugin is missing");
		let loadError: unknown;
		try {
			await import(`${pathToFileURL(pluginPath).href}?crash=${Date.now()}`);
		} catch (error) {
			loadError = error;
		}
		if (!(loadError instanceof Error) || !loadError.message.includes("security corpus crash")) {
			fail(`broken OpenCode plugin did not fail during load: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
		}
		pass += 1;
		hostLimits += 1;
		console.log("CRASH opencode plugin-load failed-as-expected");
		console.log("HOST_LIMIT opencode plugin-load: OpenCode host policy for a failed plugin load is outside this in-process runner.");
	} catch (error) {
		failures += 1;
		console.error(`FAIL CRASH opencode plugin-load: ${error instanceof Error ? error.message : String(error)}`);
	}

	console.log(`SUMMARY crash pass=${pass} fail=${failures} hostLimit=${hostLimits}`);
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
	assertRunnerEnvIsolation();
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
		let failures = await runCorpus(cases, ctx, process.platform);
		if (process.platform === "darwin" && !sandboxDisabled && ctx.executed === 0) {
			console.error(`FAIL macOS Seatbelt lane executed 0 cases (launcher=${ctx.launcher})`);
			failures += 1;
		}
		const crashFailures = await runCrashChecks(ctx);
		if (failures + crashFailures > 0) process.exitCode = 1;
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
