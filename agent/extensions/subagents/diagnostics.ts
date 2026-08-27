import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_SUBAGENT_LOG_BYTES = 1_024 * 1_024;
export const MAX_SUBAGENT_TAIL_BYTES = 8 * 1_024;
export const SUBAGENT_RUNTIME_DIR_MODE = 0o700;
export const SUBAGENT_LOG_MODE = 0o600;

export type SubagentTransport = "cmux" | "headless";

export interface SubagentDiagnosticsOptions {
	parentSessionId: string;
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

function regularFileOrMissing(filePath: string): void {
	if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isFile()) throw new Error(`Subagent diagnostics path is not a regular file: ${filePath}`);
}

class BoundedSubagentDiagnostics implements SubagentDiagnostics {
	readonly logPath: string;
	private readonly token: string;
	private readonly file: number;
	private readonly pending = new Map<string, string>();
	private tailValue = "";
	private logBytes = 0;
	private closed = false;

	constructor(options: SubagentDiagnosticsOptions) {
		this.logPath = resolveSubagentDiagnosticsPath(options.parentSessionId, options.owner, options.agentDir);
		this.token = options.token;
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
		const previous = this.pending.get(label) ?? "";
		const combined = `${previous}${text}`;
		const holdBytes = Math.max(0, Buffer.byteLength(this.token, "utf8") - 1);
		let safe = combined;
		if (holdBytes > 0 && Buffer.byteLength(combined, "utf8") > holdBytes) {
			let split = combined.length;
			while (split > 0 && Buffer.byteLength(combined.slice(split), "utf8") < holdBytes) split -= 1;
			while (split > 0 && Buffer.byteLength(combined.slice(split), "utf8") > holdBytes) split += 1;
			safe = combined.slice(0, split);
			this.pending.set(label, combined.slice(split));
		} else if (holdBytes > 0) {
			this.pending.set(label, combined);
			safe = "";
		} else {
			this.pending.delete(label);
		}
		if (safe) this.write(`[${label}] ${redactSubagentText(safe, this.token)}`);
	}

	tail(): string {
	let pendingText = "";
	for (const [source, value] of this.pending) pendingText += `[${source}] ${redactSubagentText(value, this.token)}`;
	return truncateTail(`${this.tailValue}${pendingText}`);
	}

	close(): void {
		if (this.closed) return;
		for (const [source, value] of this.pending) {
			if (value) this.write(`[${source}] ${redactSubagentText(value, this.token)}`);
		}
		this.pending.clear();
		this.closed = true;
		try { fs.closeSync(this.file); } catch { /* best effort */ }
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
