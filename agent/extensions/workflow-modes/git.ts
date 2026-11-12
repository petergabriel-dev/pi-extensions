import { execFile } from "node:child_process";

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 512 * 1024;
export const COMMIT_INPUT = /^[0-9a-f]{7,64}$/i;
const FULL_SHA = /^[0-9a-f]{40,64}$/;

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	missing: boolean;
}

// Fixed argv, no shell. Callers validate every argument before it reaches git.
export function runGit(cwd: string, args: readonly string[], maxBuffer = GIT_MAX_BUFFER): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer,
			shell: false,
			windowsHide: true,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		}, (error, stdout, stderr) => {
			const missing = Boolean(error && (error as NodeJS.ErrnoException).code === "ENOENT");
			resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), missing });
		});
	});
}

export function normalizeCommitInput(value: unknown): string {
	if (typeof value !== "string" || !COMMIT_INPUT.test(value.trim())) throw new Error("commit must be a 7-64 character hexadecimal SHA");
	return value.trim().toLowerCase();
}

// Resolves a commit-ish SHA to its full object name, or throws an explicit error.
export async function resolveCommit(cwd: string, value: unknown): Promise<string> {
	const sha = normalizeCommitInput(value);
	const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]);
	if (result.missing) throw new Error("git is not available to verify commit");
	const full = result.stdout.trim();
	if (!result.ok || !FULL_SHA.test(full)) {
		const detail = result.stderr.trim().split("\n")[0];
		throw new Error(`commit ${sha} is not a commit in this repository${detail ? ` (${detail.slice(0, 200)})` : ""}`);
	}
	return full;
}
