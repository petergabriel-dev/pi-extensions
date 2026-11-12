import { redactText } from "./review-redact.js";

// Pure per-attempt evidence capture for Pi Build. No I/O: callers pass time and env,
// and persist only through the bundle step (tick) or a counts-only abandon event.

export const MAX_PENDING_TOOL_CALLS = 200;
export const MAX_COMMAND_RECORDS = 50;
export const MAX_ATTEMPT_PATHS = 200;
export const MAX_RECORD_TEXT_BYTES = 2048;
const MAX_PATH_LENGTH = 512;
const OUTPUT_WINDOW_BYTES = 64 * 1024;
// Pi 0.80.x bash appends this to the error text of a non-zero exit (dist/core/tools/bash.js).
export const EXIT_CODE_PHRASE = /Command exited with code (\d{1,10})/g;

type Env = Readonly<Record<string, string | undefined>>;

export interface CommandRecord {
	cmd: string;
	exit: number | null;
	ms: number;
	tail: string;
}

interface PendingCall {
	kind: "bash" | "path";
	cmd?: string;
	path?: string;
	startedAt: number;
}

export interface CaptureAttempt {
	attemptId: string;
	sessionId: string;
	planId: string;
	taskId: string;
	startedAt: number;
	baseline?: string;
	commands: CommandRecord[];
	paths: string[];
	subagents: unknown[];
	pending: Map<string, PendingCall>;
	redactions: number;
	droppedCommands: number;
	droppedPending: number;
	droppedPaths: number;
	unknownExits: number;
}

export interface ToolCallLike {
	toolCallId: string;
	toolName: string;
	input?: unknown;
}

export interface ToolResultLike {
	toolCallId: string;
	content?: unknown;
	isError?: boolean;
}

export function openAttempt(fields: { attemptId: string; sessionId: string; planId: string; taskId: string; startedAt: number }): CaptureAttempt {
	return { ...fields, commands: [], paths: [], subagents: [], pending: new Map(), redactions: 0, droppedCommands: 0, droppedPending: 0, droppedPaths: 0, unknownExits: 0 };
}

function headBytes(text: string, max: number): string {
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= max ? text : bytes.subarray(0, max).toString("utf8");
}

function tailBytes(text: string, max: number): string {
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= max ? text : bytes.subarray(bytes.length - max).toString("utf8");
}

function redacted(attempt: CaptureAttempt, text: string, env: Env): string {
	const result = redactText(text, env);
	attempt.redactions += result.redactions;
	return result.text;
}

function inputField(input: unknown, field: string): string | undefined {
	const value = input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
	return typeof value === "string" ? value : undefined;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
		.map((part) => part.text)
		.join("\n");
}

export function parseExitCode(text: string): number | null {
	let last: number | null = null;
	for (const match of text.matchAll(EXIT_CODE_PHRASE)) last = Number(match[1]);
	return last !== null && Number.isSafeInteger(last) ? last : null;
}

export function recordToolCall(attempt: CaptureAttempt, event: ToolCallLike, now: number, env: Env): void {
	if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
	let call: PendingCall | undefined;
	if (event.toolName === "bash") {
		const command = inputField(event.input, "command");
		if (command === undefined) return;
		call = { kind: "bash", cmd: headBytes(redacted(attempt, command, env), MAX_RECORD_TEXT_BYTES), startedAt: now };
	} else if (event.toolName === "edit" || event.toolName === "write") {
		const path = inputField(event.input, "path");
		if (path === undefined) return;
		call = { kind: "path", path: redacted(attempt, path, env).slice(0, MAX_PATH_LENGTH), startedAt: now };
	} else {
		return;
	}
	if (attempt.pending.size >= MAX_PENDING_TOOL_CALLS) {
		// A blocked tool_call may never produce a tool_result; evict the oldest.
		const oldest = attempt.pending.keys().next().value;
		if (oldest !== undefined) attempt.pending.delete(oldest);
		attempt.droppedPending += 1;
	}
	attempt.pending.set(event.toolCallId, call);
}

export function recordToolResult(attempt: CaptureAttempt, event: ToolResultLike, now: number, env: Env): void {
	const call = attempt.pending.get(event.toolCallId);
	if (!call) return;
	attempt.pending.delete(event.toolCallId);
	if (call.kind === "path") {
		if (event.isError || !call.path || attempt.paths.includes(call.path)) return;
		if (attempt.paths.length >= MAX_ATTEMPT_PATHS) {
			attempt.droppedPaths += 1;
			return;
		}
		attempt.paths.push(call.path);
		return;
	}
	// Output and the exit phrase sit at the end. Window the raw tail before redacting so
	// redaction's head-keeping work cap cannot drop them; any secret cut at the window
	// edge is far outside the 2 KiB tail that is kept.
	const text = redacted(attempt, tailBytes(contentText(event.content), OUTPUT_WINDOW_BYTES), env);
	let exit: number | null = 0;
	if (event.isError) {
		exit = parseExitCode(text);
		if (exit === null) attempt.unknownExits += 1;
	}
	if (attempt.commands.length >= MAX_COMMAND_RECORDS) {
		attempt.droppedCommands += 1;
		return;
	}
	attempt.commands.push({ cmd: call.cmd ?? "", exit, ms: Math.max(0, now - call.startedAt), tail: tailBytes(text, MAX_RECORD_TEXT_BYTES) });
}

export function attemptWarnings(attempt: CaptureAttempt): string[] {
	const warnings: string[] = [];
	if (attempt.droppedCommands > 0) warnings.push(`truncated: ${attempt.droppedCommands} command record(s) beyond ${MAX_COMMAND_RECORDS} not kept`);
	if (attempt.droppedPaths > 0) warnings.push(`truncated: ${attempt.droppedPaths} changed path(s) beyond ${MAX_ATTEMPT_PATHS} not kept`);
	if (attempt.unknownExits > 0) warnings.push(`unavailable: exit code for ${attempt.unknownExits} failed command(s); recorded as null`);
	const unmatched = attempt.pending.size + attempt.droppedPending;
	if (unmatched > 0) warnings.push(`incomplete: ${unmatched} tool call(s) had no matching result`);
	return warnings;
}

// Counts only: an abandoned attempt never persists command text, output, or paths.
export function abandonedSummary(attempt: CaptureAttempt, reason: string): Record<string, unknown> {
	return {
		ev: "attempt_abandoned",
		planId: attempt.planId,
		taskId: attempt.taskId,
		attemptId: attempt.attemptId,
		reason,
		commands: attempt.commands.length + attempt.droppedCommands,
		paths: attempt.paths.length + attempt.droppedPaths,
		unmatched: attempt.pending.size + attempt.droppedPending,
	};
}
