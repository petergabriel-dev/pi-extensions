import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { CODEX_PRETOOL_GUARD, CURSOR_HOOK_FAIL_CLOSED, HARNESS_MANIFEST, MAX_CONFIG_BYTES, PI_BRIDGE_MCP_KEY, STATUSLINE_REFRESH_INTERVAL } from "./manifest.ts";
import type { Harness, HarnessEntry } from "./manifest.ts";
import { CODEX_MCP_APPROVAL, bridgeTableTarget, planBridgeTable, scanBridgeTable } from "./codex-toml.ts";

export const PLAYWRIGHT_CLI_ADVISORY = "playwright-cli not found on PATH; install manually with npm install -g @playwright/cli@latest before cross-harness visual verification.";

export async function playwrightCliAdvisory(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Promise<string | undefined> {
	const directories = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const extensions = process.platform === "win32"
		? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const directory of directories) {
		for (const extension of extensions) {
			const executable = path.join(directory, `playwright-cli${extension}`);
			try {
				if (!(await stat(executable)).isFile()) continue;
				await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return undefined;
			} catch {
				// PATH health check is filesystem-only; never execute the CLI.
			}
		}
	}
	return PLAYWRIGHT_CLI_ADVISORY;
}

const CLAUDE_PRETOOL_GUARD = "|| exit 2";

// PreToolUse hooks must deny when the hook process itself fails; each host needs its own guard.
function pretoolGuard(harness: Harness, event: string | undefined): string | undefined {
	if (event !== "PreToolUse") return undefined;
	return harness === "claude" ? CLAUDE_PRETOOL_GUARD : harness === "codex" ? CODEX_PRETOOL_GUARD : undefined;
}

function hasPretoolGuard(command: string, guard: string): boolean {
	return command.trimEnd().endsWith(guard);
}

// Claude and Codex nest hook handlers inside matcher groups; Cursor lists handlers directly.
function usesHookGroups(harness: Harness): boolean {
	return harness === "claude" || harness === "codex";
}

export const CODEX_HOOK_TRUST_NOTICE = "Codex skips new or changed hooks until you trust them, separately in each surface: in the Codex CLI open /hooks, press Enter on PreToolUse, and trust only the Pi hook (do not press t, which trusts every hook); in the Codex desktop app use Settings > Hooks.";

// Codex keys hook trust by position, so removing the Pi group can move the user's other hooks.
export const CODEX_HOOK_UNINSTALL_NOTICE = "Removing the Pi hook can shift the position of your other Codex hooks, and Codex skips a moved hook until you trust it again: check them in each surface (Codex CLI /hooks; desktop app Settings > Hooks).";

/** Re-trust reminder whenever a Codex hooks.json change is planned or applied. */
export function codexHookTrustNotice(harness: Harness, changedPaths: string[], action: "install" | "uninstall" = "install"): string | undefined {
	if (harness !== "codex" || !changedPaths.some((file) => path.basename(file) === "hooks.json")) return undefined;
	return action === "install" ? CODEX_HOOK_TRUST_NOTICE : CODEX_HOOK_UNINSTALL_NOTICE;
}

export type PackageRootState = "user" | "dev-checkout" | "refused";
export interface PackageRootClassification {
	state: PackageRootState;
	warning?: string;
	hint?: string;
}

export type ProblemKind =
	| "missing-entry"
	| "wrong-root"
	| "missing-target"
	| "unparseable"
	| "jsonc"
	| "oversized"
	| "malformed-shape"
	| "entry-not-ours"
	| "foreign-status-line"
	| "legacy-command"
	| "unguarded-hook"
	| "stamp-version-mismatch"
	| "non-macos-claude-bash-warning"
	| "stale-backup-link"
	| "unreadable";

export interface SetupProblem {
	kind: ProblemKind;
	harness: Harness;
	message: string;
	dest?: string;
	severity: "error" | "warning";
}

export interface SetupInspection {
	state: "ok" | "needs-fix" | "not-installed";
	problems: SetupProblem[];
}

export interface HarnessRoots {
	claude: string;
	claudeMcp: string;
	cursor: string;
	opencode: string;
	codex: string;
}

function harnessRoot(harness: Harness, roots: HarnessRoots): string {
	return roots[harness];
}

export interface InspectOptions {
	pkgRoot: string;
	roots: HarnessRoots;
	stamp?: string | { version?: string } | null;
	platform?: string;
}

const REINSTALL_HINT = "Reinstall package through Pi (npm or Git); do not use project .pi, tmp/extensions, or legacy global extension copies.";

function inside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directoryExists(file: string): Promise<boolean> {
	try {
		return (await lstat(file)).isDirectory();
	} catch {
		return false;
	}
}

async function hasSymlinkBetween(root: string, target: string): Promise<boolean> {
	const relative = path.relative(root, target);
	if (!inside(root, target)) return true;
	let current = root;
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) return true;
		} catch {
			return true;
		}
	}
	return false;
}

export async function classifyPackageRoot(pkgRoot: string, agentDir: string): Promise<PackageRootClassification> {
	const refused = (): PackageRootClassification => ({ state: "refused", hint: REINSTALL_HINT });
	try {
		const requestedRoot = path.resolve(pkgRoot);
		const [packagePath, agentPath] = await Promise.all([realpath(requestedRoot), realpath(path.resolve(agentDir))]);
		if (!(await directoryExists(packagePath)) || (await lstat(requestedRoot)).isSymbolicLink()) return refused();

		const parts = packagePath.split(path.sep);
		const isTmpExtensions = parts.some((part, index) => part === "tmp" && parts[index + 1] === "extensions");
		if (isTmpExtensions || inside(path.join(agentPath, "extensions"), packagePath)) return refused();

		for (const source of ["npm", "git"] as const) {
			const installRoot = path.resolve(agentDir, source);
			try {
				if (!inside(installRoot, requestedRoot)) continue;
				if ((await lstat(installRoot)).isSymbolicLink() || await hasSymlinkBetween(installRoot, requestedRoot)) return refused();
				const realInstallRoot = await realpath(installRoot);
				if (inside(realInstallRoot, packagePath)) return { state: "user" };
			} catch {
				// Install source absent or unsafe; check next allowed root.
			}
		}

		if (!inside(agentPath, packagePath) && parts.includes(".pi")) return refused();

		let gitMarker = false;
		try {
			await lstat(path.join(packagePath, ".git"));
			gitMarker = true;
		} catch {
			// Not a checkout root.
		}
		const docsPath = path.join(packagePath, "docs", "engineering");
		if (gitMarker && (await directoryExists(docsPath)) && inside(packagePath, await realpath(docsPath))) {
			return { state: "dev-checkout", warning: "Package root is a development checkout; consumer setup should use an installed copy." };
		}
		return refused();
	} catch {
		return refused();
	}
}

export function resolveHarnessRoots(env: NodeJS.ProcessEnv | Record<string, string | undefined>, homedir: string): HarnessRoots {
	const home = path.resolve(homedir);
	const claude = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"));
	return {
		claude,
		claudeMcp: path.join(env.CLAUDE_CONFIG_DIR ? claude : home, ".claude.json"),
		cursor: path.join(home, ".cursor"),
		opencode: path.join(path.resolve(env.XDG_CONFIG_HOME || path.join(home, ".config")), "opencode"),
		codex: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageAsset(pkgRoot: string, script: string): string {
	return path.resolve(pkgRoot, ...script.split("/"));
}

function scriptSuffix(script: string): string {
	return script.replaceAll("/", path.sep);
}

function commandTarget(command: string): string | undefined {
	const args: string[] = [];
	let value = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			value += char;
			escaped = false;
		} else if (char === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (char === quote) quote = undefined;
			else value += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (/\s/.test(char)) {
			if (value) args.push(value);
			value = "";
		} else value += char;
	}
	if (escaped) value += "\\";
	if (value) args.push(value);
	return quote || args.length < 2 ? undefined : args[1];
}

function looksLikeOwnedTarget(target: string | undefined, script: string): boolean {
	if (!target || path.basename(target) !== path.basename(script)) return false;
	const suffix = scriptSuffix(script);
	return target === suffix || target.endsWith(`${path.sep}${suffix}`);
}

async function readCapped(file: string, includeBytes = false): Promise<{ state: "missing" | "ok" | "oversized" | "unreadable"; text?: string; bytes?: Buffer }> {
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		const info = await handle.stat();
		if (!info.isFile()) return { state: "unreadable" };
		if (info.size > MAX_CONFIG_BYTES) return { state: "oversized" };
		const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > MAX_CONFIG_BYTES) return { state: "oversized" };
		const content = buffer.subarray(0, total);
		return {
			state: "ok",
			text: content.toString("utf8"),
			...(includeBytes ? { bytes: Buffer.from(content) } : {}),
		};
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function isJsonc(text: string): boolean {
	const stringsRemoved = text.replace(/"(?:\\.|[^"\\])*"/g, '""');
	return /\/\/|\/\*/.test(stringsRemoved) || /,\s*[}\]]/.test(stringsRemoved);
}

interface ConfigFile {
	value?: Record<string, unknown>;
	exists: boolean;
}

function problem(
	problems: SetupProblem[],
	harness: Harness,
	kind: ProblemKind,
	message: string,
	dest?: string,
	severity: SetupProblem["severity"] = "error",
): void {
	problems.push({ kind, harness, message, ...(dest ? { dest } : {}), severity });
}

async function readConfig(file: string, harness: Harness, dest: string, problems: SetupProblem[]): Promise<ConfigFile> {
	const read = await readCapped(file);
	if (read.state === "missing") return { exists: false };
	if (read.state === "oversized") {
		problem(problems, harness, "oversized", `Config exceeds ${MAX_CONFIG_BYTES} bytes.`, dest);
		return { exists: true };
	}
	if (read.state === "unreadable") {
		problem(problems, harness, "unreadable", "Config is not a readable regular file.", dest);
		return { exists: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text ?? "");
	} catch {
		const kind: ProblemKind = isJsonc(read.text ?? "") ? "jsonc" : "unparseable";
		problem(problems, harness, kind, kind === "jsonc" ? "JSONC is not accepted; config must be strict JSON." : "Config is not valid JSON.", dest);
		return { exists: true };
	}
	if (!isRecord(parsed)) {
		problem(problems, harness, "malformed-shape", "Config root must be a JSON object.", dest);
		return { exists: true };
	}
	return { value: parsed, exists: true };
}

async function checkTarget(
	target: string | undefined,
	script: string,
	pkgRoot: string,
	harness: Harness,
	dest: string,
	problems: SetupProblem[],
): Promise<boolean> {
	if (!looksLikeOwnedTarget(target, script)) {
		problem(problems, harness, "wrong-root", "Configured entry does not target expected package asset.", dest);
		return false;
	}
	if (!path.isAbsolute(target!)) {
		problem(problems, harness, "wrong-root", "Configured package target is relative.", dest);
		return false;
	}
	let packagePath: string;
	try {
		packagePath = await realpath(pkgRoot);
	} catch {
		problem(problems, harness, "missing-target", "Selected package root does not exist.", dest);
		return false;
	}
	let actual: string;
	try {
		actual = await realpath(target!);
	} catch {
		if (path.resolve(target!) === packageAsset(pkgRoot, script)) {
			problem(problems, harness, "missing-target", "Expected package client target does not exist.", dest);
		} else problem(problems, harness, "wrong-root", "Configured client target is missing outside selected package root.", dest);
		return false;
	}
	if (!inside(packagePath, actual)) {
		problem(problems, harness, "wrong-root", "Configured client target resolves outside selected package root.", dest);
		return false;
	}
	let expected: string;
	try {
		expected = await realpath(packageAsset(packagePath, script));
	} catch {
		problem(problems, harness, "missing-target", "Expected package client target does not exist.", dest);
		return false;
	}
	if (actual !== expected) {
		problem(problems, harness, "wrong-root", "Configured client target differs from manifest target.", dest);
		return false;
	}
	return true;
}

interface HookCandidate {
	hook: Record<string, unknown>;
	group: Record<string, unknown>;
}

function hostName(harness: Harness): string {
	return harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : harness === "cursor" ? "Cursor" : "OpenCode";
}

// A Claude or Codex matcher narrows which tools a group's handlers see; the Pi guard must see every tool.
function isMatchAllGroup(group: Record<string, unknown>): boolean {
	return group.matcher === undefined || group.matcher === "" || group.matcher === "*" || group.matcher === ".*";
}

function eventCandidates(eventValue: unknown, harness: Harness, dest: string, problems: SetupProblem[]): HookCandidate[] {
	if (!Array.isArray(eventValue)) {
		problem(problems, harness, "malformed-shape", "Hook event must be an array.", dest);
		return [];
	}
	const candidates: HookCandidate[] = [];
	for (const event of eventValue) {
		if (!isRecord(event)) {
			problem(problems, harness, "malformed-shape", "Hook event entries must be objects.", dest);
			continue;
		}
		if (usesHookGroups(harness)) {
			if (!Array.isArray(event.hooks)) {
				problem(problems, harness, "malformed-shape", `${hostName(harness)} hook entries must contain hooks array.`, dest);
				continue;
			}
			for (const hook of event.hooks) {
				if (isRecord(hook) && typeof hook.command === "string" && hook.type === "command") candidates.push({ hook, group: event });
				// Codex also supports foreign mcp_tool handlers; they are simply not ours.
				else if (!(harness === "codex" && isRecord(hook))) problem(problems, harness, "malformed-shape", `${hostName(harness)} hook must use type command with a string command.`, dest);
			}
		} else if (typeof event.command !== "string") {
			problem(problems, harness, "malformed-shape", "Cursor hook command must be a string.", dest);
		} else candidates.push({ hook: event, group: event });
	}
	return candidates;
}

async function inspectHooks(
	harness: Harness,
	config: ConfigFile,
	entries: HarnessEntry[],
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	if (!config.value) return;
	const hooks = config.value.hooks;
	if (hooks === undefined) return;
	if (!isRecord(hooks)) {
		problem(problems, harness, "malformed-shape", "hooks must be an object.", "hooks");
		signal.value = true;
		return;
	}
	for (const entry of entries) {
		if (entry.kind !== "hook" || entry.event === undefined || hooks[entry.event] === undefined) continue;
		signal.value = true;
		const candidates = eventCandidates(hooks[entry.event], harness, entry.dest, problems);
		let foundForeign = false;
		for (const { hook: candidate, group } of candidates) {
			const target = commandTarget(candidate.command as string);
			if (!looksLikeOwnedTarget(target, entry.script)) {
				foundForeign = true;
				continue;
			}
			const validTarget = await checkTarget(target, entry.script, pkgRoot, harness, entry.dest, problems);
			const validCursor = harness !== "cursor" || candidate.failClosed === CURSOR_HOOK_FAIL_CLOSED;
			if (!validCursor) problem(problems, harness, "malformed-shape", `Cursor bridge hook must set failClosed: ${CURSOR_HOOK_FAIL_CLOSED}.`, entry.dest);
			const guard = pretoolGuard(harness, entry.event);
			const validGuard = guard === undefined || hasPretoolGuard(candidate.command as string, guard);
			if (!validGuard) problem(problems, harness, "unguarded-hook", `${hostName(harness)} PreToolUse hook must end with ${guard}.`, entry.dest);
			const validScope = !usesHookGroups(harness) || isMatchAllGroup(group);
			if (!validScope) problem(problems, harness, "malformed-shape", `${hostName(harness)} Pi hook must sit in a hook group without a matcher so it runs for every tool.`, entry.dest);
			if (validTarget && validCursor && validGuard && validScope) satisfied.add(entry.dest);
		}
		if (foundForeign && !satisfied.has(entry.dest)) problem(problems, harness, "entry-not-ours", "Configured hook event contains no owned client entry.", entry.dest);
	}
}

function mcpTarget(entry: Record<string, unknown>, harness: Harness): string | undefined {
	if (harness === "opencode") {
		return Array.isArray(entry.command) && entry.command.length === 2 && entry.command[0] === "node" && typeof entry.command[1] === "string"
			? entry.command[1]
			: undefined;
	}
	return entry.command === "node" && Array.isArray(entry.args) && entry.args.length === 1 && typeof entry.args[0] === "string"
		? entry.args[0]
		: undefined;
}

async function inspectMcp(
	harness: Harness,
	config: ConfigFile,
	entry: HarnessEntry,
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	if (!config.value) return;
	const containerName = harness === "opencode" ? "mcp" : "mcpServers";
	const container = config.value[containerName];
	if (container === undefined) return;
	if (!isRecord(container)) {
		problem(problems, harness, "malformed-shape", `${containerName} must be an object.`, containerName);
		signal.value = true;
		return;
	}
	if (!Object.hasOwn(container, PI_BRIDGE_MCP_KEY)) return;
	signal.value = true;
	const dest = entry.dest;
	const server = container[PI_BRIDGE_MCP_KEY];
	if (!isRecord(server)) {
		problem(problems, harness, "malformed-shape", `${PI_BRIDGE_MCP_KEY} MCP entry must be an object.`, dest);
		return;
	}
	const target = mcpTarget(server, harness);
	if (!target || (harness === "opencode" && server.type !== "local")) {
		problem(problems, harness, "malformed-shape", "MCP entry has invalid command/args shape.", dest);
		return;
	}
	if (await checkTarget(target, entry.script, pkgRoot, harness, dest, problems)) satisfied.add(dest);
}

async function inspectCodexMcp(
	file: string,
	entry: HarnessEntry,
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	const read = await readCapped(file);
	if (read.state === "missing") return;
	if (read.state === "oversized" || read.state === "unreadable") {
		signal.value = true;
		problem(problems, "codex", read.state, read.state === "oversized" ? `Config exceeds ${MAX_CONFIG_BYTES} bytes.` : "Config is not a readable regular file.", "config.toml");
		return;
	}
	const text = read.text ?? "";
	const scan = scanBridgeTable(text);
	if (scan.kind === "absent") return;
	// Unreadable TOML elsewhere in the file only matters when it may hide the bridge table.
	if (scan.kind === "unsupported" && !text.includes(PI_BRIDGE_MCP_KEY)) return;
	signal.value = true;
	if (scan.kind === "unsupported") {
		problem(problems, "codex", "malformed-shape", scan.reason, entry.dest);
		return;
	}
	const target = bridgeTableTarget(scan);
	if (!target) {
		problem(problems, "codex", "malformed-shape", "MCP entry has invalid command/args shape.", entry.dest);
		return;
	}
	if (!(await checkTarget(target, entry.script, pkgRoot, "codex", entry.dest, problems))) return;
	if (scan.values.get("default_tools_approval_mode") !== CODEX_MCP_APPROVAL) {
		problem(problems, "codex", "malformed-shape", `Codex bridge MCP table must set default_tools_approval_mode = "${CODEX_MCP_APPROVAL}".`, entry.dest);
		return;
	}
	satisfied.add(entry.dest);
}

async function inspectSymlink(
	harness: Harness,
	root: string,
	entry: HarnessEntry,
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	const file = path.join(root, entry.dest);
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			problem(problems, harness, "unreadable", "Cannot inspect package symlink.", entry.dest);
			signal.value = true;
		}
		return;
	}
	signal.value = true;
	if (!info.isSymbolicLink()) {
		if (entry.kind === "command" && info.isFile()) {
			problem(problems, harness, "legacy-command", `Plain ${entry.dest} is a command file; Install / repair backs it up and replaces it.`, entry.dest);
		} else {
			problem(problems, harness, "entry-not-ours", "Expected package symlink destination is not a symlink.", entry.dest);
		}
		return;
	}
	let target: string;
	try {
		target = await realpath(file);
	} catch {
		let raw: string;
		try {
			raw = await readlink(file);
		} catch {
			problem(problems, harness, "unreadable", "Cannot read package symlink.", entry.dest);
			return;
		}
		const resolved = path.resolve(path.dirname(file), raw);
		if (resolved === packageAsset(pkgRoot, entry.script)) problem(problems, harness, "missing-target", "Package symlink target does not exist.", entry.dest);
		else if (looksLikeOwnedTarget(raw, entry.script)) problem(problems, harness, "wrong-root", "Package symlink points to missing asset in another root.", entry.dest);
		else problem(problems, harness, "entry-not-ours", "Package symlink target cannot be verified.", entry.dest);
		return;
	}
	let selectedRoot: string;
	try {
		selectedRoot = await realpath(pkgRoot);
	} catch {
		problem(problems, harness, "missing-target", "Selected package root does not exist.", entry.dest);
		return;
	}
	if (!inside(selectedRoot, target)) {
		if (looksLikeOwnedTarget(target, entry.script)) problem(problems, harness, "wrong-root", "Package symlink points to matching asset in another package root.", entry.dest);
		else problem(problems, harness, "entry-not-ours", "Package symlink does not point inside selected package.", entry.dest);
		return;
	}
	let expected: string;
	try {
		expected = await realpath(packageAsset(selectedRoot, entry.script));
	} catch {
		problem(problems, harness, "missing-target", "Expected package asset does not exist.", entry.dest);
		return;
	}
	if (target !== expected) {
		problem(problems, harness, "entry-not-ours", "Package symlink points to a different asset inside package.", entry.dest);
		return;
	}
	satisfied.add(entry.dest);
}

async function inspectLegacyCommands(
	harness: Harness,
	root: string,
	pkgRoot: string,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	let packagePath: string;
	try {
		packagePath = await realpath(pkgRoot);
	} catch {
		return;
	}
	for (const name of ["discuss", "plan", "build"]) {
		const file = path.join(root, "commands", `${name}.md`);
		const dest = `commands/${name}.md`;
		let info;
		try {
			info = await lstat(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			problem(problems, harness, "unreadable", "Cannot inspect legacy command path.", dest);
			signal.value = true;
			continue;
		}
		signal.value = true;
		if (!info.isSymbolicLink()) {
			if (info.isFile()) {
				problem(problems, harness, "legacy-command", `Plain ${dest} is a command file; Install / repair backs it up and replaces it.`, dest);
			} else {
				problem(problems, harness, "entry-not-ours", `Unprefixed ${name}.md is not an owned package symlink; preserve it.`, dest);
			}
			continue;
		}
		let target: string;
		try {
			target = await realpath(file);
		} catch {
			problem(problems, harness, "entry-not-ours", `Unprefixed ${name}.md symlink cannot be verified; preserve it.`, dest);
			continue;
		}
		if (inside(packagePath, target)) {
			problem(problems, harness, "legacy-command", `Unprefixed ${name}.md symlink points into package; use pi-${name}.md.`, dest);
		} else {
			problem(problems, harness, "entry-not-ours", `Unprefixed ${name}.md points outside package; preserve it.`, dest);
		}
	}
}

function suppliedStampVersion(stamp: InspectOptions["stamp"]): string | undefined {
	if (typeof stamp === "string") return stamp;
	return stamp && typeof stamp.version === "string" ? stamp.version : undefined;
}

async function inspectPackageVersion(
	pkgRoot: string,
	harness: Harness,
	stamp: InspectOptions["stamp"],
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	const read = await readCapped(path.join(pkgRoot, "package.json"));
	if (read.state === "missing") {
		problem(problems, harness, "missing-target", "Selected package has no package.json.", "package.json");
		return;
	}
	if (read.state === "oversized") {
		problem(problems, harness, "oversized", `Package manifest exceeds ${MAX_CONFIG_BYTES} bytes.`, "package.json");
		return;
	}
	if (read.state === "unreadable") {
		problem(problems, harness, "unreadable", "Package manifest is not readable.", "package.json");
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text ?? "");
	} catch {
		problem(problems, harness, "unparseable", "Package manifest is not valid JSON.", "package.json");
		return;
	}
	if (!isRecord(parsed) || typeof parsed.version !== "string") {
		problem(problems, harness, "malformed-shape", "Package manifest must contain string version.", "package.json");
		return;
	}
	const stampedVersion = suppliedStampVersion(stamp);
	if (stampedVersion && stampedVersion !== parsed.version) {
		signal.value = true;
		problem(problems, harness, "stamp-version-mismatch", `Setup stamp version ${stampedVersion} differs from package version ${parsed.version}.`);
	}
}

export async function inspectHarness(harness: Harness, options: InspectOptions): Promise<SetupInspection> {
	const problems: SetupProblem[] = [];
	if (!Object.hasOwn(HARNESS_MANIFEST, harness)) {
		return { state: "needs-fix", problems: [{ kind: "malformed-shape", harness: "claude", severity: "error", message: "Unknown harness name." }] };
	}
	const entries = HARNESS_MANIFEST[harness];
	const satisfied = new Set<string>();
	const signal = { value: options.stamp !== undefined && options.stamp !== null };
	await inspectPackageVersion(options.pkgRoot, harness, options.stamp, problems, signal);

	const root = harnessRoot(harness, options.roots);
	if (harness === "claude") {
		const settings = await readConfig(path.join(root, "settings.json"), harness, "settings.json", problems);
		if (settings.exists && !settings.value && problems.some((item) => item.dest === "settings.json")) signal.value = true;
		await inspectHooks(harness, settings, entries, options.pkgRoot, satisfied, problems, signal);
		const statusEntry = entries.find(({ kind }) => kind === "statusline")!;
		const statusLine = settings.value?.statusLine;
		if (statusLine !== undefined) {
			signal.value = true;
			if (!isRecord(statusLine) || typeof statusLine.command !== "string") {
				problem(problems, harness, "malformed-shape", "statusLine must contain command string.", statusEntry.dest);
			} else if (!looksLikeOwnedTarget(commandTarget(statusLine.command), statusEntry.script)) {
				problem(problems, harness, "foreign-status-line", "Existing statusLine belongs to another command; preserve it and review manually.", statusEntry.dest);
			} else if (await checkTarget(commandTarget(statusLine.command), statusEntry.script, options.pkgRoot, harness, statusEntry.dest, problems)) {
				if (statusLine.type === "command" && statusLine.refreshInterval === STATUSLINE_REFRESH_INTERVAL) satisfied.add(statusEntry.dest);
				else problem(problems, harness, "malformed-shape", `Owned statusLine must use type command and refreshInterval ${STATUSLINE_REFRESH_INTERVAL}.`, statusEntry.dest);
			}
		}
		const mcpEntry = entries.find(({ kind }) => kind === "mcp")!;
		const mcpFile = options.roots.claudeMcp;
		const mcp = await readConfig(mcpFile, harness, ".claude.json", problems);
		if (mcp.exists && !mcp.value && problems.some((item) => item.dest === ".claude.json")) signal.value = true;
		await inspectMcp(harness, mcp, mcpEntry, options.pkgRoot, satisfied, problems, signal);
		await inspectSymlinkEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	} else if (harness === "cursor") {
		const hooks = await readConfig(path.join(root, "hooks.json"), harness, "hooks.json", problems);
		if (hooks.exists && !hooks.value && problems.some((item) => item.dest === "hooks.json")) signal.value = true;
		await inspectHooks(harness, hooks, entries, options.pkgRoot, satisfied, problems, signal);
		const mcp = await readConfig(path.join(root, "mcp.json"), harness, "mcp.json", problems);
		if (mcp.exists && !mcp.value && problems.some((item) => item.dest === "mcp.json")) signal.value = true;
		await inspectMcp(harness, mcp, entries.find(({ kind }) => kind === "mcp")!, options.pkgRoot, satisfied, problems, signal);
		await inspectSymlinkEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	} else if (harness === "codex") {
		const hooks = await readConfig(path.join(root, "hooks.json"), harness, "hooks.json", problems);
		if (hooks.exists && !hooks.value && problems.some((item) => item.dest === "hooks.json")) signal.value = true;
		await inspectHooks(harness, hooks, entries, options.pkgRoot, satisfied, problems, signal);
		await inspectCodexMcp(path.join(root, "config.toml"), entries.find(({ kind }) => kind === "mcp")!, options.pkgRoot, satisfied, problems, signal);
		await inspectSymlinkEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	} else {
		const plugin = entries.find(({ kind }) => kind === "plugin")!;
		await inspectSymlink(harness, root, plugin, options.pkgRoot, satisfied, problems, signal);
		const config = await readConfig(path.join(root, "opencode.json"), harness, "opencode.json", problems);
		if (config.exists && !config.value && problems.some((item) => item.dest === "opencode.json")) signal.value = true;
		await inspectMcp(harness, config, entries.find(({ kind }) => kind === "mcp")!, options.pkgRoot, satisfied, problems, signal);
		await inspectSymlinkEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	}

	// Codex never had Pi command files; its commands/ paths are never ours.
	if (harness !== "codex") await inspectLegacyCommands(harness, root, options.pkgRoot, problems, signal);
	// Report (never delete) the stale backup links Install / repair would remove; they load as duplicate skills.
	const staleLinks: PlannedChange[] = [];
	await planStaleBackupLinks(root, entries, options.pkgRoot, staleLinks, []);
	if (staleLinks.length) {
		problem(problems, harness, "stale-backup-link", `${staleLinks.length} old .harness-bak- link${staleLinks.length === 1 ? "" : "s"} from an earlier /harness version can load as duplicate skills or commands; run Install / repair (or Uninstall) to remove them.`, undefined, "warning");
	}
	if (!signal.value && !problems.some(({ severity }) => severity === "error")) return { state: "not-installed", problems };
	for (const entry of entries) {
		if (!satisfied.has(entry.dest)) problem(problems, harness, "missing-entry", "Expected owned manifest entry is missing or incorrect.", entry.dest);
	}
	if (harness === "claude" && (options.platform ?? process.platform) !== "darwin") {
		problem(problems, harness, "non-macos-claude-bash-warning", "Claude Bash sandbox behavior is platform-dependent; verify fail-closed behavior on this non-macOS host.", "settings.json#/hooks/PreToolUse", "warning");
	}
	return { state: problems.some(({ severity }) => severity === "error") ? "needs-fix" : "ok", problems };
}

async function inspectSymlinkEntries(
	harness: Harness,
	root: string,
	entries: HarnessEntry[],
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	for (const entry of entries) {
		if (entry.kind === "command" || entry.kind === "plugin" || entry.kind === "skill") {
			await inspectSymlink(harness, root, entry, pkgRoot, satisfied, problems, signal);
		}
	}
}

export interface PlannedChange {
	path: string;
	/** json and toml are whole-file text configs; toml is only Codex's config.toml. */
	kind: "json" | "toml" | "symlink" | "delete";
	before: string | null;
	after: string | null;
	legacyFile?: true;
	beforeBytes?: Buffer;
}

export interface PlannedSkip {
	path: string;
	reason: string;
}

export interface CliStep {
	executable: "claude";
	args: string[];
}

export interface SetupPlan {
	changes: PlannedChange[];
	skipped: PlannedSkip[];
	cliSteps: CliStep[];
}

export interface PlanOptions extends InspectOptions {
	agentDir: string;
}

export interface HarnessStampEntry {
	pkgRoot: string;
	installedAt: string;
}

export interface HarnessSetupStamp {
	version: string;
	harnesses: Partial<Record<Harness, HarnessStampEntry>> & Record<string, unknown>;
}

export interface ApplyOptions {
	now?: Date | (() => Date);
}

export interface ApplyResult {
	path: string;
	applied: boolean;
	reason?: string;
	/** Regular-file backup path. */
	backup?: string;
	/** Old target of an applied link retarget or delete; links are never backed up. */
	previous?: string;
}

interface PlanScope {
	roots: string[];
	stampPath: string;
}

const PLAN_SCOPE = Symbol("harness setup plan scope");
type ScopedPlan = SetupPlan & { [PLAN_SCOPE]?: PlanScope };

interface JsonDraft {
	path: string;
	before: string | null;
	value: Record<string, unknown>;
}

function addSkip(skipped: PlannedSkip[], file: string, reason: string): void {
	if (!skipped.some((item) => item.path === file && item.reason === reason)) skipped.push({ path: file, reason });
}

async function readTextDraft(file: string, skipped: PlannedSkip[]): Promise<{ path: string; before: string | null } | undefined> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			addSkip(skipped, file, "Cannot inspect config file.");
			return undefined;
		}
		return { path: file, before: null };
	}
	if (info.isSymbolicLink() || !info.isFile()) {
		addSkip(skipped, file, "Config path is not a regular file; preserve it.");
		return undefined;
	}
	const read = await readCapped(file);
	if (read.state === "oversized") {
		addSkip(skipped, file, `Config exceeds ${MAX_CONFIG_BYTES} bytes.`);
		return undefined;
	}
	if (read.state !== "ok") {
		addSkip(skipped, file, "Config is unreadable; preserve it.");
		return undefined;
	}
	return { path: file, before: read.text ?? "" };
}

async function readJsonDraft(file: string, skipped: PlannedSkip[]): Promise<JsonDraft | undefined> {
	const text = await readTextDraft(file, skipped);
	if (!text) return undefined;
	if (text.before === null) return { path: file, before: null, value: {} };
	const read = { text: text.before };
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text ?? "");
	} catch {
		const jsonc = isJsonc(read.text ?? "");
		addSkip(skipped, file, jsonc ? "JSONC is unsupported; preserve config." : "Config is unparseable; preserve it.");
		return undefined;
	}
	if (!isRecord(parsed)) {
		addSkip(skipped, file, "Config root is not a JSON object; preserve it.");
		return undefined;
	}
	return { path: file, before: read.text ?? "", value: parsed };
}

function finishJsonDraft(draft: JsonDraft, dirty: boolean, changes: PlannedChange[]): void {
	if (!dirty) return;
	const after = `${JSON.stringify(draft.value, null, 2)}\n`;
	if (after !== draft.before) changes.push({ path: draft.path, kind: "json", before: draft.before, after });
}

function ownedCommand(command: string | undefined, script: string): boolean {
	return looksLikeOwnedTarget(commandTarget(command ?? ""), script);
}

function expectedHook(harness: Harness, entry: HarnessEntry, pkgRoot: string): Record<string, unknown> {
	const command = `node ${JSON.stringify(packageAsset(pkgRoot, entry.script))}`;
	if (harness === "cursor") return { command, failClosed: CURSOR_HOOK_FAIL_CLOSED };
	const guard = pretoolGuard(harness, entry.event);
	return { type: "command", command: guard ? `${command} ${guard}` : command };
}

// Claude and Codex: each Pi hook lives in its own matcher-less group so it runs for every tool.
// Joining a foreign group would inherit that group's matcher (e.g. Bash only) and skip edits.
function updateGroupedHook(
	harness: "claude" | "codex",
	entry: HarnessEntry,
	config: Record<string, unknown>,
	pkgRoot: string,
	install: boolean,
	skipped: PlannedSkip[],
	file: string,
): boolean {
	const event = entry.event!;
	let hooks = config.hooks;
	if (hooks === undefined) {
		if (!install) return false;
		hooks = {};
		config.hooks = hooks;
	}
	if (!isRecord(hooks)) {
		addSkip(skipped, file, `hooks is not an object; preserve ${event}.`);
		return false;
	}
	let groups = hooks[event];
	if (groups === undefined) {
		if (!install) return false;
		groups = [];
		hooks[event] = groups;
	}
	if (!Array.isArray(groups)) {
		addSkip(skipped, file, `Hook event ${event} is not an array; preserve it.`);
		return false;
	}
	const list = groups as unknown[];
	const owned: Array<{ group: Record<string, unknown>; index: number }> = [];
	let foreignPresent = false;
	for (const group of list) {
		if (!isRecord(group) || !Array.isArray(group.hooks)) {
			foreignPresent = true;
			continue;
		}
		group.hooks.forEach((hook: unknown, index: number) => {
			if (isRecord(hook) && hook.type === "command" && typeof hook.command === "string" && ownedCommand(hook.command, entry.script)) owned.push({ group, index });
			else foreignPresent = true;
		});
	}
	if (foreignPresent) addSkip(skipped, file, `Foreign hooks in ${event} are preserved.`);
	const desired = expectedHook(harness, entry, pkgRoot);
	// Keep a correctly scoped owned hook in place: Codex keys hook trust by its position, and an
	// already-correct Claude install then plans no change.
	const keeper = install ? owned.find(({ group }) => isMatchAllGroup(group)) : undefined;
	let dirty = false;
	const removals = owned.filter((candidate) => candidate !== keeper).reverse();
	for (const { group, index } of removals) {
		(group.hooks as unknown[]).splice(index, 1);
		dirty = true;
		const keys = Object.keys(group);
		if ((group.hooks as unknown[]).length === 0 && keys.every((key) => key === "hooks" || key === "matcher")) list.splice(list.indexOf(group), 1);
	}
	if (keeper) {
		const hooksArray = keeper.group.hooks as unknown[];
		if (JSON.stringify(hooksArray[keeper.index]) !== JSON.stringify(desired)) {
			hooksArray[keeper.index] = desired;
			dirty = true;
		}
	} else if (install) {
		list.push({ hooks: [desired] });
		dirty = true;
	}
	if (!install && dirty) {
		if (list.length === 0) delete hooks[event];
		if (Object.keys(hooks).length === 0) delete config.hooks;
	}
	return dirty;
}

async function planCodexToml(
	file: string,
	pkgRoot: string,
	install: boolean,
	changes: PlannedChange[],
	skipped: PlannedSkip[],
): Promise<void> {
	const entry = HARNESS_MANIFEST.codex.find(({ kind }) => kind === "mcp")!;
	if (install && !(await packageAssetExists(pkgRoot, entry.script))) {
		addSkip(skipped, file, "Expected MCP package asset is missing or outside package root.");
		return;
	}
	const draft = await readTextDraft(file, skipped);
	if (!draft) return;
	const plan = planBridgeTable(draft.before, packageAsset(pkgRoot, entry.script), install, (target) => looksLikeOwnedTarget(target, entry.script));
	if (plan.kind === "skip") {
		// Unreadable TOML that cannot hide a bridge table needs no uninstall work.
		if (install || (draft.before ?? "").includes(PI_BRIDGE_MCP_KEY)) addSkip(skipped, file, plan.reason);
		return;
	}
	if (plan.kind === "change" && plan.after !== draft.before) changes.push({ path: file, kind: "toml", before: draft.before, after: plan.after });
}

// Cursor: flat hook entries, one per event entry.
function updateCursorHook(
	entry: HarnessEntry,
	config: Record<string, unknown>,
	pkgRoot: string,
	install: boolean,
	skipped: PlannedSkip[],
	file: string,
): boolean {
	const event = entry.event!;
	let hooks = config.hooks;
	if (hooks === undefined && install) {
		hooks = {};
		config.hooks = hooks;
	}
	if (hooks === undefined) return false;
	if (!isRecord(hooks)) {
		addSkip(skipped, file, `hooks is not an object; preserve ${event}.`);
		return false;
	}
	let groups = hooks[event];
	if (groups === undefined && install) {
		groups = [];
		hooks[event] = groups;
	}
	if (groups === undefined) return false;
	if (!Array.isArray(groups)) {
		addSkip(skipped, file, `Hook event ${event} is not an array; preserve it.`);
		return false;
	}
	const owned: Record<string, unknown>[] = [];
	let foreignPresent = false;
	for (const group of groups) {
		if (!isRecord(group)) continue;
		if (typeof group.command === "string" && ownedCommand(group.command, entry.script)) owned.push(group);
		else foreignPresent = true;
	}
	if (foreignPresent) addSkip(skipped, file, `Foreign hooks in ${event} are preserved.`);
	let dirty = false;
	if (!install) {
		for (const candidate of owned.reverse()) {
			groups.splice(groups.indexOf(candidate), 1);
			dirty = true;
		}
		return dirty;
	}
	const desired = expectedHook("cursor", entry, pkgRoot);
	if (owned.length) {
		const first = owned[0]!;
		if (JSON.stringify(first) !== JSON.stringify(desired)) {
			groups[groups.indexOf(first)] = desired;
			dirty = true;
		}
		for (const duplicate of owned.slice(1).reverse()) {
			groups.splice(groups.indexOf(duplicate), 1);
			dirty = true;
		}
		return dirty;
	}
	groups.push(desired);
	return true;
}

function expectedMcp(harness: Harness, pkgRoot: string): Record<string, unknown> {
	const target = packageAsset(pkgRoot, HARNESS_MANIFEST[harness].find(({ kind }) => kind === "mcp")!.script);
	return harness === "opencode"
		? { type: "local", command: ["node", target], enabled: true }
		: { command: "node", args: [target] };
}

async function updateMcp(
	harness: Harness,
	config: Record<string, unknown>,
	pkgRoot: string,
	install: boolean,
	skipped: PlannedSkip[],
	file: string,
): Promise<boolean> {
	const script = HARNESS_MANIFEST[harness].find(({ kind }) => kind === "mcp")!.script;
	if (install && !(await packageAssetExists(pkgRoot, script))) {
		addSkip(skipped, file, "Expected MCP package asset is missing or outside package root.");
		return false;
	}
	const containerName = harness === "opencode" ? "mcp" : "mcpServers";
	let container = config[containerName];
	if (container === undefined && install) {
		container = {};
		config[containerName] = container;
	}
	if (container === undefined) return false;
	if (!isRecord(container)) {
		addSkip(skipped, file, `${containerName} is not an object; preserve it.`);
		return false;
	}
	const current = container[PI_BRIDGE_MCP_KEY];
	if (current === undefined) {
		if (!install) return false;
		container[PI_BRIDGE_MCP_KEY] = expectedMcp(harness, pkgRoot);
		return true;
	}
	if (!install) {
		delete container[PI_BRIDGE_MCP_KEY];
		return true;
	}
	if (!isRecord(current)) {
		container[PI_BRIDGE_MCP_KEY] = expectedMcp(harness, pkgRoot);
		return true;
	}
	const expected = { ...current, ...expectedMcp(harness, pkgRoot) };
	if (JSON.stringify(current) === JSON.stringify(expected)) return false;
	container[PI_BRIDGE_MCP_KEY] = expected;
	return true;
}

async function packageAssetExists(pkgRoot: string, script: string): Promise<boolean> {
	try {
		const [root, target] = await Promise.all([realpath(pkgRoot), realpath(packageAsset(pkgRoot, script))]);
		return inside(root, target);
	} catch {
		return false;
	}
}

async function planSymlink(
	root: string,
	entry: HarnessEntry,
	pkgRoot: string,
	install: boolean,
	changes: PlannedChange[],
	skipped: PlannedSkip[],
): Promise<void> {
	const file = path.resolve(root, ...entry.dest.split("/"));
	const expected = packageAsset(pkgRoot, entry.script);
	if (install && !(await packageAssetExists(pkgRoot, entry.script))) {
		addSkip(skipped, file, "Expected package asset is missing or outside package root.");
		return;
	}
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			addSkip(skipped, file, "Cannot inspect symlink destination.");
			return;
		}
		if (install) changes.push({ path: file, kind: "symlink", before: null, after: expected });
		return;
	}
	if (!info.isSymbolicLink()) {
		if (install && entry.kind === "command" && info.isFile()) {
			const read = await readCapped(file, true);
			if (read.state !== "ok" || read.bytes === undefined) {
				addSkip(skipped, file, "Legacy command file is unreadable or oversized; preserve it.");
				return;
			}
			changes.push({ path: file, kind: "symlink", before: read.text ?? "", after: expected, legacyFile: true, beforeBytes: read.bytes });
			return;
		}
		addSkip(skipped, file, "Destination is not a symlink; preserve it.");
		return;
	}
	let raw: string;
	try {
		raw = await readlink(file);
	} catch {
		addSkip(skipped, file, "Symlink target cannot be verified; preserve it.");
		return;
	}
	let packagePath: string;
	try {
		packagePath = await realpath(pkgRoot);
	} catch {
		addSkip(skipped, file, "Symlink target cannot be verified; preserve it.");
		return;
	}
	let target: string | undefined;
	try {
		target = await realpath(file);
	} catch {
		// Match inspection: dangling owned links are classified by their raw target.
	}
	if (target !== undefined && inside(packagePath, target)) {
		if (!install) {
			changes.push({ path: file, kind: "delete", before: raw, after: null });
		} else {
			let expectedTarget: string;
			try {
				expectedTarget = await realpath(expected);
			} catch {
				addSkip(skipped, file, "Expected package asset cannot be verified.");
				return;
			}
			if (target !== expectedTarget) changes.push({ path: file, kind: "symlink", before: raw, after: expected });
		}
		return;
	}
	if (!looksLikeOwnedTarget(target ?? raw, entry.script)) {
		addSkip(skipped, file, "Symlink target is outside selected package; preserve it.");
		return;
	}
	if (!install) changes.push({ path: file, kind: "delete", before: raw, after: null });
	else changes.push({ path: file, kind: "symlink", before: raw, after: expected });
}

// Versions up to 0.11.0 left `<dest>.harness-bak-<ts>` sibling links; a skill one still loads as a
// duplicate skill. Delete those that pass the owned-link rule above. Regular-file backups hold user
// content and foreign links are not ours, so both stay.
async function planStaleBackupLinks(
	root: string,
	entries: HarnessEntry[],
	pkgRoot: string,
	changes: PlannedChange[],
	skipped: PlannedSkip[],
): Promise<void> {
	let packagePath: string | undefined;
	try {
		packagePath = await realpath(pkgRoot);
	} catch {
		// Without a resolvable package, only the path-shape rule can mark a link owned.
	}
	const listings = new Map<string, string[]>();
	for (const entry of entries) {
		if (entry.kind !== "command" && entry.kind !== "plugin" && entry.kind !== "skill") continue;
		const dest = path.resolve(root, ...entry.dest.split("/"));
		const dir = path.dirname(dest);
		let names = listings.get(dir);
		if (!names) {
			names = await readdir(dir).catch(() => []);
			listings.set(dir, names);
		}
		const prefix = `${path.basename(dest)}.harness-bak-`;
		for (const name of names) {
			if (!name.startsWith(prefix)) continue;
			const file = path.join(dir, name);
			const info = await lstat(file).catch(() => undefined);
			if (!info?.isSymbolicLink()) continue;
			let raw: string;
			try {
				raw = await readlink(file);
			} catch {
				addSkip(skipped, file, "Backup link target cannot be verified; preserve it.");
				continue;
			}
			const target = await realpath(file).catch(() => undefined);
			const owned = (target !== undefined && packagePath !== undefined && inside(packagePath, target)) || looksLikeOwnedTarget(target ?? raw, entry.script);
			if (owned) changes.push({ path: file, kind: "delete", before: raw, after: null });
			else addSkip(skipped, file, "Backup-named link points outside a Pi package; preserve it.");
		}
	}
}

async function planLegacyLinks(
	root: string,
	pkgRoot: string,
	install: boolean,
	changes: PlannedChange[],
	skipped: PlannedSkip[],
): Promise<void> {
	let packagePath: string;
	try {
		packagePath = await realpath(pkgRoot);
	} catch {
		return;
	}
	for (const name of ["discuss", "plan", "build"]) {
		const file = path.join(root, "commands", `${name}.md`);
		let info;
		try {
			info = await lstat(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") addSkip(skipped, file, "Cannot inspect legacy command path.");
			continue;
		}
		if (!info.isSymbolicLink()) {
			if (install && info.isFile()) {
				const read = await readCapped(file, true);
				if (read.state !== "ok" || read.bytes === undefined) {
					addSkip(skipped, file, "Legacy command file is unreadable or oversized; preserve it.");
					continue;
				}
				changes.push({ path: file, kind: "delete", before: read.text ?? "", after: null, legacyFile: true, beforeBytes: read.bytes });
			} else {
				addSkip(skipped, file, "Plain legacy command is not owned; preserve it.");
			}
			continue;
		}
		let target: string;
		try {
			target = await realpath(file);
		} catch {
			addSkip(skipped, file, "Unverifiable legacy symlink is not owned; preserve it.");
			continue;
		}
		if (!inside(packagePath, target)) {
			addSkip(skipped, file, "Legacy symlink points outside selected package; preserve it.");
			continue;
		}
		changes.push({ path: file, kind: "delete", before: await readlink(file), after: null });
	}
}

async function readPackageVersion(pkgRoot: string): Promise<string | undefined> {
	const read = await readCapped(path.join(pkgRoot, "package.json"));
	if (read.state !== "ok") return undefined;
	try {
		const parsed: unknown = JSON.parse(read.text ?? "");
		return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

function validStamp(value: unknown): value is HarnessSetupStamp {
	if (!isRecord(value) || typeof value.version !== "string" || !value.version || Buffer.byteLength(value.version) > 128 || !isRecord(value.harnesses)) return false;
	try {
		for (const [harness, item] of Object.entries(value.harnesses)) {
			if (!Object.hasOwn(HARNESS_MANIFEST, harness) || !isRecord(item)) return false;
			if (typeof item.pkgRoot !== "string" || !item.pkgRoot || Buffer.byteLength(item.pkgRoot) > 32_768) return false;
			if (typeof item.installedAt !== "string" || new Date(item.installedAt).toISOString() !== item.installedAt) return false;
		}
		return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) <= MAX_CONFIG_BYTES;
	} catch {
		return false;
	}
}

interface StampDraft {
	state: "missing" | "ok" | "invalid";
	before: string | null;
	value?: HarnessSetupStamp;
}

async function readStampDraft(agentDir: string): Promise<StampDraft> {
	const file = path.join(path.resolve(agentDir), "harness-setup.json");
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "missing", before: null }
			: { state: "invalid", before: null };
	}
	if (info.isSymbolicLink() || !info.isFile()) return { state: "invalid", before: null };
	const read = await readCapped(file);
	if (read.state !== "ok") return { state: "invalid", before: null };
	try {
		const parsed: unknown = JSON.parse(read.text ?? "");
		return validStamp(parsed) ? { state: "ok", before: read.text ?? "", value: parsed } : { state: "invalid", before: read.text ?? "" };
	} catch {
		return { state: "invalid", before: read.text ?? "" };
	}
}

function attachScope(plan: SetupPlan, roots: string[], agentDir: string): SetupPlan {
	Object.defineProperty(plan, PLAN_SCOPE, {
		value: { roots: roots.map((root) => path.resolve(root)), stampPath: path.join(path.resolve(agentDir), "harness-setup.json") } satisfies PlanScope,
		enumerable: false,
	});
	return plan;
}

function draftFromChange(draft: JsonDraft, dirty: boolean, changes: PlannedChange[]): void {
	finishJsonDraft(draft, dirty, changes);
}

async function planClaudeMcp(
	options: PlanOptions,
	install: boolean,
	cliSteps: CliStep[],
	skipped: PlannedSkip[],
): Promise<void> {
	const file = path.resolve(options.roots.claudeMcp);
	const draft = await readJsonDraft(file, skipped);
	if (!draft) return;
	const container = draft.value.mcpServers;
	if (container !== undefined && !isRecord(container)) {
		addSkip(skipped, file, "mcpServers is not an object; preserve it.");
		return;
	}
	const current = isRecord(container) ? container[PI_BRIDGE_MCP_KEY] : undefined;
	const script = HARNESS_MANIFEST.claude.find(({ kind }) => kind === "mcp")!.script;
	if (install && !(await packageAssetExists(options.pkgRoot, script))) {
		addSkip(skipped, file, "Expected MCP package asset is missing or outside package root.");
		return;
	}
	if (current === undefined) {
		if (install) {
			cliSteps.push({ executable: "claude", args: ["mcp", "add", "-s", "user", PI_BRIDGE_MCP_KEY, "--", "node", packageAsset(options.pkgRoot, script)] });
		}
		return;
	}
	if (!install) {
		cliSteps.push({ executable: "claude", args: ["mcp", "remove", "-s", "user", PI_BRIDGE_MCP_KEY] });
		return;
	}
	const target = isRecord(current) ? mcpTarget(current, "claude") : undefined;
	if (target && path.isAbsolute(target) && path.resolve(target) === packageAsset(options.pkgRoot, script)) return;
	cliSteps.push({ executable: "claude", args: ["mcp", "remove", "-s", "user", PI_BRIDGE_MCP_KEY] });
	cliSteps.push({ executable: "claude", args: ["mcp", "add", "-s", "user", PI_BRIDGE_MCP_KEY, "--", "node", packageAsset(options.pkgRoot, script)] });
}

async function updateStampPlan(
	harness: Harness,
	options: PlanOptions,
	install: boolean,
	changes: PlannedChange[],
	skipped: PlannedSkip[],
): Promise<void> {
	const file = path.join(path.resolve(options.agentDir), "harness-setup.json");
	const stamp = await readStampDraft(options.agentDir);
	if (stamp.state === "invalid") {
		addSkip(skipped, file, "Setup stamp is invalid or unreadable; preserve it.");
		return;
	}
	if (!install) {
		if (!stamp.value || !Object.hasOwn(stamp.value.harnesses, harness)) return;
		const next = { ...stamp.value, harnesses: { ...stamp.value.harnesses } };
		delete next.harnesses[harness];
		changes.push({ path: file, kind: "json", before: stamp.before, after: `${JSON.stringify(next, null, 2)}\n` });
		return;
	}
	const version = await readPackageVersion(options.pkgRoot);
	if (!version) {
		addSkip(skipped, file, "Package version is unavailable; cannot update setup stamp.");
		return;
	}
	const next: HarnessSetupStamp = stamp.value
		? { ...stamp.value, version, harnesses: { ...stamp.value.harnesses } }
		: { version, harnesses: {} };
	const previous = next.harnesses[harness] as HarnessStampEntry | undefined;
	const installedAt = previous?.pkgRoot === path.resolve(options.pkgRoot) && stamp.value?.version === version
		? previous.installedAt
		: new Date().toISOString();
	next.harnesses[harness] = { pkgRoot: path.resolve(options.pkgRoot), installedAt };
	if (!validStamp(next)) {
		addSkip(skipped, file, "Updated setup stamp exceeds limits or has invalid shape; preserve it.");
		return;
	}
	const after = `${JSON.stringify(next, null, 2)}\n`;
	if (after !== stamp.before) changes.push({ path: file, kind: "json", before: stamp.before, after });
}

async function buildPlan(harness: Harness, options: PlanOptions, install: boolean): Promise<SetupPlan> {
	const changes: PlannedChange[] = [];
	const skipped: PlannedSkip[] = [];
	const cliSteps: CliStep[] = [];
	if (!Object.hasOwn(HARNESS_MANIFEST, harness)) {
		return attachScope({ changes, skipped: [{ path: options.agentDir, reason: "Unknown harness name." }], cliSteps }, [], options.agentDir);
	}
	const root = harnessRoot(harness, options.roots);
	const entries = HARNESS_MANIFEST[harness];
	const jsonFiles: string[] = harness === "claude"
		? [path.join(root, "settings.json")]
		: harness === "cursor"
			? [path.join(root, "hooks.json"), path.join(root, "mcp.json")]
			: harness === "codex"
				? [path.join(root, "hooks.json")]
				: [path.join(root, "opencode.json")];
	for (const file of jsonFiles) {
		const draft = await readJsonDraft(file, skipped);
		if (!draft) continue;
		let dirty = false;
		if (harness === "claude" && file.endsWith(`${path.sep}settings.json`)) {
			for (const entry of entries) {
				if (entry.kind === "hook") {
					if (install && !(await packageAssetExists(options.pkgRoot, entry.script))) addSkip(skipped, file, `Expected package asset for ${entry.dest} is missing or outside package root.`);
					else dirty = updateGroupedHook("claude", entry, draft.value, options.pkgRoot, install, skipped, file) || dirty;
				} else if (entry.kind === "statusline") {
					if (install && !(await packageAssetExists(options.pkgRoot, entry.script))) {
						addSkip(skipped, file, "Expected statusLine package asset is missing or outside package root.");
					} else if (install) {
						const current = draft.value.statusLine;
						const expected = { type: "command", command: `node ${JSON.stringify(packageAsset(options.pkgRoot, entry.script))}`, refreshInterval: STATUSLINE_REFRESH_INTERVAL };
						if (current === undefined) {
						 draft.value.statusLine = expected;
						 dirty = true;
						} else if (isRecord(current) && typeof current.command === "string" && ownedCommand(current.command, entry.script)) {
							const replacement = { ...current, ...expected };
							if (JSON.stringify(current) !== JSON.stringify(replacement)) { draft.value.statusLine = replacement; dirty = true; }
						} else addSkip(skipped, file, "Existing statusLine is foreign or malformed; preserve it.");
					} else {
						const current = draft.value.statusLine;
						if (isRecord(current) && typeof current.command === "string" && ownedCommand(current.command, entry.script)) { delete draft.value.statusLine; dirty = true; }
						else if (current !== undefined) addSkip(skipped, file, "Existing statusLine is foreign or malformed; preserve it.");
					}
				}
			}
		} else if (harness === "cursor" && file.endsWith(`${path.sep}hooks.json`)) {
			for (const entry of entries) {
				if (entry.kind !== "hook") continue;
				if (install && !(await packageAssetExists(options.pkgRoot, entry.script))) addSkip(skipped, file, `Expected package asset for ${entry.dest} is missing or outside package root.`);
				else dirty = updateCursorHook(entry, draft.value, options.pkgRoot, install, skipped, file) || dirty;
			}
		} else if (harness === "codex") {
			for (const entry of entries) {
				if (entry.kind !== "hook") continue;
				if (install && !(await packageAssetExists(options.pkgRoot, entry.script))) addSkip(skipped, file, `Expected package asset for ${entry.dest} is missing or outside package root.`);
				else dirty = updateGroupedHook("codex", entry, draft.value, options.pkgRoot, install, skipped, file) || dirty;
			}
		} else {
			dirty = await updateMcp(harness, draft.value, options.pkgRoot, install, skipped, file);
		}
		draftFromChange(draft, dirty, changes);
	}
	if (harness === "claude") await planClaudeMcp(options, install, cliSteps, skipped);
	if (harness === "codex") await planCodexToml(path.join(root, "config.toml"), options.pkgRoot, install, changes, skipped);
	for (const entry of entries) {
		if (entry.kind === "command" || entry.kind === "plugin" || entry.kind === "skill") {
			await planSymlink(root, entry, options.pkgRoot, install, changes, skipped);
		}
	}
	await planStaleBackupLinks(root, entries, options.pkgRoot, changes, skipped);
	// Codex never had Pi command files; never treat its commands/ paths as legacy.
	if (harness !== "codex") await planLegacyLinks(root, options.pkgRoot, install, changes, skipped);
	await updateStampPlan(harness, options, install, changes, skipped);
	return attachScope({ changes, skipped, cliSteps }, [root], options.agentDir);
}

export function planInstall(harness: Harness, options: PlanOptions): Promise<SetupPlan> {
	return buildPlan(harness, options, true);
}

export function planUninstall(harness: Harness, options: PlanOptions): Promise<SetupPlan> {
	return buildPlan(harness, options, false);
}

export async function readStamp(agentDir: string): Promise<HarnessSetupStamp | undefined> {
	const draft = await readStampDraft(agentDir);
	return draft.state === "ok" ? draft.value : undefined;
}

function withinOrEqual(parent: string, child: string): boolean {
	return parent === child || inside(parent, child);
}

async function prospectiveRealPath(file: string): Promise<string> {
	let cursor = path.resolve(file);
	const suffix: string[] = [];
	while (true) {
		try {
			const resolved = await realpath(cursor);
			return path.resolve(resolved, ...suffix.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			suffix.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

async function assertPlanPathAllowed(file: string, scope: PlanScope): Promise<void> {
	const parent = await prospectiveRealPath(path.dirname(file));
	const canonical = path.join(parent, path.basename(file));
	const stamp = await prospectiveRealPath(scope.stampPath);
	if (canonical === stamp) return;
	for (const root of scope.roots) {
		const realRoot = await prospectiveRealPath(root);
		if (withinOrEqual(realRoot, canonical)) return;
	}
	throw new Error("Planned path is outside resolved harness roots and stamp path.");
}

function isTextConfig(change: PlannedChange): boolean {
	return change.kind === "json" || change.kind === "toml";
}

async function currentChangeValue(change: PlannedChange): Promise<{ exists: boolean; value?: string; bytes?: Buffer; info?: Awaited<ReturnType<typeof lstat>> }> {
	let info;
	try {
		info = await lstat(change.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw error;
	}
	if (isTextConfig(change) || change.legacyFile) {
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) return { exists: true, info };
		const read = await readCapped(change.path, change.legacyFile === true);
		if (read.state !== "ok") return { exists: true, info };
		const latest = await lstat(change.path);
		if (!latest.isFile() || latest.isSymbolicLink() || latest.dev !== info.dev || latest.ino !== info.ino) return { exists: true, info: latest };
		return { exists: true, value: read.text ?? "", ...(read.bytes ? { bytes: read.bytes } : {}), info: latest };
	}
	if (!info.isSymbolicLink()) return { exists: true, info };
	return { exists: true, value: await readlink(change.path), info };
}

function valueMatches(change: PlannedChange, current: { exists: boolean; value?: string; bytes?: Buffer }): boolean {
	if (change.before === null) return !current.exists;
	if (change.legacyFile) return current.exists && change.beforeBytes !== undefined && current.bytes?.equals(change.beforeBytes) === true;
	return current.exists && current.value === change.before;
}

// Only regular files (config, stamp, legacy command content) are backed up. A sibling backup of a
// link would still load as a skill or command; the preview diff and ApplyResult.previous carry the
// old target instead.
async function makeBackup(change: PlannedChange, current: { exists: boolean; value?: string; info?: Awaited<ReturnType<typeof lstat>> }, timestamp: string): Promise<string | undefined> {
	if (!current.exists || !(isTextConfig(change) || change.legacyFile)) return undefined;
	const backup = `${change.path}.harness-bak-${timestamp}`;
	try {
		await lstat(backup);
		throw new Error("Backup path already exists.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!current.info?.isFile() || current.info.isSymbolicLink()) {
		throw new Error(change.legacyFile ? "Refusing to back up non-regular legacy command file." : "Refusing to back up non-regular config file.");
	}
	await copyFile(change.path, backup, constants.COPYFILE_EXCL);
	await chmod(backup, current.info.mode & 0o7777);
	const backupRead = await readCapped(backup, change.legacyFile === true);
	const backupMatches = change.legacyFile
		? change.beforeBytes !== undefined && backupRead.bytes?.equals(change.beforeBytes) === true
		: backupRead.text === change.before;
	if (backupRead.state !== "ok" || !backupMatches) {
		throw new Error(change.legacyFile ? "Legacy command changed while creating backup." : "Config changed while creating backup.");
	}
	return backup;
}

async function assertStillMatches(change: PlannedChange): Promise<boolean> {
	try {
		const current = await currentChangeValue(change);
		return valueMatches(change, current);
	} catch {
		return false;
	}
}

async function applyOne(change: PlannedChange, scope: PlanScope, timestamp: string): Promise<ApplyResult> {
	let temp: string | undefined;
	let backup: string | undefined;
	try {
		await assertPlanPathAllowed(change.path, scope);
		const current = await currentChangeValue(change);
		if (!valueMatches(change, current)) return { path: change.path, applied: false, reason: "Path changed since planning or is not an owned regular file/symlink." };
		backup = await makeBackup(change, current, timestamp);
		// An existing link change has no backup; report the old target it replaced or removed.
		const previous = !isTextConfig(change) && !change.legacyFile && change.before !== null ? { previous: change.before } : {};
		if (change.kind === "delete") {
			await assertPlanPathAllowed(change.path, scope);
			if (!(await assertStillMatches(change))) return { path: change.path, applied: false, reason: "Path changed after backup; no delete performed.", ...(backup ? { backup } : {}) };
			await unlink(change.path);
			return { path: change.path, applied: true, ...(backup ? { backup } : {}), ...previous };
		}
		const parent = path.dirname(change.path);
		await mkdir(parent, { recursive: true });
		temp = path.join(parent, `.${path.basename(change.path)}.harness-tmp-${randomUUID()}`);
		if (isTextConfig(change)) {
			if (change.after === null) throw new Error("Config change requires after content.");
			// A new Codex config.toml may later hold secrets (MCP env, tokens): create it owner-only.
			const mode = current.exists && current.info ? current.info.mode & 0o7777 : change.kind === "toml" ? 0o600 : 0o666;
			const handle = await open(temp, "wx", mode);
			try {
				await handle.writeFile(change.after, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (current.exists) await chmod(temp, mode);
		} else {
			if (change.after === null) throw new Error("Symlink change requires after target.");
			await symlink(change.after, temp);
		}
		await assertPlanPathAllowed(change.path, scope);
		if (!(await assertStillMatches(change))) return { path: change.path, applied: false, reason: "Path changed after backup; no write performed.", ...(backup ? { backup } : {}) };
		await rename(temp, change.path);
		temp = undefined;
		return { path: change.path, applied: true, ...(backup ? { backup } : {}), ...previous };
	} catch (error) {
		return { path: change.path, applied: false, reason: error instanceof Error ? error.message : String(error), ...(backup ? { backup } : {}) };
	} finally {
		if (temp) {
			try {
				const info = await lstat(temp);
				if (info.isSymbolicLink() || info.isFile()) await unlink(temp);
				else await rmTemporary(temp);
			} catch {
				// Temp path was already renamed or removed.
			}
		}
	}
}

async function rmTemporary(file: string): Promise<void> {
	await unlink(file).catch(() => undefined);
}

export async function applyPlan(plan: SetupPlan, options: ApplyOptions = {}): Promise<ApplyResult[]> {
	const scope = (plan as ScopedPlan)[PLAN_SCOPE];
	if (!scope) return plan.changes.map(({ path: file }) => ({ path: file, applied: false, reason: "Plan lacks trusted path scope." }));
	const now = typeof options.now === "function" ? options.now() : options.now ?? new Date();
	const isoTimestamp = now.toISOString();
	// Windows forbids colons in filenames; preserve ISO timestamps elsewhere.
	const timestamp = process.platform === "win32" ? isoTimestamp.replaceAll(":", "-") : isoTimestamp;
	const results: ApplyResult[] = [];
	for (const change of plan.changes) results.push(await applyOne(change, scope, timestamp));
	return results;
}

async function applyStampMutation(agentDir: string, change: PlannedChange, now?: ApplyOptions["now"]): Promise<void> {
	const plan = attachScope({ changes: [change], skipped: [], cliSteps: [] }, [], agentDir);
	const [result] = await applyPlan(plan, { now });
	if (!result?.applied) throw new Error(result?.reason ?? "Stamp mutation failed.");
}

export async function writeStamp(agentDir: string, stamp: HarnessSetupStamp, options: ApplyOptions = {}): Promise<void> {
	if (!validStamp(stamp)) throw new Error("Invalid harness setup stamp.");
	const file = path.join(path.resolve(agentDir), "harness-setup.json");
	const current = await readStampDraft(agentDir);
	if (current.state === "invalid") throw new Error("Existing harness setup stamp is invalid or unreadable.");
	const after = `${JSON.stringify(stamp, null, 2)}\n`;
	if (after === current.before) return;
	await applyStampMutation(agentDir, {
		path: file,
		kind: "json",
		before: current.before,
		after,
	}, options.now);
}

export async function removeStampHarness(agentDir: string, harness: Harness, options: ApplyOptions = {}): Promise<void> {
	const current = await readStampDraft(agentDir);
	if (current.state === "invalid") throw new Error("Existing harness setup stamp is invalid or unreadable.");
	if (!current.value || !Object.hasOwn(current.value.harnesses, harness)) return;
	const next = { ...current.value, harnesses: { ...current.value.harnesses } };
	delete next.harnesses[harness];
	await applyStampMutation(agentDir, {
		path: path.join(path.resolve(agentDir), "harness-setup.json"),
		kind: "json",
		before: current.before,
		after: `${JSON.stringify(next, null, 2)}\n`,
	}, options.now);
}
