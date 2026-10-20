import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { CURSOR_HOOK_FAIL_CLOSED, HARNESS_MANIFEST, MAX_CONFIG_BYTES, PI_BRIDGE_MCP_KEY, STATUSLINE_REFRESH_INTERVAL } from "./manifest.ts";
import type { Harness, HarnessEntry } from "./manifest.ts";

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
	| "stamp-version-mismatch"
	| "non-macos-claude-bash-warning"
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
	return {
		claude: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
		claudeMcp: path.join(home, ".claude.json"),
		cursor: path.join(home, ".cursor"),
		opencode: path.join(path.resolve(env.XDG_CONFIG_HOME || path.join(home, ".config")), "opencode"),
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

async function readCapped(file: string): Promise<{ state: "missing" | "ok" | "oversized" | "unreadable"; text?: string }> {
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
		return { state: "ok", text: buffer.subarray(0, total).toString("utf8") };
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

function eventCandidates(eventValue: unknown, harness: Harness, dest: string, problems: SetupProblem[]): Record<string, unknown>[] {
	if (!Array.isArray(eventValue)) {
		problem(problems, harness, "malformed-shape", "Hook event must be an array.", dest);
		return [];
	}
	const candidates: Record<string, unknown>[] = [];
	for (const event of eventValue) {
		if (!isRecord(event)) {
			problem(problems, harness, "malformed-shape", "Hook event entries must be objects.", dest);
			continue;
		}
		if (harness === "claude") {
			if (!Array.isArray(event.hooks)) {
				problem(problems, harness, "malformed-shape", "Claude hook entries must contain hooks array.", dest);
				continue;
			}
			for (const hook of event.hooks) {
				if (!isRecord(hook) || typeof hook.command !== "string" || hook.type !== "command") problem(problems, harness, "malformed-shape", "Claude hook must use type command with a string command.", dest);
				else candidates.push(hook);
			}
		} else if (typeof event.command !== "string") {
			problem(problems, harness, "malformed-shape", "Cursor hook command must be a string.", dest);
		} else candidates.push(event);
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
		for (const candidate of candidates) {
			const target = commandTarget(candidate.command as string);
			if (!looksLikeOwnedTarget(target, entry.script)) {
				foundForeign = true;
				continue;
			}
			const validTarget = await checkTarget(target, entry.script, pkgRoot, harness, entry.dest, problems);
			const validCursor = harness !== "cursor" || candidate.failClosed === CURSOR_HOOK_FAIL_CLOSED;
			if (!validCursor) problem(problems, harness, "malformed-shape", `Cursor bridge hook must set failClosed: ${CURSOR_HOOK_FAIL_CLOSED}.`, entry.dest);
			if (validTarget && validCursor) satisfied.add(entry.dest);
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
		problem(problems, harness, "entry-not-ours", "Expected package symlink destination is not a symlink.", entry.dest);
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
			problem(problems, harness, "entry-not-ours", `Unprefixed ${name}.md is not an owned package symlink; preserve it.`, dest);
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

	const root = harness === "claude" ? options.roots.claude : harness === "cursor" ? options.roots.cursor : options.roots.opencode;
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
		await inspectCommandEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	} else if (harness === "cursor") {
		const hooks = await readConfig(path.join(root, "hooks.json"), harness, "hooks.json", problems);
		if (hooks.exists && !hooks.value && problems.some((item) => item.dest === "hooks.json")) signal.value = true;
		await inspectHooks(harness, hooks, entries, options.pkgRoot, satisfied, problems, signal);
		const mcp = await readConfig(path.join(root, "mcp.json"), harness, "mcp.json", problems);
		if (mcp.exists && !mcp.value && problems.some((item) => item.dest === "mcp.json")) signal.value = true;
		await inspectMcp(harness, mcp, entries.find(({ kind }) => kind === "mcp")!, options.pkgRoot, satisfied, problems, signal);
		await inspectCommandEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	} else {
		const plugin = entries.find(({ kind }) => kind === "plugin")!;
		await inspectSymlink(harness, root, plugin, options.pkgRoot, satisfied, problems, signal);
		const config = await readConfig(path.join(root, "opencode.json"), harness, "opencode.json", problems);
		if (config.exists && !config.value && problems.some((item) => item.dest === "opencode.json")) signal.value = true;
		await inspectMcp(harness, config, entries.find(({ kind }) => kind === "mcp")!, options.pkgRoot, satisfied, problems, signal);
		await inspectCommandEntries(harness, root, entries, options.pkgRoot, satisfied, problems, signal);
	}

	await inspectLegacyCommands(harness, root, options.pkgRoot, problems, signal);
	if (!signal.value && !problems.some(({ severity }) => severity === "error")) return { state: "not-installed", problems };
	for (const entry of entries) {
		if (!satisfied.has(entry.dest)) problem(problems, harness, "missing-entry", "Expected owned manifest entry is missing or incorrect.", entry.dest);
	}
	if (harness === "claude" && (options.platform ?? process.platform) !== "darwin") {
		problem(problems, harness, "non-macos-claude-bash-warning", "Claude Bash sandbox behavior is platform-dependent; verify fail-closed behavior on this non-macOS host.", "settings.json#/hooks/PreToolUse", "warning");
	}
	return { state: problems.some(({ severity }) => severity === "error") ? "needs-fix" : "ok", problems };
}

async function inspectCommandEntries(
	harness: Harness,
	root: string,
	entries: HarnessEntry[],
	pkgRoot: string,
	satisfied: Set<string>,
	problems: SetupProblem[],
	signal: { value: boolean },
): Promise<void> {
	for (const entry of entries) {
		if (entry.kind === "command" || entry.kind === "plugin") {
			await inspectSymlink(harness, root, entry, pkgRoot, satisfied, problems, signal);
		}
	}
}
