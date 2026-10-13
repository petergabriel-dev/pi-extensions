import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const CCC_EXECUTABLE = "ccc";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

const CccSearchParams = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 1_000, description: "Semantic search query" }),
	languages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20, description: "Language filters passed as repeated --lang arguments" })),
	path: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Project-relative file path glob" })),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, default: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
	refresh: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false });

export type CccSearchInput = Static<typeof CccSearchParams>;

export interface CccSearchResult {
	ok: boolean;
	args: string[];
	stdout: string;
	stderr: string;
	exitCode: number | string | null;
	durationMs: number;
	error?: string;
	failureKind?: "cancelled" | "timeout" | "missing_executable" | "uninitialized" | "output_limit" | "exit";
}

export interface RunCccSearchOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

type ExecFailure = Error & {
	code?: number | string | null;
	killed?: boolean;
	signal?: NodeJS.Signals | null;
	stdout?: string;
	stderr?: string;
};

function requireBoundedString(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${name} must not be empty`);
	if (trimmed.length > maximum) throw new Error(`${name} must contain at most ${maximum} characters`);
	if (trimmed.includes("\0")) throw new Error(`${name} must not contain null bytes`);
	return trimmed;
}

function validateInteger(value: number, name: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function validatePathFilter(value: string): string {
	const path = requireBoundedString(value, "path", 512);
	if (path.startsWith("-") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) throw new Error("path must be project-relative");
	if (path.split(/[\\/]+/).includes("..")) throw new Error("path must not traverse outside the project");
	return path;
}

export function buildCccSearchArgs(input: CccSearchInput): string[] {
	const query = requireBoundedString(input.query, "query", 1_000);
	const offset = validateInteger(input.offset ?? 0, "offset", 0, 10_000);
	const limit = validateInteger(input.limit ?? 10, "limit", 1, 100);
	if (input.languages !== undefined && !Array.isArray(input.languages)) throw new Error("languages must be an array");
	if (input.languages && input.languages.length > 20) throw new Error("languages must contain at most 20 entries");
	if (input.refresh !== undefined && typeof input.refresh !== "boolean") throw new Error("refresh must be a boolean");

	const args = ["search"];
	for (const value of input.languages ?? []) {
		const language = requireBoundedString(value, "language", 64);
		if (!/^[A-Za-z0-9][A-Za-z0-9_+#.-]*$/.test(language)) throw new Error("language contains unsupported characters");
		args.push("--lang", language);
	}
	if (input.path !== undefined) args.push("--path", validatePathFilter(input.path));
	args.push("--offset", String(offset), "--limit", String(limit));
	if (input.refresh) args.push("--refresh");
	args.push("--", query);
	return args;
}

function boundedStreams(stdout: string, stderr: string): { stdout: string; stderr: string } {
	let remaining = MAX_OUTPUT_BYTES;
	const take = (value: string): string => {
		if (remaining <= 0) return "";
		const bytes = Buffer.from(value);
		if (bytes.length <= remaining) {
			remaining -= bytes.length;
			return value;
		}
		const truncated = bytes.subarray(0, remaining).toString("utf8").replace(/\uFFFD$/, "");
		remaining = 0;
		return truncated;
	};
	return { stdout: take(stdout), stderr: take(stderr) };
}

function actionableFailure(error: ExecFailure, signal: AbortSignal | undefined, timeoutMs: number, stderr: string, stdout: string): Pick<CccSearchResult, "error" | "failureKind"> {
	const combined = `${stderr}\n${stdout}\n${error.message}`;
	if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") {
		return { error: "CCC search cancelled.", failureKind: "cancelled" };
	}
	if (error.code === "ENOENT") {
		return { error: "`ccc` executable not found on PATH. Install cocoindex-code before searching.", failureKind: "missing_executable" };
	}
	if (/not in an initialized project directory/i.test(combined)) {
		return { error: "CCC project is not initialized. In Build mode, run `ccc init` then `ccc index`.", failureKind: "uninitialized" };
	}
	if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		return { error: `CCC search output exceeded ${MAX_OUTPUT_BYTES} bytes. Narrow the query or lower limit.`, failureKind: "output_limit" };
	}
	if (error.killed && error.signal) {
		return { error: `CCC search timed out after ${timeoutMs} ms. Narrow the query and retry.`, failureKind: "timeout" };
	}
	return { error: `CCC search failed with exit status ${String(error.code ?? "unknown")}.`, failureKind: "exit" };
}

export async function runCccSearch(input: CccSearchInput, options: RunCccSearchOptions): Promise<CccSearchResult> {
	const args = buildCccSearchArgs(input);
	const timeoutMs = validateInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1, 300_000);
	const startedAt = performance.now();

	return new Promise((resolve) => {
		execFile(CCC_EXECUTABLE, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf8",
			maxBuffer: MAX_OUTPUT_BYTES,
			signal: options.signal,
			timeout: timeoutMs,
		}, (rawError, rawStdout, rawStderr) => {
			const streams = boundedStreams(String(rawStdout ?? ""), String(rawStderr ?? ""));
			const durationMs = performance.now() - startedAt;
			if (!rawError) {
				return resolve({ ok: true, args, ...streams, exitCode: 0, durationMs });
			}
			const error = rawError as ExecFailure;
			const failure = actionableFailure(error, options.signal, timeoutMs, streams.stderr, streams.stdout);
			resolve({ ok: false, args, ...streams, exitCode: error.code ?? null, durationMs, ...failure });
		});
	});
}

function resultText(result: CccSearchResult): string {
	if (!result.ok) {
		const diagnostics = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
		return diagnostics ? `${result.error}\n${diagnostics}` : result.error!;
	}
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return output || "CCC search returned no results.";
}

export default function cccSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ccc_search",
		label: "CCC Search",
		description: "Run semantic code search through fixed, validated `ccc search` argv without invoking a shell.",
		promptSnippet: "Semantically search an initialized codebase with query, language/path filters, pagination, and optional refresh",
		promptGuidelines: [
			"Prefer ccc_search for semantic code discovery in every workflow mode; use rg/find/read as fallback for exact lookup or unavailable indexes.",
			"ccc_search never initializes projects; initialization and index management require Build mode.",
		],
		parameters: CccSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const result = await runCccSearch(params, { cwd: ctx.cwd, signal });
				return { content: [{ type: "text", text: resultText(result) }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Invalid ccc_search input: ${message}` }], details: { ok: false, failureKind: "validation", error: message } };
			}
		},
	});
}
