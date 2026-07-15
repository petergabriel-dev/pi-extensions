import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Key, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DOCS_DIR,
	ENTRY_DOCS_STATE,
	DOCS_AREA_TAGS,
} from "./constants.js";
import { getMode, isWriteAllowed, getModeLabel, registerModeListeners } from "./mode.js";
import { initDocs, checkDocs, updateDecisionIndex, enhancedCheckDocs, validateAllADRs, formatPlanDocsTagValidation, manifestExists, type SpokeCheckResult } from "./filesystem.js";
import { registerTrackingHooks, reconstructTrackingState, shouldShowReminder, getChangedFilesSummary, snoozeReminder } from "./tracking.js";
import { handlePatch } from "./patch.js";

// ── State ──


// ── Docs context injection ──

function docsContextGuidance(manifestExists: boolean): string {
	if (manifestExists) {
		return [
			`Engineering docs: ${DOCS_DIR}/manifest.json.`,
			`Entrypoint: ${DOCS_DIR}/README.md.`,
			`Read targeted docs when project context needed.`,
			`Do not treat root docs/ as canonical unless manifest says so.`,
			`Docs writes only allowed in Build/Off mode.`,
			`If project truth changes, consider adding [DOCS:*] tasks.`,
		].join(" ");
	}
	return `Engineering docs not initialized. Use /docs init to set up managed docs.`;
}

// ── UI helpers ──

function statusColor(theme: any, status: string): string {
	switch (status) {
		case "managed": return theme.fg("success", status);
		case "unmanaged-partial": return theme.fg("warning", status);
		case "missing": return theme.fg("error", status);
		default: return theme.fg("muted", status);
	}
}

function spokeHealthLabel(spokes: SpokeCheckResult[]): string {
	const broken = spokes.filter((spoke) => !spoke.healthy).length;
	return broken === 0 ? `OK (${spokes.length})` : `${broken}/${spokes.length} issue(s)`;
}

function spokeIssueSummary(spoke: SpokeCheckResult): string {
	return [
		!spoke.exists ? "missing" : "",
		!spoke.hasBlock ? "missing block" : "",
		spoke.hasBlock && !spoke.bodyMatches ? "stale/broken block" : "",
		spoke.deadLinks.length > 0 ? `dead links: ${spoke.deadLinks.join(", ")}` : "",
	].filter(Boolean).join("; ") || "OK";
}

// ── Dashboard ──

async function docsDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		// Non-interactive: print status
		const cwd = ctx.cwd;
		const check = await checkDocs(cwd);
		ctx.ui.notify(`Docs: ${check.status}. Manifest: ${check.manifest ? "present" : "missing"}. Missing: ${check.missingDocs.length}. ADRs: ${check.adrFiles.length}. Spokes: ${spokeHealthLabel(check.spokes)}.`, "info");
		return;
	}

	const cwd = ctx.cwd;
	const check = await checkDocs(cwd);
	const writeOk = isWriteAllowed();
	const modeLabel = getModeLabel();

	// Build menu items
	const items: SelectItem[] = [];

	// Status section
	items.push({ value: "__status__", label: `Status: ${check.status}`, description: writeOk ? "Writes allowed" : "Read-only mode" });
	items.push({ value: "__mode__", label: `Workflow: ${modeLabel}`, description: writeOk ? "Build/Off — write actions enabled" : (getModeLabel() === "Unknown" ? "Unknown mode — writes disabled" : "Discuss/Plan — write actions disabled") });
	items.push({ value: "__spokes__", label: `Spokes: ${spokeHealthLabel(check.spokes)}`, description: check.spokes.map((spoke) => `${spoke.path}: ${spokeIssueSummary(spoke)}`).join(" • ") });

	if (check.adrFiles.length > 0) {
		items.push({ value: "__adrs__", label: `ADRs: ${check.adrFiles.length}`, description: check.staleIndex ? "Index stale — needs update" : "Index up to date" });
	}

	items.push({ value: "__sep__", label: "────────", description: "" });

	// Actions
	if (check.status === "missing") {
		items.push({ value: "init", label: "Init engineering docs", description: "Create skeleton docs" });
	}

	if (check.status === "managed" || check.status === "unmanaged-partial") {
		items.push({ value: "check", label: "Check docs", description: "Validate manifest and index" });
		items.push({ value: "status", label: "View status", description: "Show detailed status" });
	}

	if (check.adrFiles.length > 0 || (check.status === "managed")) {
		items.push({ value: "update-index", label: "Update decision index", description: writeOk ? "Regenerate decisions README" : "Read-only — switch to Build/Off" });
	}

	items.push({ value: "validate-tags", label: "Validate docs tags", description: "Check [DOCS:*] and [ADR:*] tags in plan" });

	if (shouldShowReminder() || getChangedFilesSummary().length > 0) {
		items.push({ value: "patch", label: "Docs patch", description: "Suggest docs updates based on recent changes" });
	}

	if (!writeOk) {
		items.push({ value: "__readonly__", label: "⚠ Write actions disabled", description: `Switch /mode build or /mode off to enable` });
	}

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Engineering Docs")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Mode: ${modeLabel} • Docs: ${statusColor(theme, check.status)} • Spokes: ${spokeHealthLabel(check.spokes)}`), 1, 0));
		container.addChild(new Text("", 0, 0));

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
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { width: "60%", minWidth: 42, maxHeight: "70%", margin: 2, anchor: "center" } });

	if (!choice || choice === "__status__" || choice === "__mode__" || choice === "__spokes__" || choice === "__adrs__" || choice === "__sep__" || choice === "__readonly__") return;

	if (choice === "init") {
		await handleInit(pi, ctx);
	} else if (choice === "check") {
		await handleCheck(ctx);
	} else if (choice === "status") {
		await handleStatus(ctx);
	} else if (choice === "update-index") {
		await handleUpdateIndex(ctx);
	} else if (choice === "validate-tags") {
		await handleValidateTags(ctx);
	} else if (choice === "patch") {
		await handlePatch(pi, ctx);
	}
}

// ── Command handlers ──

async function handleInit(pi: ExtensionAPI, ctx: ExtensionCommandContext, flags: { yes?: boolean; check?: boolean } = {}): Promise<void> {
	const writeOk = isWriteAllowed();

	// --check: validation only, no writes
	if (flags.check) {
		const check = await enhancedCheckDocs(ctx.cwd);
		const brokenSpokes = check.spokes.filter((spoke) => !spoke.healthy);
		const lines: string[] = [
			`Status: ${check.status}`,
			`Manifest: ${check.manifest ? "present" : "missing"}`,
			`Missing docs: ${check.missingDocs.length > 0 ? check.missingDocs.join(", ") : "none"}`,
			`ADR files: ${check.adrFiles.length}`,
			`Decision index: ${check.staleIndex ? "STALE" : "up to date"}`,
			`Spokes: ${brokenSpokes.length === 0 ? "OK" : `${brokenSpokes.length} issue(s)`}`,
		];

		if (brokenSpokes.length > 0) {
			lines.push("", "Spoke issues:");
			for (const spoke of brokenSpokes) {
				lines.push(`  ${spoke.path}: ${[
					!spoke.exists ? "missing" : "",
					!spoke.hasBlock ? "missing block" : "",
					spoke.hasBlock && !spoke.bodyMatches ? "stale/broken block" : "",
					spoke.deadLinks.length > 0 ? `dead links: ${spoke.deadLinks.join(", ")}` : "",
				].filter(Boolean).join("; ")}`);
			}
		}

		const adrErrors = check.adrValidations.filter(v => !v.valid);
		if (adrErrors.length > 0) {
			lines.push("", `ADR validation issues: ${adrErrors.length}`);
			for (const v of adrErrors) {
				lines.push(`  ${v.filename}: ${v.errors.join(", ")}`);
			}
		}

		const tagErrors = check.tagValidations.filter(v => !v.valid);
		if (tagErrors.length > 0) {
			lines.push("", `Tag issues: ${tagErrors.length}`);
			for (const v of tagErrors) {
				lines.push(`  ${v.tag}: ${v.error}`);
			}
		}

		const hasErrors = check.status !== "managed" || brokenSpokes.length > 0 || adrErrors.length > 0 || tagErrors.length > 0 || check.staleIndex;
		if (hasErrors) {
			ctx.ui.notify(`Docs check FAILED:\n${lines.join("\n")}`, "warning");
		} else {
			ctx.ui.notify(`Docs check OK:\n${lines.join("\n")}`, "success");
		}
		return;
	}

	if (!writeOk) {
		ctx.ui.notify(`Cannot init docs in ${getModeLabel()} mode. Switch to /mode build or /mode off.`, "warning");
		return;
	}

	// Interactive: ask before creating if not --yes
	if (!flags.yes && ctx.hasUI) {
		const check = await checkDocs(ctx.cwd);
		if (check.status === "managed") {
			ctx.ui.notify("Engineering docs already initialized and managed.", "info");
			return;
		}
		if (check.status === "unmanaged-partial") {
			const ok = await ctx.ui.confirm(
				"Unmanaged docs found",
				"Existing docs/engineering/ files detected without manifest. Init will create missing files and manifest. Continue?"
			);
			if (!ok) return;
		}
	}

	const result = await initDocs(ctx.cwd);

	if (result.created.length > 0) {
		ctx.ui.notify(`Created: ${result.created.join(", ")}`, "success");
	}
	if (result.skipped.length > 0) {
		ctx.ui.notify(`Skipped (already exist): ${result.skipped.join(", ")}`, "info");
	}

	// Store state
	await Promise.resolve(pi.appendEntry(ENTRY_DOCS_STATE, { action: "init", at: Date.now() }));
}

async function handleCheck(ctx: ExtensionCommandContext, flags: { check?: boolean } = {}): Promise<void> {
	const repairSpokes = isWriteAllowed() && !flags.check;
	const check = await enhancedCheckDocs(ctx.cwd, undefined, { repairSpokes });
	const brokenSpokes = check.spokes.filter((spoke) => !spoke.healthy);
	const lines: string[] = [
		`Status: ${check.status}`,
		`Manifest: ${check.manifest ? "present" : "missing"}`,
		`Missing docs: ${check.missingDocs.length > 0 ? check.missingDocs.join(", ") : "none"}`,
		`Existing docs: ${check.existingDocs.length}`,
		`ADR files: ${check.adrFiles.length}`,
		`Decision index: ${check.staleIndex ? "STALE — run update-index" : "up to date"}`,
		`Spokes: ${brokenSpokes.length === 0 ? "OK" : `${brokenSpokes.length} issue(s)`}`,
	];

	if (check.spokesRepaired.length > 0) {
		lines.push(`Spokes repaired: ${check.spokesRepaired.join(", ")}`);
	}

	if (brokenSpokes.length > 0) {
		lines.push("");
		lines.push("Spoke issues:");
		for (const spoke of brokenSpokes) {
			const issues = [
				!spoke.exists ? "missing" : "",
				!spoke.hasBlock ? "missing block" : "",
				spoke.hasBlock && !spoke.bodyMatches ? "stale/broken block" : "",
				spoke.deadLinks.length > 0 ? `dead links: ${spoke.deadLinks.join(", ")}` : "",
			].filter(Boolean).join("; ");
			lines.push(`  ${spoke.path}: ${issues}`);
		}
		if (!repairSpokes && isWriteAllowed()) lines.push("  Run /docs check to repair missing/stale blocks.");
		else if (!isWriteAllowed()) lines.push(`  Repair disabled in ${getModeLabel()} mode.`);
	}

	if (check.adrValidations.length > 0) {
		const adrErrors = check.adrValidations.filter(v => !v.valid);
		if (adrErrors.length > 0) {
			lines.push("");
			lines.push(`ADR issues: ${adrErrors.length}`);
			for (const v of adrErrors) {
				lines.push(`  ${v.filename}: ${v.errors.join(", ")}`);
			}
		}
	}

	if (check.tagValidations.length > 0) {
		const invalidTags = check.tagValidations.filter(v => !v.valid);
		if (invalidTags.length > 0) {
			lines.push("");
			lines.push(`Tag issues: ${invalidTags.length}`);
			for (const v of invalidTags) {
				lines.push(`  ${v.tag}: ${v.error}`);
			}
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const check = await checkDocs(ctx.cwd);
	const mode = getMode();
	const modeLabel = getModeLabel();

	if (!ctx.hasUI) {
		ctx.ui.notify(`Docs: ${check.status} | Mode: ${modeLabel} | ADRs: ${check.adrFiles.length}`, "info");
		return;
	}

	const lines = [
		`**Status:** ${check.status}`,
		`**Manifest:** ${check.manifest ? "present" : "missing"}`,
		`**Workflow mode:** ${modeLabel} (${isWriteAllowed() ? "writes allowed" : "read-only"})`,
		`**ADRs:** ${check.adrFiles.length} file(s)`,
		`**Index:** ${check.staleIndex ? "stale" : "up to date"}`,
		`**Spokes:** ${spokeHealthLabel(check.spokes)}`,
		...check.spokes.map((spoke) => `  ${spoke.path}: ${spokeIssueSummary(spoke)}`),
		`**Missing:** ${check.missingDocs.length > 0 ? check.missingDocs.join(", ") : "none"}`,
	];

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Docs Status")), 1, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("text", line), 1, 0));
		}
		container.addChild(new Text(theme.fg("dim", "Press esc/enter to close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
				else tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "60%", minWidth: 42, maxHeight: "70%", margin: 2, anchor: "center" } });
}

async function handleUpdateIndex(ctx: ExtensionCommandContext): Promise<void> {
	if (!isWriteAllowed()) {
		ctx.ui.notify(`Cannot update index in ${getModeLabel()} mode. Switch to /mode build or /mode off.`, "warning");
		return;
	}

	try {
		await updateDecisionIndex(ctx.cwd);
		ctx.ui.notify("Decision index updated.", "success");
	} catch (err) {
		ctx.ui.notify(`Failed to update index: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function handleValidateTags(ctx: ExtensionCommandContext): Promise<void> {
	const adrValidations = await validateAllADRs(ctx.cwd);
	const check = await checkDocs(ctx.cwd);
	const lines: string[] = ["Docs tag validation:"];

	// ADR metadata validation
	if (adrValidations.length === 0) {
		lines.push("  No ADR files found to validate.");
	} else {
		const valid = adrValidations.filter(v => v.valid);
		const invalid = adrValidations.filter(v => !v.valid);
		lines.push(`  ADR files: ${adrValidations.length} (${valid.length} valid, ${invalid.length} invalid)`);
		for (const v of invalid) {
			lines.push(`  ${v.filename}: ${v.errors.join(", ")}`);
		}
	}

	// Docs tag rules
	lines.push("");
	lines.push("Valid docs area tags:");
	for (const area of DOCS_AREA_TAGS) {
		lines.push(`  [DOCS:${area}]`);
	}
	lines.push("");
	lines.push("ADR action tags (required with [DOCS:decisions]):");
	lines.push("  [ADR:new]");
	lines.push("  [ADR:update]");
	lines.push("  [ADR:supersede]");
	lines.push("");
	lines.push("Common issues:");
	lines.push("  [DOCS] without area -> use [DOCS:architecture] etc.");
	lines.push("  [DOCS:decisions] without [ADR:*] -> add [ADR:new|update|supersede]");
	lines.push("");
	lines.push("Use docs_validate_tags tool to validate tags in plan text.");

	ctx.ui.notify(lines.join("\n"), "info");
}

// ── Main extension ──

export default function (pi: ExtensionAPI) {
	// Register workflow mode listeners
	registerModeListeners(pi);

	// Inject tiny docs guidance into agent context
	pi.on("before_agent_start", async (event, ctx) => {
		let hasManifest = false;
		try {
			hasManifest = await manifestExists(ctx.cwd);
		} catch {
			// If we can't check, just skip context injection
		}
		const guidance = docsContextGuidance(hasManifest);
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	// Block docs write tools in Discuss/Plan mode
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = String((event.input as { path?: unknown })?.path ?? "");
		// Only block writes to docs/engineering/
		if (!path.includes(DOCS_DIR)) return;
		if (isWriteAllowed()) return;
		return {
			block: true,
			reason: `Write to ${DOCS_DIR} is blocked in ${getModeLabel()} mode. Use /mode build or /mode off to enable docs writes.`,
		};
	});

	// ── /docs command ──

	pi.registerCommand("docs", {
		description: "Engineering docs dashboard: init, check, status, index",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				await docsDashboard(pi, ctx);
				return;
			}

			if (arg === "init" || arg.startsWith("init ")) {
				const initFlags = { yes: arg.includes("--yes") || arg.includes("-y"), check: arg.includes("--check") || arg.includes("-c") };
				await handleInit(pi, ctx, initFlags);
			} else if (arg === "check" || arg === "-c" || arg.startsWith("check ")) {
				const checkFlags = { check: arg.includes("--check") || arg.includes("-c") };
				await handleCheck(ctx, checkFlags);
			} else if (arg === "status" || arg === "-s") {
				await handleStatus(ctx);
			} else if (arg === "validate-tags" || arg === "validate") {
				await handleValidateTags(ctx);
			} else if (arg === "patch") {
				await handlePatch(pi, ctx);
			} else if (arg === "update-index" || arg.startsWith("update-decision-index")) {
				await handleUpdateIndex(ctx);
			} else {
				ctx.ui.notify(`Unknown docs command: ${arg}. Use: init, check, status, update-index, validate-tags, patch`, "warning");
			}
		},
	});

	// ── Docs tag validation tool ──

	pi.registerTool({
		name: "docs_validate_tags",
		label: "Validate docs tags",
		description: "Validate [DOCS:*] and [ADR:*] tags in plan text. Warns about bare [DOCS] tags, missing area tags, and [DOCS:decisions] without [ADR:*].",
		promptSnippet: "Validate docs task tags in plan text",
		promptGuidelines: [
			"Use docs_validate_tags when checking a plan for valid [DOCS:*] and [ADR:*] tags.",
			"Tag format: [DOCS:architecture], [DOCS:dev-workflow], [DOCS:conventions], [DOCS:invariants], [DOCS:traps], [DOCS:decisions].",
			"[DOCS:decisions] must be accompanied by [ADR:new], [ADR:update], or [ADR:supersede].",
		],
		parameters: Type.Object({
			planText: Type.String({ description: "The plan text containing [DOCS:*] and [ADR:*] tags to validate" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text", text: formatPlanDocsTagValidation(params.planText) }] };
		},
	});

	// ── Change tracking and reminder ──

	registerTrackingHooks(pi);

	pi.on("session_start", async (_event, ctx) => {
		reconstructTrackingState(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructTrackingState(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!shouldShowReminder()) return;
		if (!ctx.hasUI) return;

		const changedFiles = getChangedFilesSummary();
		const fileCount = changedFiles.length;
		const fileList = changedFiles.length <= 5
			? changedFiles.join(", ")
			: changedFiles.slice(0, 5).join(", ") + `, +${fileCount - 5} more`;

		const ok = await ctx.ui.confirm(
			"Docs update suggested",
			`${fileCount} relevant file(s) changed but docs/engineering/ was not touched:\n${fileList}\n\nUpdate docs?`
		);

		if (ok) {
			ctx.ui.notify("Use /docs patch to generate a docs update, or add [DOCS:*] tasks to your plan.", "info");
		} else {
			await snoozeReminder(pi);
			ctx.ui.notify("Docs reminder snoozed for this session.", "info");
		}
	});
}