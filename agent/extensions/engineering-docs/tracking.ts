// Docs-relevant change tracking
// Tracks edit/write tool calls that changed docs-relevant files
// and reminds at agent_end if docs weren't touched.

import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDesignTokenIndex, detectDesignAdherence, formatDesignAdvisory } from "./design-adherence.js";
import { DOCS_DIR, IGNORE_PATTERNS, ENTRY_DOCS_REMINDER_SNOOZE } from "./constants.js";
import { isWriteAllowed } from "./mode.js";

// In-memory state (reconstructed on session_start)
let changedFiles: Set<string> = new Set();      // docs-relevant files changed
let docsTouched: boolean = false;                // whether docs/engineering/ was touched
let reminderSnoozed: boolean = false;

// Check if a file path is docs-relevant (not ignored, not docs itself)
function isDocsRelevantPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Ignore patterns
	for (const pattern of IGNORE_PATTERNS) {
		if (pattern.test(normalized)) return false;
	}

	// Docs changes themselves are tracked separately
	if (normalized.includes(DOCS_DIR)) return false;

	// Everything else is docs-relevant
	return true;
}

// Check if a path is under docs/engineering/
function isDocsPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.includes(DOCS_DIR);
}

const ADHERENCE_EXTENSIONS = new Set([
	".css",
	".scss",
	".sass",
	".less",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".svelte",
	".astro",
	".html",
]);

function projectPath(cwd: string, filePath: string): string {
	return relative(resolve(cwd), resolve(resolve(cwd), filePath)).replace(/\\/g, "/");
}

function isAdvisoryPath(cwd: string, filePath: string, tokenFiles: readonly string[]): boolean {
	const normalized = projectPath(cwd, filePath);
	if (!normalized || normalized === ".") return false;
	if (normalized === "docs/design" || normalized.startsWith("docs/design/")) return false;
	if (IGNORE_PATTERNS.some(pattern => pattern.test(`/${normalized}`))) return false;
	const extension = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
	if (!ADHERENCE_EXTENSIONS.has(extension)) return false;
	return !tokenFiles.some(tokenFile => projectPath(cwd, tokenFile) === normalized);
}

function writtenText(toolName: string, input: { content?: unknown; edits?: unknown }): string {
	if (toolName === "write") return typeof input.content === "string" ? input.content : "";
	if (!Array.isArray(input.edits)) return "";
	return input.edits
		.filter((edit): edit is { newText: string } => !!edit && typeof edit === "object" && typeof (edit as { newText?: unknown }).newText === "string")
		.map(edit => edit.newText)
		.join("");
}

async function designAdvisory(cwd: string, filePath: string, text: string): Promise<string | undefined> {
	if (!text) return undefined;
	try {
		const index = await buildDesignTokenIndex(cwd);
		if (!index || !isAdvisoryPath(cwd, filePath, index.tokenFiles)) return undefined;
		return formatDesignAdvisory(detectDesignAdherence(text, index));
	} catch {
		return undefined;
	}
}

// Reconstruct state from session entries
export function reconstructTrackingState(ctx: ExtensionContext): void {
	changedFiles.clear();
	docsTouched = false;
	reminderSnoozed = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		const e = entry as { customType?: string; data?: unknown };

		if (e.customType === "engineering-docs:changed-file") {
			const data = e.data as { path?: string };
			if (data?.path) changedFiles.add(data.path);
		}

		if (e.customType === "engineering-docs:docs-touched") {
			docsTouched = true;
		}

		if (e.customType === ENTRY_DOCS_REMINDER_SNOOZE) {
			reminderSnoozed = true;
		}
	}
}

// Register tool_result hook
export function registerTrackingHooks(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// Track successful write/edit results
		const toolName = event.toolName;
		if (toolName !== "write" && toolName !== "edit") return;

		const input = event.input as { path?: unknown; content?: unknown; edits?: unknown };
		const rawPath = String(input?.path ?? "");
		if (!rawPath) return;

		const normalized = rawPath.replace(/\\/g, "/");

		if (isDocsRelevantPath(normalized)) {
			changedFiles.add(normalized);
			await Promise.resolve(pi.appendEntry("engineering-docs:changed-file", { path: normalized, at: Date.now() }));
		}

		if (isDocsPath(normalized)) {
			docsTouched = true;
			await Promise.resolve(pi.appendEntry("engineering-docs:docs-touched", { at: Date.now() }));
		}

		const advisory = await designAdvisory(ctx.cwd, normalized, writtenText(toolName, input));
		if (!advisory) return;
		return { content: [...event.content, { type: "text", text: advisory }] };
	});
}

// Check if reminder should fire
export function shouldShowReminder(): boolean {
	// Only in Build/Off mode
	if (!isWriteAllowed()) return false;

	// Already snoozed
	if (reminderSnoozed) return false;

	// No docs-relevant changes
	if (changedFiles.size === 0) return false;

	// Docs already touched
	if (docsTouched) return false;

	return true;
}

// Get summary of changed files for reminder
export function getChangedFilesSummary(): string[] {
	return [...changedFiles].slice(0, 10);
}

// Snooze reminder for this session
export async function snoozeReminder(pi: ExtensionAPI): Promise<void> {
	reminderSnoozed = true;
	await Promise.resolve(pi.appendEntry(ENTRY_DOCS_REMINDER_SNOOZE, { at: Date.now() }));
}

// Reset docs touched (e.g., after init)
export function resetTracking(): void {
	changedFiles.clear();
	docsTouched = false;
}