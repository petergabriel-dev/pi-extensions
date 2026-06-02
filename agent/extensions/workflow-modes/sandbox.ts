import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export type SandboxLauncher = "sandbox-exec" | "bwrap" | "none";

export interface DetectLauncherOptions {
	platform?: NodeJS.Platform;
	exists?: (path: string) => boolean;
	force?: SandboxLauncher;
}

export interface SandboxWrapOptions {
	cwd: string;
	scratchDir?: string;
	launcher?: SandboxLauncher;
}

export interface SandboxWrapResult {
	launcher: SandboxLauncher;
	command: string;
	wrapped: boolean;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizePath(path: string): string {
	const resolved = resolve(path);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function detectLauncher(options: DetectLauncherOptions = {}): SandboxLauncher {
	if (options.force) return options.force;
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;

	if (platform === "darwin" && exists("/usr/bin/sandbox-exec")) return "sandbox-exec";
	if (platform === "linux" && (exists("/usr/bin/bwrap") || exists("/bin/bwrap"))) return "bwrap";
	return "none";
}

export function buildSeatbeltProfile(options: { cwd: string; homeDir?: string; scratchDir: string }): string {
	const cwd = normalizePath(options.cwd);
	const home = normalizePath(options.homeDir ?? process.env.HOME ?? cwd);
	const scratch = normalizePath(options.scratchDir);

	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny file-write*)",
		`(allow file-write* (literal ${JSON.stringify(scratch)}))`,
		`(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
		"(allow file-write* (literal \"/dev/null\"))",
		`;; repo read-only: ${cwd}`,
		`;; home read-only: ${home}`,
	].join("\n");
}

export function buildBubblewrapCommand(command: string, options: { cwd: string; scratchDir: string }): string {
	const cwd = normalizePath(options.cwd);
	const scratch = normalizePath(options.scratchDir);
	const inner = `cd ${shellQuote(cwd)} && ${command}`;
	return [
		"bwrap",
		"--unshare-net",
		"--ro-bind / /",
		`--tmpfs ${shellQuote(scratch)}`,
		`--setenv TMPDIR ${shellQuote(scratch)}`,
		"--setenv PYTHONDONTWRITEBYTECODE 1",
		`/bin/bash -lc ${shellQuote(inner)}`,
	].join(" ");
}

export function wrapCommand(command: string, options: SandboxWrapOptions): SandboxWrapResult {
	const launcher = options.launcher ?? detectLauncher();
	if (launcher === "none") {
		return { launcher, command, wrapped: false };
	}

	const cwd = normalizePath(options.cwd);
	const scratchDir = normalizePath(options.scratchDir ?? `${tmpdir()}/pi-readonly-bash`);
	const inner = `cd ${shellQuote(cwd)} && ${command}`;

	if (launcher === "sandbox-exec") {
		const profile = buildSeatbeltProfile({ cwd, scratchDir });
		return {
			launcher,
			command: [
				"/usr/bin/sandbox-exec",
				"-p",
				shellQuote(profile),
				"/usr/bin/env",
				`TMPDIR=${shellQuote(scratchDir)}`,
				"PYTHONDONTWRITEBYTECODE=1",
				"/bin/bash",
				"-lc",
				shellQuote(inner),
			].join(" "),
			wrapped: true,
		};
	}

	return {
		launcher,
		command: buildBubblewrapCommand(command, { cwd, scratchDir }),
		wrapped: true,
	};
}
