import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./git.js";
import { attemptWarnings, type CaptureAttempt, type CommandRecord, type RunSummary } from "./review-capture.js";
import { isSensitivePath, redactText } from "./review-redact.js";
import { appendReviewEvent, ensurePrivateDir, reviewSessionDir, writeOnce0600 } from "./review-store.js";

// Write-once evidence bundle for one ticked task: git-derived changes plus whatever
// Pi captured. Every text field is redacted before the bundle is hashed or written.

export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_BUNDLE_HUNK_BYTES = 128 * 1024;
const MAX_HUNK_FILES = 100;
const MAX_FILES_LISTED = 500;
const MAX_FILES_WARNINGS = 20;
const FULL_SHA = /^[0-9a-f]{40,64}$/;

type Env = Readonly<Record<string, string | undefined>>;

export interface BundleFile {
	path: string;
	status: string;
	from?: string;
}

export interface EvidenceBundle {
	version: 1;
	planId: string;
	taskId: string;
	tickedBy: string;
	attemptId?: string;
	baseline?: string;
	commit?: string;
	files: BundleFile[];
	hunks: Array<{ path: string; text: string }>;
	commands: CommandRecord[];
	subagents: RunSummary[];
	redactions: number;
	warnings: string[];
}

export interface BundleInput {
	cwd: string;
	planId: string;
	taskId: string;
	by: string;
	commit?: string;
	attempt?: CaptureAttempt;
	taskFiles?: string;
	env: Env;
}

async function revParse(cwd: string, revision: string): Promise<string | undefined> {
	const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", revision]);
	const sha = result.stdout.trim();
	return result.ok && FULL_SHA.test(sha) ? sha : undefined;
}

// `git diff --name-status -z`: status, then one path (two for renames/copies).
function parseNameStatus(output: string): BundleFile[] {
	const parts = output.split("\0");
	const files: BundleFile[] = [];
	for (let index = 0; index < parts.length && parts[index]; ) {
		const status = parts[index++];
		if (/^[RC]/.test(status)) {
			const from = parts[index++];
			const path = parts[index++];
			if (path !== undefined) files.push({ path, status: status[0], ...(from !== undefined ? { from } : {}) });
		} else {
			const path = parts[index++];
			if (path !== undefined) files.push({ path, status: status.slice(0, 1) });
		}
	}
	return files;
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

export function outsideTaskFiles(taskFiles: string | undefined, paths: readonly string[]): string[] {
	if (!taskFiles || taskFiles.trim().length === 0) return [];
	const patterns = taskFiles.split(",").map((entry) => entry.trim().replace(/^\.\//, "")).filter(Boolean);
	if (patterns.length === 0) return [];
	const matchers = patterns.map((pattern) => (pattern.endsWith("/") ? (path: string) => path.startsWith(pattern) : (path: string) => globToRegExp(pattern).test(path) || path.startsWith(`${pattern}/`)));
	return paths.filter((path) => !matchers.some((matches) => matches(path)));
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function serializeBundle(bundle: EvidenceBundle): string {
	return canonical(bundle);
}

export function bundleIdOf(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

function headBytes(text: string, max: number): string {
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= max ? text : bytes.subarray(0, max).toString("utf8");
}

export async function buildEvidenceBundle(input: BundleInput): Promise<EvidenceBundle> {
	const warnings: string[] = [];
	let redactions = 0;
	const redact = (text: string): string => {
		const result = redactText(text, input.env);
		redactions += result.redactions;
		return result.text;
	};
	const attempt = input.attempt;
	if (!attempt) {
		warnings.push(input.by === "pi"
			? "incomplete: no captured attempt for this task (Pi restarted or no tool calls were captured)"
			: `unavailable: harness build commands and subagent activity (built by ${input.by})`);
	}

	let commit = input.commit && FULL_SHA.test(input.commit) ? input.commit : undefined;
	if (!commit) {
		commit = await revParse(input.cwd, "HEAD");
		warnings.push(commit ? "commit not supplied; diffed to HEAD at tick" : "unavailable: git (no commit or HEAD)");
	}
	let baseline = attempt?.baseline && FULL_SHA.test(attempt.baseline) ? attempt.baseline : undefined;
	let rootDiff = false;
	if (commit && !baseline) {
		baseline = await revParse(input.cwd, `${commit}^`);
		if (baseline) warnings.push("baseline inferred as the commit's parent");
		else {
			rootDiff = true;
			warnings.push("baseline unavailable; commit has no parent, diffed against an empty tree");
		}
	}

	if (commit && baseline === commit) warnings.push("incomplete: baseline equals the ticked commit; changes were not captured");

	let files: BundleFile[] = [];
	const hunks: Array<{ path: string; text: string }> = [];
	if (commit) {
		const range = rootDiff ? ["diff-tree", "--root", "-r", "--no-commit-id", "-M", "--name-status", "-z", commit] : ["diff", "--no-color", "--no-ext-diff", "-M", "--name-status", "-z", baseline!, commit, "--"];
		const listed = await runGit(input.cwd, range);
		if (!listed.ok) warnings.push("unavailable: changed-file list (git diff failed)");
		else files = parseNameStatus(listed.stdout);
		if (files.length > MAX_FILES_LISTED) {
			warnings.push(`truncated: ${files.length - MAX_FILES_LISTED} changed file(s) beyond ${MAX_FILES_LISTED} not listed`);
			files = files.slice(0, MAX_FILES_LISTED);
		}
		let hunkBytes = 0;
		let omittedForSize = 0;
		let omittedForCount = 0;
		for (const file of files) {
			if (isSensitivePath(file.path) || (file.from && isSensitivePath(file.from))) {
				warnings.push(`omitted: hunks for sensitive path ${redact(file.path)}`);
				continue;
			}
			if (hunks.length >= MAX_HUNK_FILES) {
				omittedForCount += 1;
				continue;
			}
			if (hunkBytes >= MAX_BUNDLE_HUNK_BYTES) {
				omittedForSize += 1;
				continue;
			}
			const pathspecs = [`:(literal)${file.path}`, ...(file.from ? [`:(literal)${file.from}`] : [])];
			const args = rootDiff
				? ["show", "--no-color", "--no-ext-diff", "-M", "-U3", "--format=", commit, "--", ...pathspecs]
				: ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", baseline!, commit, "--", ...pathspecs];
			const diff = await runGit(input.cwd, args);
			if (!diff.ok) {
				warnings.push(`unavailable: hunks for ${redact(file.path)} (too large or git failed)`);
				continue;
			}
			let text = redact(diff.stdout);
			const remaining = MAX_BUNDLE_HUNK_BYTES - hunkBytes;
			if (Buffer.byteLength(text, "utf8") > remaining) {
				text = headBytes(text, remaining);
				warnings.push(`truncated: hunks for ${redact(file.path)}`);
			}
			hunkBytes += Buffer.byteLength(text, "utf8");
			hunks.push({ path: redact(file.path), text });
		}
		if (omittedForSize > 0) warnings.push(`truncated: hunks for ${omittedForSize} file(s) omitted after ${MAX_BUNDLE_HUNK_BYTES} bytes`);
		if (omittedForCount > 0) warnings.push(`truncated: hunks for ${omittedForCount} file(s) beyond ${MAX_HUNK_FILES} files omitted`);
		files = files.map((file) => ({ ...file, path: redact(file.path), ...(file.from ? { from: redact(file.from) } : {}) }));
	}

	const outside = outsideTaskFiles(input.taskFiles, files.map((file) => file.path));
	for (const path of outside.slice(0, MAX_FILES_WARNINGS)) warnings.push(`outside task Files: ${path}`);
	if (outside.length > MAX_FILES_WARNINGS) warnings.push(`outside task Files: ${outside.length - MAX_FILES_WARNINGS} more`);
	if (attempt) warnings.push(...attemptWarnings(attempt));

	const bundle: EvidenceBundle = {
		version: 1,
		planId: input.planId,
		taskId: input.taskId,
		tickedBy: input.by,
		...(attempt ? { attemptId: attempt.attemptId } : {}),
		...(baseline ? { baseline } : {}),
		...(commit ? { commit } : {}),
		files,
		hunks,
		commands: attempt ? attempt.commands.map((record) => ({ ...record })) : [],
		subagents: attempt ? attempt.subagents.map((summary) => ({ ...summary })) : [],
		redactions: redactions + (attempt?.redactions ?? 0),
		warnings,
	};
	return fitBundle(bundle);
}

// Enforce the byte cap by dropping the bulkiest optional evidence last-in first.
function fitBundle(bundle: EvidenceBundle): EvidenceBundle {
	const dropped = { hunks: 0, subagents: 0, commands: 0 };
	while (Buffer.byteLength(serializeBundle(bundle), "utf8") > MAX_BUNDLE_BYTES) {
		if (bundle.hunks.length > 0) { bundle.hunks.pop(); dropped.hunks += 1; continue; }
		if (bundle.subagents.length > 0) { bundle.subagents.pop(); dropped.subagents += 1; continue; }
		if (bundle.commands.length > 0) { bundle.commands.pop(); dropped.commands += 1; continue; }
		bundle.files = bundle.files.slice(0, Math.floor(bundle.files.length / 2));
		bundle.warnings = bundle.warnings.slice(0, 50);
		if (bundle.files.length === 0) break;
	}
	for (const [kind, count] of Object.entries(dropped)) if (count > 0) bundle.warnings.push(`truncated: ${count} ${kind} entr${count === 1 ? "y" : "ies"} dropped to fit ${MAX_BUNDLE_BYTES} bytes`);
	return bundle;
}

export function evidenceDir(agentDir: string, sessionId: string): string {
	return join(reviewSessionDir(agentDir, sessionId), "evidence");
}

// Content-addressed and write-once: an identical bundle is a no-op, and different
// content always gets a different file, so nothing is ever overwritten.
export async function writeEvidenceBundle(agentDir: string, sessionId: string, bundle: EvidenceBundle): Promise<{ bundleId: string; path: string; written: boolean }> {
	const serialized = serializeBundle(bundle);
	if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_BYTES) throw new Error(`evidence bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
	const bundleId = bundleIdOf(serialized);
	await ensurePrivateDir(reviewSessionDir(agentDir, sessionId));
	const directory = evidenceDir(agentDir, sessionId);
	await ensurePrivateDir(directory);
	const path = join(directory, `${bundleId}.json`);
	const outcome = await writeOnce0600(path, serialized);
	if (outcome === "written") {
		await appendReviewEvent(agentDir, sessionId, { ev: "bundle_created", planId: bundle.planId, taskId: bundle.taskId, bundleId, ...(bundle.commit ? { commit: bundle.commit } : {}), ...(bundle.attemptId ? { attemptId: bundle.attemptId } : {}) });
	}
	return { bundleId, path, written: outcome === "written" };
}

export const BUNDLE_ID = /^[0-9a-f]{64}$/;

// Reads a stored bundle without following symlinks; undefined when it does not exist.
export async function readEvidenceBundle(agentDir: string, sessionId: string, bundleId: string): Promise<EvidenceBundle | undefined> {
	if (!BUNDLE_ID.test(bundleId)) return undefined;
	let handle;
	try {
		handle = await open(join(evidenceDir(agentDir, sessionId), `${bundleId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT" || code === "ELOOP") return undefined;
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_BUNDLE_BYTES) return undefined;
		const value = JSON.parse((await handle.readFile()).toString("utf8")) as EvidenceBundle;
		return value && typeof value === "object" && value.version === 1 ? value : undefined;
	} finally {
		await handle.close();
	}
}

export const EVIDENCE_SECTIONS = ["summary", "files", "hunks", "commands", "subagents", "warnings"] as const;
export type EvidenceSection = typeof EVIDENCE_SECTIONS[number];
// Budget for one page's data string once JSON-escaped, leaving room for the envelope
// so a whole page response stays within 24 KiB.
export const EVIDENCE_PAGE_DATA_BYTES = 22 * 1024;

export interface EvidencePage {
	bundleId: string;
	planId: string;
	taskId: string;
	section: EvidenceSection;
	page: number;
	pages: number;
	data: string;
}

function sectionValue(bundle: EvidenceBundle, section: EvidenceSection): unknown {
	if (section !== "summary") return bundle[section] ?? [];
	return {
		planId: bundle.planId,
		taskId: bundle.taskId,
		tickedBy: bundle.tickedBy,
		attemptId: bundle.attemptId,
		baseline: bundle.baseline,
		commit: bundle.commit,
		redactions: bundle.redactions,
		counts: { files: bundle.files.length, hunks: bundle.hunks.length, commands: bundle.commands.length, subagents: bundle.subagents.length, warnings: bundle.warnings.length },
	};
}

// Splits by escaped UTF-8 size, never inside a code point, so every page is valid text.
function paginate(text: string, budget: number): string[] {
	const pages: string[] = [];
	let current = "";
	let size = 0;
	for (const char of text) {
		const cost = Buffer.byteLength(JSON.stringify(char), "utf8") - 2;
		if (size + cost > budget && current.length > 0) {
			pages.push(current);
			current = "";
			size = 0;
		}
		current += char;
		size += cost;
	}
	if (current.length > 0 || pages.length === 0) pages.push(current);
	return pages;
}

export function evidencePage(bundleId: string, bundle: EvidenceBundle, section: EvidenceSection, page: number): EvidencePage {
	const pages = paginate(JSON.stringify(sectionValue(bundle, section), null, 1), EVIDENCE_PAGE_DATA_BYTES);
	if (!Number.isInteger(page) || page < 0 || page >= pages.length) throw new Error(`evidence ${section} has ${pages.length} page(s); page ${page} does not exist`);
	return { bundleId, planId: bundle.planId, taskId: bundle.taskId, section, page, pages: pages.length, data: pages[page] };
}
