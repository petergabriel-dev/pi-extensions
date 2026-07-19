// Auto docs patch preview/apply flow
// Scans changed files, drafts evidence-backed patch suggestions,
// previews diff, and applies only after user confirmation in Build/Off mode.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DOCS_DIR, type DocsAreaTag } from "./constants.js";
import { isWriteAllowed, getModeLabel } from "./mode.js";
import { shouldShowReminder, getChangedFilesSummary } from "./tracking.js";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Key, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

// ── Patch suggestion ──

export interface PatchSuggestion {
	targetDocs: { area: DocsAreaTag; file: string; reason: string }[];
	changedFiles: string[];
	evidence: string;
}

// Map file path patterns to docs areas
const PATH_AREA_MAP: [RegExp, DocsAreaTag[]][] = [
	[/src\/.*(?:auth|login|session|token|password|credential)/i, ["architecture", "invariants", "traps"]],
	[/src\/.*(?:route|router|endpoint|api|controller)/i, ["architecture", "dev-workflow"]],
	[/src\/.*(?:model|schema|migration|database|db)/i, ["architecture", "dev-workflow"]],
	[/src\/.*(?:config|env|setting|constant)/i, ["dev-workflow", "conventions"]],
	[/src\/.*(?:test|spec|e2e|__tests__)/i, ["dev-workflow"]],
	[/package\.json|pyproject\.toml|Cargo\.toml|go\.mod/i, ["dev-workflow"]],
	[/docker|dockerfile|k8s|terraform|deploy/i, ["dev-workflow", "architecture"]],
	[/\.(?:env\.example|env\.local|env\.production)/i, ["dev-workflow", "traps"]],
	[/\.github\/workflows/i, ["dev-workflow"]],
	[/src\/.*(?:middleware|guard|permission|role|access)/i, ["architecture", "invariants"]],
	[/src\/.*(?:error|exception|handler|retry|fallback)/i, ["architecture", "traps"]],
	[/README\.md$/i, ["dev-workflow"]],
	[/\.env$/i, []], // Never suggest docs for .env files (secrets)
];

export function suggestPatches(changedFiles: string[], cwd: string): PatchSuggestion {
	const targetDocs: { area: DocsAreaTag; file: string; reason: string }[] = [];
	const seen = new Set<string>();

	for (const file of changedFiles) {
		for (const [pattern, areas] of PATH_AREA_MAP) {
			if (pattern.test(file)) {
				for (const area of areas) {
					const docFile = `${DOCS_DIR}/${area}.md`;
					const key = `${area}:${file}`;
					if (!seen.has(key)) {
						seen.add(key);
						targetDocs.push({
							area,
							file: docFile,
							reason: `${file} may affect ${area}`,
						});
					}
				}
			}
		}
	}

	// Deduplicate by doc file
	const uniqueDocs = new Map<string, { area: DocsAreaTag; file: string; reasons: string[] }>();
	for (const t of targetDocs) {
		if (uniqueDocs.has(t.file)) {
			uniqueDocs.get(t.file)!.reasons.push(t.reason);
		} else {
			uniqueDocs.set(t.file, { area: t.area, file: t.file, reasons: [t.reason] });
		}
	}

	const dedupedDocs = [...uniqueDocs.values()].map(d => ({
		area: d.area,
		file: d.file,
		reason: d.reasons.join("; "),
	}));

	const evidence = changedFiles.length <= 10
		? changedFiles.join("\n")
		: changedFiles.slice(0, 10).join("\n") + `\n...and ${changedFiles.length - 10} more`;

	return {
		targetDocs: dedupedDocs,
		changedFiles,
		evidence,
	};
}

// ── Patch content generation ──

// System prompt for generating docs patches
const DOCS_PATCH_SYSTEM_PROMPT = `You are a documentation update assistant. You receive:
1. A list of changed files
2. The current content of relevant docs files
3. A request to update specific docs sections

Your task:
- Update ONLY the specified docs files
- Base ALL claims on evidence from the changed files
- Mark any unsupported claims as <!-- TODO: verify -->
- Keep updates concise and factual
- Do NOT remove existing content unless it's clearly wrong
- Preserve the existing document structure and headings
- Use markdown format

Output the updated content for each file, wrapped in:
---FILE: path/to/file.md---
(content)
---END FILE---`;

// ── Patch preview modal ──

export async function showPatchPreview(
	ctx: ExtensionCommandContext,
	suggestion: PatchSuggestion,
): Promise<string | null> {
	if (!ctx.hasUI) {
		// Non-interactive: return suggestion summary
		return "patch-apply";
	}

	const docsLines = suggestion.targetDocs.map(d =>
		`  ${d.area}: ${d.reason}`
	);

	const items: SelectItem[] = [
		{ value: "generate", label: "Generate docs patch", description: "Ask agent to update docs based on changes" },
		{ value: "__sep__", label: "────────", description: "" },
		...suggestion.targetDocs.map(d => ({
			value: `doc:${d.area}`,
			label: `${d.area}.md`,
			description: d.reason,
		})),
	];

	if (suggestion.changedFiles.length > 0) {
		items.push({ value: "__sep2__", label: "────────", description: "" });
		items.push({ value: "__files__", label: `Changed files (${suggestion.changedFiles.length})`, description: suggestion.changedFiles.slice(0, 5).join(", ") });
	}

	items.push({ value: "__sep3__", label: "────────", description: "" });
	items.push({ value: "skip", label: "Skip", description: "Don't update docs now" });

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Docs Patch Suggestion")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `${suggestion.changedFiles.length} changed file(s), ${suggestion.targetDocs.length} doc(s) affected`), 1, 0));

		if (docsLines.length > 0) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("text", "Suggested updates:"), 1, 0));
			for (const line of docsLines.slice(0, 6)) {
				container.addChild(new Text(theme.fg("muted", line), 1, 0));
			}
			if (docsLines.length > 6) {
				container.addChild(new Text(theme.fg("dim", `...and ${docsLines.length - 6} more`), 1, 0));
			}
		}

		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { width: "60%", minWidth: 42, maxHeight: "70%", margin: 2, anchor: "center" } });

	return choice;
}

// ── Handle patch command ──

export async function handlePatch(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!isWriteAllowed()) {
		ctx.ui.notify(`Cannot apply docs patch in ${getModeLabel()} mode. Switch to /mode build or /mode off.`, "warning");
		return;
	}

	if (!shouldShowReminder() && getChangedFilesSummary().length === 0) {
		ctx.ui.notify("No docs-relevant changes detected.", "info");
		return;
	}

	const changedFiles = getChangedFilesSummary();
	if (changedFiles.length === 0) {
		ctx.ui.notify("No docs-relevant changes detected.", "info");
		return;
	}

	const suggestion = suggestPatches(changedFiles, ctx.cwd);

	if (suggestion.targetDocs.length === 0) {
		ctx.ui.notify(`Changed ${changedFiles.length} file(s) but no docs updates suggested.`, "info");
		return;
	}

	const choice = await showPatchPreview(ctx, suggestion);

	if (!choice || choice === "skip" || choice === "__files__" || choice.startsWith("__sep")) {
		ctx.ui.notify("Docs patch skipped.", "info");
		return;
	}

	if (choice === "generate") {
		// Send a message to the agent asking it to update docs
		const docFiles = suggestion.targetDocs.map(d => d.file).join(", ");
		const fileList = suggestion.changedFiles.slice(0, 10).join(", ");
		const prompt = `The following files changed: ${fileList}.\n\nPlease update the following engineering docs based on these changes:\n${suggestion.targetDocs.map(d => `- ${d.file}: ${d.reason}`).join("\n")}\n\nOnly update docs with verified facts from the changed files. Mark unsupported claims as TODO.`;

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify("Sent docs update request to agent.", "info");
		return;
	}

	// Individual doc selection
	if (choice.startsWith("doc:")) {
		const area = choice.slice(4) as DocsAreaTag;
		const docSuggestion = suggestion.targetDocs.find(d => d.area === area);
		if (!docSuggestion) {
			ctx.ui.notify(`No suggestion found for ${area}.`, "warning");
			return;
		}

		const prompt = `Please update ${docSuggestion.file} based on the following changes: ${suggestion.changedFiles.slice(0, 10).join(", ")}.\n\nReason: ${docSuggestion.reason}\n\nOnly update with verified facts. Mark unsupported claims as TODO.`;

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify(`Sent ${area}.md update request to agent.`, "info");
		return;
	}
}