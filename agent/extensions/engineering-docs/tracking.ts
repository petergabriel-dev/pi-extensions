// Docs-relevant change tracking
// Tracks edit/write tool calls that changed docs-relevant files
// and reminds at agent_end if docs weren't touched.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	pi.on("tool_result", async (event) => {
		if (event.isError) return;

		// Track successful write/edit results
		const toolName = event.toolName;
		if (toolName !== "write" && toolName !== "edit") return;

		const input = event.input as { path?: unknown };
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