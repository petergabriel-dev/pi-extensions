import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, ScrollView, SelectList, Text, matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";
import {
	applyPlan,
	classifyPackageRoot,
	inspectHarness,
	planInstall,
	planUninstall,
	readStamp,
	resolveHarnessRoots,
} from "./setup.ts";
import type { ApplyResult, HarnessSetupStamp, SetupInspection, SetupPlan } from "./setup.ts";
import type { Harness } from "./manifest.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HARNESSES: Harness[] = ["claude", "cursor", "opencode"];
const HARNESS_NAMES: Record<Harness, string> = { claude: "Claude", cursor: "Cursor", opencode: "OpenCode" };
const STARTUP_WARNING = "Harness setup needs repair";
const CLAUDE_PLATFORM_WARNING = "Claude Bash sandbox behavior is platform-dependent; verify fail-closed behavior on this non-macOS host.";
const CURSOR_REMOVAL_WARNING = "Cursor failClosed hooks can block tools globally after package removal. Run `/harness uninstall cursor` before `pi remove`.";
const CLI_TIMEOUT_MS = 10_000;
const APPLY_INSTRUCTION = "Open /harness in the interactive TUI to apply.";

function statusLabel(inspection: SetupInspection): string {
	if (inspection.state === "ok") return "ok";
	if (inspection.state === "needs-fix") return "needs fix";
	return "not installed";
}

function statusGlyph(inspection: SetupInspection): string {
	if (inspection.state === "ok") return "✓";
	if (inspection.state === "needs-fix") return "!";
	return "–";
}

function shorten(value: string, max = 110): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function problemSummary(inspection: SetupInspection): string {
	const first = inspection.problems[0];
	if (!first) return inspection.state === "not-installed" ? "No harness-owned setup detected." : "All checks passed.";
	const extra = inspection.problems.length > 1 ? ` (+${inspection.problems.length - 1} more)` : "";
	return shorten(`${first.message}${extra}`);
}

function inspectionFailure(harness: Harness): SetupInspection {
	return {
		state: "needs-fix",
		problems: [{ harness, kind: "unreadable", severity: "error", message: "Could not inspect harness files." }],
	};
}

async function inspectAll(agentDir: string, roots: ReturnType<typeof resolveHarnessRoots>): Promise<Record<Harness, SetupInspection>> {
	const stamp = await readStamp(agentDir).catch(() => undefined);
	const results = await Promise.all(HARNESSES.map(async (harness) => {
		try {
			return [harness, await inspectHarness(harness, { pkgRoot: PACKAGE_ROOT, roots, stamp })] as const;
		} catch {
			return [harness, inspectionFailure(harness)] as const;
		}
	}));
	return Object.fromEntries(results) as Record<Harness, SetupInspection>;
}

function execFixed(executable: string, args: string[]): Promise<{ kind: "ok" } | { kind: "missing" } | { kind: "failed"; reason: string }> {
	return new Promise((resolveResult) => {
		try {
			execFile(executable, args, {
				timeout: CLI_TIMEOUT_MS,
				shell: false,
				windowsHide: true,
				maxBuffer: 64 * 1024,
			}, (error) => {
				if (!error) {
					resolveResult({ kind: "ok" });
					return;
				}
				const commandError = error as NodeJS.ErrnoException & { killed?: boolean };
				if (commandError.code === "ENOENT") {
					resolveResult({ kind: "missing" });
					return;
				}
				if (commandError.code === "ETIMEDOUT" || commandError.killed) {
					resolveResult({ kind: "failed", reason: "timed out after 10 seconds" });
					return;
				}
				if (typeof commandError.code === "number") {
					resolveResult({ kind: "failed", reason: `exit code ${commandError.code}` });
					return;
				}
				resolveResult({ kind: "failed", reason: "command error" });
			});
		} catch {
			resolveResult({ kind: "failed", reason: "command error" });
		}
	});
}

function execDescription(result: Awaited<ReturnType<typeof execFixed>>, subject: string): string {
	if (result.kind === "ok") return `${subject}: succeeded.`;
	if (result.kind === "missing") return `${subject}: skipped; Claude CLI not found (ENOENT).`;
	return `${subject}: failed (${result.reason}).`;
}

async function checkClaudeMcp(): Promise<string> {
	const result = await execFixed("claude", ["mcp", "get", "-s", "user", "pi-claude-bridge"]);
	if (result.kind === "ok") return "Claude MCP registration: registered.";
	if (result.kind === "missing") return "Claude MCP registration: unknown; Claude CLI not found (ENOENT).";
	return `Claude MCP registration: query failed (${result.reason}); state unknown.`;
}

async function runCliSteps(plan: SetupPlan): Promise<string[]> {
	const outcomes: string[] = [];
	for (const [index, step] of plan.cliSteps.entries()) {
		const result = await execFixed(step.executable, step.args);
		outcomes.push(execDescription(result, `Claude CLI step ${index + 1}`));
	}
	return outcomes;
}

async function selectHarness(ctx: ExtensionCommandContext, inspections: Record<Harness, SetupInspection>, rootWarning?: string): Promise<Harness | null> {
	const items: SelectItem[] = HARNESSES.map((harness) => {
		const inspection = inspections[harness];
		return {
			value: harness,
			label: `${statusGlyph(inspection)} ${HARNESS_NAMES[harness]} · ${statusLabel(inspection)}`,
			description: problemSummary(inspection),
		};
	});
	return ctx.ui.custom<Harness | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Harness setup")), 1, 0));
		if (rootWarning) container.addChild(new Text(theme.fg("warning", rootWarning), 1, 0));
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value as Harness);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });
}

function detailMarkdown(harness: Harness, inspection: SetupInspection, rootWarning?: string, cliCheck?: string): string {
	const lines = [`**${HARNESS_NAMES[harness]}: ${statusLabel(inspection)}**`, ""];
	if (inspection.problems.length) {
		for (const problem of inspection.problems) lines.push(`- ${problem.severity === "warning" ? "Warning" : "Problem"}: ${problem.message}`);
	} else {
		lines.push("No problems detected.");
	}
	if (rootWarning) lines.push(`- Warning: ${rootWarning}`);
	if (harness === "claude" && process.platform !== "darwin" && !inspection.problems.some((problem) => problem.message === CLAUDE_PLATFORM_WARNING)) {
		lines.push(`- Warning: ${CLAUDE_PLATFORM_WARNING}`);
	}
	if (cliCheck) lines.push(`- ${cliCheck}`);
	return lines.join("\n");
}

async function selectAction(ctx: ExtensionCommandContext, harness: Harness, inspection: SetupInspection, rootWarning?: string, cliCheck?: Promise<string>): Promise<"install" | "uninstall" | "back"> {
	let cliStatus = cliCheck ? "Claude MCP registration check running…" : undefined;
	let refresh: (() => void) | undefined;
	let active = true;
	const items: SelectItem[] = [
		{ value: "install", label: "Install / repair", description: `Apply owned ${HARNESS_NAMES[harness]} setup` },
		{ value: "uninstall", label: "Uninstall", description: `Remove owned ${HARNESS_NAMES[harness]} setup` },
		{ value: "back", label: "Back", description: "Return to harness list" },
	];
	const selection = ctx.ui.custom<"install" | "uninstall" | "back">((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`${HARNESS_NAMES[harness]} setup`)), 1, 0));
		const details = new Markdown(detailMarkdown(harness, inspection, rootWarning, cliStatus), 1, 0, getMarkdownTheme());
		container.addChild(details);
		refresh = () => {
			details.setText(detailMarkdown(harness, inspection, rootWarning, cliStatus));
			tui.requestRender();
		};
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value as "install" | "uninstall" | "back");
		list.onCancel = () => done("back");
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc back"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });
	if (cliCheck) {
		void cliCheck.then((status) => {
			if (!active) return;
			cliStatus = status;
			refresh?.();
		}, () => {
			if (!active) return;
			cliStatus = "Claude MCP registration: query failed; state unknown.";
			refresh?.();
		});
	}
	const action = await selection;
	active = false;
	return action;
}

function diffFence(patch: string): string {
	let fence = "```";
	while (patch.includes(fence)) fence += "`";
	return `${fence}diff\n${patch}\n${fence}`;
}

function planPreview(harness: Harness, action: "install" | "uninstall", plan: SetupPlan, inspection: SetupInspection, rootWarning?: string): string {
	const lines = [`# ${action === "install" ? "Install / repair" : "Uninstall"} ${HARNESS_NAMES[harness]}`, ""];
	const warnings = inspection.problems.filter((problem) => problem.severity === "warning").map((problem) => problem.message);
	if (harness === "claude" && process.platform !== "darwin") warnings.push(CLAUDE_PLATFORM_WARNING);
	if (rootWarning) warnings.push(rootWarning);
	if (harness === "cursor") warnings.push(CURSOR_REMOVAL_WARNING);
	const uniqueWarnings = [...new Set(warnings)];
	if (uniqueWarnings.length) {
		lines.push("## Warnings", ...uniqueWarnings.map((warning) => `- ${warning}`), "");
	}
	if (!plan.changes.length) lines.push("No file changes planned.", "");
	for (const change of plan.changes) {
		const patch = createTwoFilesPatch(change.path, change.path, change.before ?? "", change.after ?? "", "", "", { context: 3 });
		lines.push(`## ${change.path}`, "", diffFence(patch), "");
	}
	if (plan.skipped.length) {
		lines.push("## Skipped", ...plan.skipped.map(({ path, reason }) => `- ${path}: ${reason}`), "");
	}
	lines.push("## Claude MCP CLI actions");
	if (plan.cliSteps.length) {
		for (const step of plan.cliSteps) {
			const verb = step.args[1] === "add" ? "Register" : "Remove";
			lines.push(`- ${verb} user-scoped pi-claude-bridge.`);
		}
	} else lines.push("- None.");
	return lines.join("\n");
}

async function showPreview(ctx: ExtensionCommandContext, content: string): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const scroll = new ScrollView(new Markdown(content, 1, 0, getMarkdownTheme()), { scrollbar: "auto", overscroll: "contain" });
		container.addChild(scroll);
		container.addChild(new Text(theme.fg("dim", "↑↓ scroll • enter continue • esc back"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, Key.enter)) done(true);
				else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done(false);
				else if (matchesKey(data, Key.up)) scroll.scrollBy(-1);
				else if (matchesKey(data, Key.down)) scroll.scrollBy(1);
				else if (matchesKey(data, Key.pageUp)) scroll.scrollBy(-8);
				else if (matchesKey(data, Key.pageDown)) scroll.scrollBy(8);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "90%", minWidth: 50, maxHeight: "80%", margin: 2 } });
}

async function showOutcomes(ctx: ExtensionCommandContext, fileResults: ApplyResult[], cliResults: string[]): Promise<void> {
	const lines = ["# Harness setup results", "", "## Files"];
	if (fileResults.length) {
		for (const result of fileResults) lines.push(`- ${result.applied ? "Applied" : "Not applied"}: ${result.path}${result.reason ? ` — ${result.reason}` : ""}`);
	} else lines.push("- No file changes planned.");
	lines.push("", "## Claude CLI");
	if (cliResults.length) lines.push(...cliResults.map((result) => `- ${result}`));
	else lines.push("- No Claude CLI steps planned.");
	await showPreview(ctx, lines.join("\n"));
}

async function handleInteractive(ctx: ExtensionCommandContext, agentDir: string, roots: ReturnType<typeof resolveHarnessRoots>, rootWarning?: string): Promise<void> {
	let inspections = await inspectAll(agentDir, roots);
	while (true) {
		const selected = await selectHarness(ctx, inspections, rootWarning);
		if (!selected) return;
		const inspection = await inspectHarness(selected, { pkgRoot: PACKAGE_ROOT, roots, stamp: await readStamp(agentDir).catch(() => undefined) }).catch(() => inspectionFailure(selected));
		const cliCheck = selected === "claude"
			? checkClaudeMcp().catch(() => "Claude MCP registration: query failed; state unknown.")
			: undefined;
		while (true) {
			const action = await selectAction(ctx, selected, inspection, rootWarning, cliCheck);
			if (action === "back") break;

			const classification = await classifyPackageRoot(PACKAGE_ROOT, agentDir);
			if (classification.state === "refused") {
				ctx.ui.notify(`Harness setup refused: package root is unsafe or unsupported. ${classification.hint ?? "Reinstall package through Pi."}`, "warning");
				return;
			}
			const currentRootWarning = classification.state === "dev-checkout" ? classification.warning : undefined;
			if (currentRootWarning && !rootWarning) ctx.ui.notify(currentRootWarning, "warning");
			let plan: SetupPlan;
			try {
				const options = { pkgRoot: PACKAGE_ROOT, roots, agentDir };
				plan = action === "install" ? await planInstall(selected, options) : await planUninstall(selected, options);
			} catch {
				ctx.ui.notify("Could not prepare harness setup plan; no changes applied.", "error");
				continue;
			}
			const continueToConfirm = await showPreview(ctx, planPreview(selected, action, plan, inspection, currentRootWarning ?? rootWarning));
			if (!continueToConfirm) continue;
			const confirmed = await ctx.ui.confirm(
				`${action === "install" ? "Apply" : "Remove"} ${HARNESS_NAMES[selected]} setup?`,
				"Apply the planned file changes and any listed Claude CLI actions?",
			);
			if (!confirmed) continue;

			const fileResults = await applyPlan(plan);
			const cliResults = await runCliSteps(plan);
			await showOutcomes(ctx, fileResults, cliResults);
			inspections = await inspectAll(agentDir, roots);
			break;
		}
	}
}

export default function registerHarnessSetup(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	pi.registerCommand("harness", {
		description: "Inspect and manage Claude, Cursor, and OpenCode setup",
		handler: async (_args, ctx) => {
			const roots = resolveHarnessRoots(process.env, homedir());
			const classification = await classifyPackageRoot(PACKAGE_ROOT, agentDir);
			const rootWarning = classification.state === "dev-checkout" ? classification.warning : undefined;
			if (ctx.mode !== "tui") {
				const inspections = await inspectAll(agentDir, roots);
				for (const harness of HARNESSES) {
					const inspection = inspections[harness];
					console.log(`${HARNESS_NAMES[harness]}: ${statusGlyph(inspection)} ${statusLabel(inspection)} — ${problemSummary(inspection)}`);
				}
				if (classification.state === "refused") console.log(`Harness setup refused: package root is unsafe or unsupported. ${classification.hint ?? "Reinstall package through Pi."}`);
				else if (rootWarning) console.log(`Warning: ${rootWarning}`);
				console.log(APPLY_INSTRUCTION);
				return;
			}
			if (classification.state === "refused") {
				ctx.ui.notify(`Harness setup refused: package root is unsafe or unsupported. ${classification.hint ?? "Reinstall package through Pi."}`, "warning");
				return;
			}
			if (rootWarning) ctx.ui.notify(rootWarning, "warning");
			await handleInteractive(ctx, agentDir, roots, rootWarning);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const stamp: HarnessSetupStamp | undefined = await readStamp(agentDir);
			if (!stamp) return;
			const stamped = HARNESSES.filter((harness) => Object.hasOwn(stamp.harnesses, harness));
			if (!stamped.length) return;
			const roots = resolveHarnessRoots(process.env, homedir());
			const broken: Harness[] = [];
			for (const harness of stamped) {
				try {
					const inspection = await inspectHarness(harness, { pkgRoot: PACKAGE_ROOT, roots, stamp });
					if (inspection.problems.length > 0) broken.push(harness);
				} catch {
					// Startup health is advisory; never block session startup.
				}
			}
			if (broken.length) {
				ctx.ui.notify(`${STARTUP_WARNING} for ${broken.map((harness) => HARNESS_NAMES[harness]).join(", ")}; open /harness.`, "warning");
			}
		} catch {
			// Startup health is advisory; never block session startup.
		}
	});
}
