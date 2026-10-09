import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_SUBAGENT_LOG_BYTES = 1_024 * 1_024;
export const MAX_SUBAGENT_TAIL_BYTES = 8 * 1_024;
export const SUBAGENT_RUNTIME_DIR_MODE = 0o700;
export const SUBAGENT_LOG_MODE = 0o600;
const MAX_PARTIAL_LINE_BYTES = 64 * 1024;

interface PendingDiagnosticLine {
	text: string;
	prefixed: boolean;
}

export type SubagentTransport = "rpc";

export interface SubagentDiagnosticsOptions {
	parentSessionId: string;
	childSessionId: string;
	owner: string;
	token: string;
	agentDir?: string;
}

export interface SubagentDiagnostics {
	readonly logPath: string;
	append(source: string, chunk: string | Uint8Array): void;
	tail(): string;
	close(): void;
}

function validateIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || value.length > 128) throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
}

export function resolveSubagentDiagnosticsPath(parentSessionId: string, owner: string, agentDir = getAgentDir()): string {
	validateIdentifier(parentSessionId, "parentSessionId");
	validateIdentifier(owner, "owner");
	return path.join(agentDir, "subagents", parentSessionId, `${owner}.log`);
}

export function redactSubagentText(text: string, token: string): string {
	return token ? text.replaceAll(token, "[REDACTED]") : text;
}

function truncateTail(text: string): string {
	let output = text;
	while (Buffer.byteLength(output, "utf8") > MAX_SUBAGENT_TAIL_BYTES) output = output.slice(1);
	return output;
}

function splitForTokenHoldback(text: string, token: string): number {
	const holdBytes = Math.max(0, Buffer.byteLength(token, "utf8") - 1);
	let split = text.length;
	while (split > 0 && Buffer.byteLength(text.slice(split), "utf8") < holdBytes) split -= 1;
	while (split > 0 && Buffer.byteLength(text.slice(split), "utf8") > holdBytes) split += 1;
	for (let length = Math.min(token.length - 1, split); length > 0; length -= 1) {
		if (token.startsWith(text.slice(split - length, split))) {
			split -= length;
			break;
		}
	}
	return split;
}

function regularFileOrMissing(filePath: string): void {
	if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isFile()) throw new Error(`Subagent diagnostics path is not a regular file: ${filePath}`);
}

class BoundedSubagentDiagnostics implements SubagentDiagnostics {
	readonly logPath: string;
	private readonly token: string;
	private readonly childSessionId: string;
	private readonly file: number;
	private readonly pending = new Map<string, PendingDiagnosticLine>();
	private tailValue = "";
	private logBytes = 0;
	private closed = false;

	constructor(options: SubagentDiagnosticsOptions) {
		this.logPath = resolveSubagentDiagnosticsPath(options.parentSessionId, options.owner, options.agentDir);
		this.token = options.token;
		this.childSessionId = options.childSessionId;
		const directory = path.dirname(this.logPath);
		fs.mkdirSync(directory, { recursive: true, mode: SUBAGENT_RUNTIME_DIR_MODE });
		fs.chmodSync(directory, SUBAGENT_RUNTIME_DIR_MODE);
		regularFileOrMissing(this.logPath);
		this.file = fs.openSync(this.logPath, "a", SUBAGENT_LOG_MODE);
		fs.fchmodSync(this.file, SUBAGENT_LOG_MODE);
		try {
			const size = fs.fstatSync(this.file).size;
			if (size > MAX_SUBAGENT_LOG_BYTES) fs.ftruncateSync(this.file, MAX_SUBAGENT_LOG_BYTES);
			this.logBytes = Math.min(size, MAX_SUBAGENT_LOG_BYTES);
		} catch {
			this.logBytes = 0;
		}
	}

	append(source: string, chunk: string | Uint8Array): void {
		if (this.closed || this.logBytes >= MAX_SUBAGENT_LOG_BYTES) return;
		const label = source.trim() || "output";
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (!text) return;
		const pending = this.pending.get(label) ?? { text: "", prefixed: false };
		let combined = `${pending.text}${text}`;
		let newline = combined.indexOf("\n");
		while (newline !== -1) {
			this.writeLine(label, combined.slice(0, newline), pending.prefixed, true);
			combined = combined.slice(newline + 1);
			pending.text = "";
			pending.prefixed = false;
			newline = combined.indexOf("\n");
		}
		pending.text = combined;
		while (Buffer.byteLength(pending.text, "utf8") > MAX_PARTIAL_LINE_BYTES) {
			const split = splitForTokenHoldback(pending.text, this.token);
			if (split === 0) break;
			const safe = pending.text.slice(0, split);
			pending.text = pending.text.slice(split);
			this.write(`${pending.prefixed ? "" : `[${label}] `}${redactSubagentText(safe, this.token)}`);
			pending.prefixed = true;
		}
		if (pending.text || pending.prefixed) this.pending.set(label, pending);
		else this.pending.delete(label);
	}

	tail(): string {
		let pendingText = "";
		for (const [source, line] of this.pending) {
			if (line.text) pendingText += `${line.prefixed ? "" : `[${source}] `}${line.text}`;
		}
		return truncateTail(redactSubagentText(`${this.tailValue}${pendingText}`, this.token));
	}

	close(): void {
		if (this.closed) return;
		for (const [source, line] of this.pending) {
			if (line.text) this.writeLine(source, line.text, line.prefixed, false);
		}
		this.pending.clear();
		this.closed = true;
		try { fs.closeSync(this.file); } catch { /* best effort */ }
	}

	private writeLine(source: string, line: string, prefixed: boolean, newline: boolean): void {
		const text = line.endsWith("\r") ? line.slice(0, -1) : line;
		const warning = `Warning: No project session found with id '${this.childSessionId}'; creating a new session with that id.`;
		if (!prefixed && source === "stderr" && text === warning) return;
		this.write(`${prefixed ? "" : `[${source}] `}${redactSubagentText(text, this.token)}${newline ? "\n" : ""}`);
	}

	private write(text: string): void {
		if (this.closed || this.logBytes >= MAX_SUBAGENT_LOG_BYTES) return;
		const remaining = MAX_SUBAGENT_LOG_BYTES - this.logBytes;
		const bytes = Buffer.from(text, "utf8");
		const output = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
		let safeOutput = output.toString("utf8");
		while (Buffer.byteLength(safeOutput, "utf8") > remaining) safeOutput = safeOutput.slice(0, -1);
		if (!safeOutput) return;
		const encoded = Buffer.from(safeOutput, "utf8");
		try {
			fs.writeSync(this.file, encoded);
			this.logBytes += encoded.byteLength;
			this.tailValue = truncateTail(`${this.tailValue}${safeOutput}`);
		} catch {
			// Diagnostics must not terminate child work when the runtime filesystem fails.
		}
	}
}

export function createSubagentDiagnostics(options: SubagentDiagnosticsOptions): SubagentDiagnostics {
	return new BoundedSubagentDiagnostics(options);
}
