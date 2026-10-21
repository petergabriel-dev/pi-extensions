import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURSOR_HOOK_FAIL_CLOSED, HARNESS_MANIFEST, MAX_CONFIG_BYTES, PI_BRIDGE_MCP_KEY, STATUSLINE_REFRESH_INTERVAL } from "../manifest.ts";
import { applyPlan, classifyPackageRoot, inspectHarness, planInstall, planUninstall, readStamp, removeStampHarness, resolveHarnessRoots, writeStamp } from "../setup.ts";
import type { Harness, ProblemKind, SetupProblem } from "../setup.ts";

async function main(): Promise<void> {
const temp = await mkdtemp(path.join(os.tmpdir(), "harness-setup-"));
const covered = new Set<string>();
const seenProblems = new Set<ProblemKind>();
const record = (name: string): void => covered.add(name);
const noted = (problems: SetupProblem[], kind: ProblemKind): void => {
	assert.ok(problems.some((problem) => problem.kind === kind), `expected problem ${kind}; got ${problems.map(({ kind: actual }) => actual).join(", ")}`);
	seenProblems.add(kind);
};
const writeJson = async (file: string, value: unknown): Promise<void> => {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};
const backupTimestamp = (iso: string): string => process.platform === "win32" ? iso.replaceAll(":", "-") : iso;
const setupRoot = async (root: string, harness: Harness, pkgRoot: string): Promise<void> => {
	const entries = HARNESS_MANIFEST[harness];
	for (const entry of entries) {
		if (entry.kind === "command" || entry.kind === "plugin") {
			const target = path.join(pkgRoot, entry.script);
			const destination = path.join(root, entry.dest);
			await mkdir(path.dirname(target), { recursive: true });
			await mkdir(path.dirname(destination), { recursive: true });
			await writeFile(target, "fixture asset\n");
			await symlink(target, destination);
		}
	}
};
const createPackage = async (root: string): Promise<string> => {
	const pkgRoot = path.join(root, "package");
	await mkdir(pkgRoot, { recursive: true });
	await writeJson(path.join(pkgRoot, "package.json"), { name: "fixture", version: "1.2.3" });
	for (const harness of ["claude", "cursor", "opencode"] as const) {
		for (const entry of HARNESS_MANIFEST[harness]) {
			const asset = path.join(pkgRoot, entry.script);
			await mkdir(path.dirname(asset), { recursive: true });
			await writeFile(asset, "fixture asset\n");
		}
	}
	return pkgRoot;
};
const makeRoots = (root: string) => ({
	claude: path.join(root, "claude"),
	claudeMcp: path.join(root, "claude-user.json"),
	cursor: path.join(root, "cursor"),
	opencode: path.join(root, "opencode"),
});
const command = (pkgRoot: string, relative: string): string => `node ${JSON.stringify(path.join(pkgRoot, relative))}`;
const preToolCommand = (pkgRoot: string, relative: string): string => `${command(pkgRoot, relative)} || exit 2`;
const installFixture = async (root: string, pkgRoot: string) => {
	const roots = makeRoots(root);
	await Promise.all([
		setupRoot(roots.claude, "claude", pkgRoot),
		setupRoot(roots.cursor, "cursor", pkgRoot),
		setupRoot(roots.opencode, "opencode", pkgRoot),
	]);
	await writeJson(path.join(roots.claude, "settings.json"), {
		hooks: {
			PreToolUse: [{ hooks: [{ type: "command", command: preToolCommand(pkgRoot, "agent/claude-bridge-client/pi-readonly-hook.js") }] }],
			UserPromptSubmit: [{ hooks: [{ type: "command", command: command(pkgRoot, "agent/claude-bridge-client/pi-peer-hook.js") }] }],
			SessionEnd: [{ hooks: [{ type: "command", command: command(pkgRoot, "agent/claude-bridge-client/pi-peer-hook.js") }] }],
		},
		statusLine: {
			type: "command",
			command: command(pkgRoot, "agent/claude-bridge-client/pi-statusline.js"),
			refreshInterval: 5,
		},
	});
	await writeJson(roots.claudeMcp, {
		mcpServers: {
			"pi-claude-bridge": { command: "node", args: [path.join(pkgRoot, "agent/claude-bridge-client/pi-bridge-mcp.js")] },
		},
	});
	await writeJson(path.join(roots.cursor, "hooks.json"), {
		hooks: Object.fromEntries(["beforeShellExecution", "beforeMCPExecution", "preToolUse"].map((event) => [
		event,
		[{ command: command(pkgRoot, "agent/cursor-bridge-client/cursor-readonly-hook.js"), failClosed: true }],
		])),
	});
	await writeJson(path.join(roots.cursor, "mcp.json"), {
		mcpServers: {
			"pi-claude-bridge": { command: "node", args: [path.join(pkgRoot, "agent/claude-bridge-client/pi-bridge-mcp.js")] },
		},
	});
	await writeJson(path.join(roots.opencode, "opencode.json"), {
		mcp: {
			"pi-claude-bridge": { type: "local", command: ["node", path.join(pkgRoot, "agent/claude-bridge-client/pi-bridge-mcp.js")], enabled: true },
		},
	});
	return roots;
};

try {
	for (const [harness, entries] of Object.entries(HARNESS_MANIFEST)) {
		assert.ok(entries.length > 0, `${harness} manifest is populated`);
		for (const entry of entries) {
			assert.ok(["hook", "statusline", "mcp", "command", "plugin"].includes(entry.kind));
			assert.ok(!path.posix.isAbsolute(entry.script) && !entry.script.startsWith("../"));
			assert.ok(entry.dest.length > 0 && entry.ownerExtension.length > 0);
			assert.deepEqual(Object.keys(entry).sort(), (entry.event ? ["dest", "event", "kind", "ownerExtension", "script"] : ["dest", "kind", "ownerExtension", "script"]).sort());
		}
	}
	assert.equal(STATUSLINE_REFRESH_INTERVAL, 5);
	assert.equal(CURSOR_HOOK_FAIL_CLOSED, true);
	assert.equal(PI_BRIDGE_MCP_KEY, "pi-claude-bridge");
	assert.deepEqual(HARNESS_MANIFEST.claude.filter(({ kind }) => kind === "hook").map(({ event, script }) => [event, path.posix.basename(script)]), [
		["PreToolUse", "pi-readonly-hook.js"],
		["UserPromptSubmit", "pi-peer-hook.js"],
		["SessionEnd", "pi-peer-hook.js"],
	]);
	assert.deepEqual(HARNESS_MANIFEST.cursor.filter(({ kind }) => kind === "hook").map(({ event }) => event), ["beforeShellExecution", "beforeMCPExecution", "preToolUse"]);
	const commandEntries = (harness: Harness) => HARNESS_MANIFEST[harness].filter(({ kind }) => kind === "command");
	for (const harness of ["claude", "cursor", "opencode"] as const) {
		assert.deepEqual(commandEntries(harness).map(({ script, dest }) => [script, dest]), [
			...["discuss", "plan", "build"].map((name) => [`agent/harness-commands/${harness}/pi-${name}.md`, `commands/pi-${name}.md`]),
		]);
	}
	assert.equal(HARNESS_MANIFEST.claude.find(({ kind }) => kind === "statusline")?.script, "agent/claude-bridge-client/pi-statusline.js");
	assert.equal(HARNESS_MANIFEST.claude.find(({ kind }) => kind === "statusline")?.dest, "settings.json#/statusLine");
	assert.equal(HARNESS_MANIFEST.claude.find(({ kind }) => kind === "mcp")?.script, "agent/claude-bridge-client/pi-bridge-mcp.js");
	assert.equal(HARNESS_MANIFEST.cursor.find(({ kind }) => kind === "mcp")?.dest, "mcp.json#mcpServers.pi-claude-bridge");
	assert.deepEqual(HARNESS_MANIFEST.opencode.filter(({ kind }) => kind === "plugin").map(({ script, dest }) => [script, dest]), [
		["agent/opencode-bridge-client/pi-opencode-plugin.js", "plugins/pi-opencode-build-lease.js"],
	]);
	assert.equal(HARNESS_MANIFEST.opencode.find(({ kind }) => kind === "mcp")?.dest, "opencode.json#mcp.pi-claude-bridge");
	record("manifest shape and required harness entries");

	const emptyRoot = path.join(temp, "empty");
	const pkgRoot = await createPackage(emptyRoot);
	const roots = makeRoots(emptyRoot);
	const absent = await inspectHarness("claude", { pkgRoot, roots, platform: "darwin" });
	assert.equal(absent.state, "not-installed");
	const stampedMissing = await inspectHarness("claude", { pkgRoot, roots, stamp: { version: "1.2.3" }, platform: "darwin" });
	assert.equal(stampedMissing.state, "needs-fix", "a stamped but missing harness must not be treated as not installed");
	noted(stampedMissing.problems, "missing-entry");
	record("stamped harness missing-entry detection");
	record("not-installed state");

	const liveRoots = await installFixture(path.join(temp, "live"), pkgRoot);
	for (const harness of ["claude", "cursor", "opencode"] as const) {
		const result = await inspectHarness(harness, { pkgRoot, roots: liveRoots, platform: "darwin" });
		assert.equal(result.state, "ok", `${harness}: ${JSON.stringify(result.problems)}`);
		assert.deepEqual(result.problems, []);
		record(`${harness} complete manifest`);
	}
	const nonMacHealthy = await inspectHarness("claude", { pkgRoot, roots: liveRoots, platform: "linux" });
	assert.equal(nonMacHealthy.state, "ok", "non-macOS Bash caveat is warning-only for a healthy harness");
	assert.deepEqual(nonMacHealthy.problems.map(({ kind, severity }) => [kind, severity]), [["non-macos-claude-bash-warning", "warning"]]);
	record("non-macOS warning-only state");

	const rootsFromEnv = resolveHarnessRoots({ CLAUDE_CONFIG_DIR: "/custom/claude", XDG_CONFIG_HOME: "/custom/xdg" }, "/users/tester");
	assert.deepEqual(rootsFromEnv, {
		claude: "/custom/claude",
		claudeMcp: "/custom/claude/.claude.json",
		cursor: "/users/tester/.cursor",
		opencode: "/custom/xdg/opencode",
	});
	assert.deepEqual(resolveHarnessRoots({}, "/users/tester"), {
		claude: "/users/tester/.claude",
		claudeMcp: "/users/tester/.claude.json",
		cursor: "/users/tester/.cursor",
		opencode: "/users/tester/.config/opencode",
	});
	record("harness roots and overrides");

	const agentDir = path.join(temp, ".pi", "agent");
	const npmPackage = path.join(agentDir, "npm/node_modules/@scope/pkg");
	const gitPackage = path.join(agentDir, "git/github.com/example/pkg");
	await mkdir(npmPackage, { recursive: true });
	await mkdir(gitPackage, { recursive: true });
	assert.equal((await classifyPackageRoot(npmPackage, agentDir)).state, "user");
	assert.equal((await classifyPackageRoot(gitPackage, agentDir)).state, "user");
	const checkout = path.join(temp, "checkout");
	await mkdir(path.join(checkout, ".git"), { recursive: true });
	await mkdir(path.join(checkout, "docs/engineering"), { recursive: true });
	const checkoutResult = await classifyPackageRoot(checkout, agentDir);
	assert.equal(checkoutResult.state, "dev-checkout");
	assert.ok(checkoutResult.warning);
	const unknown = await mkdir(path.join(temp, "unknown"), { recursive: true }).then(() => path.join(temp, "unknown"));
	const refused = await classifyPackageRoot(unknown, agentDir);
	assert.equal(refused.state, "refused");
	assert.match(refused.hint ?? "", /Reinstall package through Pi/);
	for (const forbidden of [path.join(temp, "project/.pi/npm/pkg"), path.join(temp, "tmp/extensions/pkg"), path.join(agentDir, "extensions/legacy-npm/pkg")]) {
		await mkdir(forbidden, { recursive: true });
		assert.equal((await classifyPackageRoot(forbidden, agentDir)).state, "refused", forbidden);
	}
	const external = path.join(temp, "external-package");
	await mkdir(external, { recursive: true });
	const escaped = path.join(agentDir, "npm/node_modules/escape");
	await symlink(external, escaped);
	assert.equal((await classifyPackageRoot(escaped, agentDir)).state, "refused", "symlinked package root is refused");
	record("package-root classifications and symlink boundary");

	const mixed = path.join(temp, "mixed");
	const mixedRoots = await installFixture(mixed, pkgRoot);
	const otherCheckout = path.join(temp, "other-checkout");
	const otherPackage = await createPackage(otherCheckout);
	const mixedSettingsFile = path.join(mixedRoots.claude, "settings.json");
	const mixedSettings = JSON.parse(await readFile(mixedSettingsFile, "utf8"));
	const legacyHook = path.join(temp, "legacy", "agent/claude-bridge-client/pi-readonly-hook.js");
	await mkdir(path.dirname(legacyHook), { recursive: true });
	await writeFile(legacyHook, "legacy hook fixture\n");
	mixedSettings.hooks.PreToolUse[0].hooks[0].command = `node ${JSON.stringify(legacyHook)}`;
	mixedSettings.hooks.UserPromptSubmit[0].hooks[0].command = command(otherPackage, "agent/claude-bridge-client/pi-peer-hook.js");
	mixedSettings.statusLine.command = command(otherPackage, "agent/claude-bridge-client/pi-statusline.js");
	await writeJson(mixedSettingsFile, mixedSettings);
	await symlink(path.join(pkgRoot, "agent/harness-commands/claude/pi-discuss.md"), path.join(mixedRoots.claude, "commands/discuss.md"));
	const mixedResult = await inspectHarness("claude", { pkgRoot, roots: mixedRoots, platform: "linux" });
	assert.equal(mixedResult.state, "needs-fix");
	noted(mixedResult.problems, "wrong-root");
	noted(mixedResult.problems, "missing-entry");
	noted(mixedResult.problems, "legacy-command");
	noted(mixedResult.problems, "non-macos-claude-bash-warning");
	const mixedCursorFile = path.join(mixedRoots.cursor, "mcp.json");
	const mixedCursorConfig = JSON.parse(await readFile(mixedCursorFile, "utf8"));
	mixedCursorConfig.mcpServers["pi-claude-bridge"].args[0] = "agent/claude-bridge-client/pi-bridge-mcp.js";
	await writeJson(mixedCursorFile, mixedCursorConfig);
	const mixedCursor = await inspectHarness("cursor", { pkgRoot, roots: mixedRoots, platform: "linux" });
	assert.equal(mixedCursor.state, "needs-fix");
	noted(mixedCursor.problems, "wrong-root");
	noted(mixedCursor.problems, "missing-entry");
	record("mixed-root live config");

	const missingTargetRoot = path.join(temp, "missing-target");
	const missingTargetPkg = await createPackage(missingTargetRoot);
	const missingTargetRoots = await installFixture(missingTargetRoot, missingTargetPkg);
	await rm(path.join(missingTargetPkg, "agent/claude-bridge-client/pi-readonly-hook.js"));
	const missingTarget = await inspectHarness("claude", { pkgRoot: missingTargetPkg, roots: missingTargetRoots });
	noted(missingTarget.problems, "missing-target");
	record("missing client target");

	const malformedRoot = path.join(temp, "malformed");
	const malformedPkg = await createPackage(malformedRoot);
	const malformedRoots = await installFixture(malformedRoot, malformedPkg);
	await writeFile(path.join(malformedRoots.claude, "settings.json"), "{\"hooks\": { // JSONC\n}");
	const malformed = await inspectHarness("claude", { pkgRoot: malformedPkg, roots: malformedRoots });
	noted(malformed.problems, "jsonc");
	await writeFile(path.join(malformedRoots.claude, "settings.json"), "{ malformed }");
	const unparseable = await inspectHarness("claude", { pkgRoot: malformedPkg, roots: malformedRoots });
	noted(unparseable.problems, "unparseable");
	const shapeRoot = path.join(temp, "shape");
	const shapePkg = await createPackage(shapeRoot);
	const shapeRoots = await installFixture(shapeRoot, shapePkg);
	const shapeHooksFile = path.join(shapeRoots.cursor, "hooks.json");
	const failOpenHooks = JSON.parse(await readFile(shapeHooksFile, "utf8"));
	failOpenHooks.hooks.beforeShellExecution[0].failClosed = false;
	await writeJson(shapeHooksFile, failOpenHooks);
	const failOpen = await inspectHarness("cursor", { pkgRoot: shapePkg, roots: shapeRoots });
	noted(failOpen.problems, "malformed-shape");
	await writeJson(shapeHooksFile, { hooks: { beforeShellExecution: "not-an-array" } });
	const badShape = await inspectHarness("cursor", { pkgRoot: shapePkg, roots: shapeRoots });
	noted(badShape.problems, "malformed-shape");
	const mcpShapeRoot = path.join(temp, "mcp-shape");
	const mcpShapePkg = await createPackage(mcpShapeRoot);
	const mcpShapeRoots = await installFixture(mcpShapeRoot, mcpShapePkg);
	const mcpShapeFile = path.join(mcpShapeRoots.cursor, "mcp.json");
	const invalidMcp = JSON.parse(await readFile(mcpShapeFile, "utf8"));
	invalidMcp.mcpServers["pi-claude-bridge"].command = "bash";
	await writeJson(mcpShapeFile, invalidMcp);
	const badMcpShape = await inspectHarness("cursor", { pkgRoot: mcpShapePkg, roots: mcpShapeRoots });
	noted(badMcpShape.problems, "malformed-shape");
	record("malformed JSON, JSONC, MCP, and parsed shapes");

	const oversizedRoot = path.join(temp, "oversized");
	const oversizedPkg = await createPackage(oversizedRoot);
	const oversizedRoots = await installFixture(oversizedRoot, oversizedPkg);
	await writeFile(path.join(oversizedRoots.cursor, "mcp.json"), " ".repeat(MAX_CONFIG_BYTES + 1));
	const oversized = await inspectHarness("cursor", { pkgRoot: oversizedPkg, roots: oversizedRoots });
	noted(oversized.problems, "oversized");
	await rm(path.join(oversizedRoots.cursor, "mcp.json"));
	await mkdir(path.join(oversizedRoots.cursor, "mcp.json"), { recursive: true });
	const unreadable = await inspectHarness("cursor", { pkgRoot: oversizedPkg, roots: oversizedRoots });
	noted(unreadable.problems, "unreadable");
	record("1 MiB config cap and unreadable config");

	const foreignRoot = path.join(temp, "foreign");
	const foreignPkg = await createPackage(foreignRoot);
	const foreignRoots = await installFixture(foreignRoot, foreignPkg);
	const foreignSettings = JSON.parse(await readFile(path.join(foreignRoots.claude, "settings.json"), "utf8"));
	foreignSettings.statusLine.command = "node /usr/local/bin/foreign-statusline.js";
	foreignSettings.hooks.PreToolUse[0].hooks[0].command = "node /opt/foreign/hook.js";
	await writeJson(path.join(foreignRoots.claude, "settings.json"), foreignSettings);
	const foreign = await inspectHarness("claude", { pkgRoot: foreignPkg, roots: foreignRoots });
	noted(foreign.problems, "foreign-status-line");
	noted(foreign.problems, "entry-not-ours");
	const foreignCommandPath = path.join(foreignRoots.cursor, "commands/pi-build.md");
	await rm(foreignCommandPath);
	await writeFile(foreignCommandPath, "user-authored command\n");
	const foreignCommand = await inspectHarness("cursor", { pkgRoot: foreignPkg, roots: foreignRoots });
	noted(foreignCommand.problems, "legacy-command");
	assert.ok(foreignCommand.problems.some(({ dest, message }) => dest === "commands/pi-build.md" && /Install \/ repair backs it up and replaces it/.test(message)), "plain Pi command explains Install / repair replacement");
	record("foreign config entries and command files");

	const legacyRoot = path.join(temp, "legacy-command");
	const legacyPkg = await createPackage(legacyRoot);
	const legacyRoots = await installFixture(legacyRoot, legacyPkg);
	await symlink(path.join(legacyPkg, "agent/harness-commands/claude/pi-discuss.md"), path.join(legacyRoots.claude, "commands/discuss.md"));
	const legacy = await inspectHarness("claude", { pkgRoot: legacyPkg, roots: legacyRoots });
	noted(legacy.problems, "legacy-command");
	record("legacy unprefixed command symlink");
	const legacyOnlyRoot = path.join(temp, "legacy-only");
	const legacyOnlyPkg = await createPackage(legacyOnlyRoot);
	const legacyOnlyDir = path.join(legacyOnlyRoot, "claude/commands");
	await mkdir(legacyOnlyDir, { recursive: true });
	const legacyAsset = path.join(legacyOnlyPkg, "agent/harness-commands/claude/pi-discuss.md");
	await mkdir(path.dirname(legacyAsset), { recursive: true });
	await writeFile(legacyAsset, "legacy fixture\n");
	await symlink(legacyAsset, path.join(legacyOnlyDir, "discuss.md"));
	const legacyOnly = await inspectHarness("claude", { pkgRoot: legacyOnlyPkg, roots: makeRoots(legacyOnlyRoot) });
	assert.equal(legacyOnly.state, "needs-fix", "legacy-only install evidence must not be classified as absent");
	noted(legacyOnly.problems, "legacy-command");
	record("legacy-only state detection");
	const legacyForeignRoot = path.join(temp, "legacy-foreign");
	const legacyForeignPkg = await createPackage(legacyForeignRoot);
	const legacyForeignCommands = path.join(legacyForeignRoot, "claude/commands");
	await mkdir(legacyForeignCommands, { recursive: true });
	await writeFile(path.join(legacyForeignCommands, "discuss.md"), "user command\n");
	const outsideLegacy = path.join(temp, "outside-legacy.md");
	await writeFile(outsideLegacy, "foreign symlink target\n");
	await symlink(outsideLegacy, path.join(legacyForeignCommands, "plan.md"));
	const legacyForeign = await inspectHarness("claude", { pkgRoot: legacyForeignPkg, roots: makeRoots(legacyForeignRoot) });
	noted(legacyForeign.problems, "legacy-command");
	noted(legacyForeign.problems, "entry-not-ours");
	assert.ok(legacyForeign.problems.some(({ dest, kind }) => dest === "commands/discuss.md" && kind === "legacy-command"), "plain legacy command is identified for replacement");
	assert.ok(legacyForeign.problems.some(({ dest, kind }) => dest === "commands/plan.md" && kind === "entry-not-ours"), "foreign legacy symlink is preserved");
	record("plain and foreign legacy command inspection");

	const stampRoot = path.join(temp, "stamp");
	const stampPkg = await createPackage(stampRoot);
	const stamp = await inspectHarness("claude", { pkgRoot: stampPkg, roots: makeRoots(stampRoot), stamp: { version: "0.8.0" } });
	noted(stamp.problems, "stamp-version-mismatch");
	record("stamp/package version mismatch");

	const relativeRoot = path.join(temp, "relative-root");
	const relativePkg = await createPackage(relativeRoot);
	const relativeRoots = await installFixture(relativeRoot, relativePkg);
	const relativeSettings = JSON.parse(await readFile(path.join(relativeRoots.claude, "settings.json"), "utf8"));
	relativeSettings.hooks.PreToolUse[0].hooks[0].command = "node agent/claude-bridge-client/pi-readonly-hook.js";
	await writeJson(path.join(relativeRoots.claude, "settings.json"), relativeSettings);
	const relative = await inspectHarness("claude", { pkgRoot: relativePkg, roots: relativeRoots });
	noted(relative.problems, "wrong-root");
	record("relative package root refusal");

	const installBase = path.join(temp, "planner-idempotence");
	const installPkg = await createPackage(installBase);
	for (const harness of ["claude", "cursor", "opencode"] as const) {
		const rootsForHarness = makeRoots(path.join(installBase, harness));
		const agent = path.join(installBase, harness, "agent-dir");
		const options = { pkgRoot: installPkg, roots: rootsForHarness, agentDir: agent, platform: "darwin" };
		const plan = await planInstall(harness, options);
		assert.ok(plan.changes.length > 0, `${harness} fresh install plan has work`);
		assert.ok(!plan.changes.some(({ path: file }) => file === rootsForHarness.claudeMcp), "Claude MCP config is never planned as a direct write");
		if (harness === "claude") {
			assert.deepEqual(plan.cliSteps, [{ executable: "claude", args: ["mcp", "add", "-s", "user", PI_BRIDGE_MCP_KEY, "--", "node", path.join(installPkg, "agent/claude-bridge-client/pi-bridge-mcp.js")] }]);
		} else assert.deepEqual(plan.cliSteps, []);
		const applied = await applyPlan(plan, { now: new Date("2024-01-02T03:04:05.000Z") });
		assert.ok(applied.every(({ applied: ok }) => ok), `${harness} apply: ${JSON.stringify(applied)}`);
		if (harness === "claude") {
			await writeJson(rootsForHarness.claudeMcp, { mcpServers: { [PI_BRIDGE_MCP_KEY]: { command: "node", args: [path.join(installPkg, "agent/claude-bridge-client/pi-bridge-mcp.js")] } } });
		}
		const second = await planInstall(harness, options);
		assert.deepEqual(second.changes, [], `${harness} plan is idempotent after apply`);
		assert.deepEqual(second.cliSteps, [], `${harness} CLI plan is idempotent after registration`);
	}
	record("install apply idempotence and Claude MCP CLI-only planning");

	const customClaudeBase = path.join(temp, "planner-claude-config-dir");
	const customClaudePkg = await createPackage(customClaudeBase);
	const customClaudeRoots = resolveHarnessRoots(
		{ CLAUDE_CONFIG_DIR: path.join(customClaudeBase, "config", "claude") },
		path.join(customClaudeBase, "home"),
	);
	const customClaudeOptions = {
		pkgRoot: customClaudePkg,
		roots: customClaudeRoots,
		agentDir: path.join(customClaudeBase, "agent-dir"),
		platform: "darwin" as const,
	};
	assert.equal(customClaudeRoots.claudeMcp, path.join(customClaudeRoots.claude, ".claude.json"));
	const customClaudeFirst = await planInstall("claude", customClaudeOptions);
	assert.deepEqual(customClaudeFirst.cliSteps.map(({ args }) => args.slice(0, 5)), [["mcp", "add", "-s", "user", PI_BRIDGE_MCP_KEY]]);
	assert.ok((await applyPlan(customClaudeFirst)).every(({ applied: ok }) => ok));
	await writeJson(customClaudeRoots.claudeMcp, {
		mcpServers: { [PI_BRIDGE_MCP_KEY]: { command: "node", args: [path.join(customClaudePkg, "agent/claude-bridge-client/pi-bridge-mcp.js")] } },
	});
	const customClaudeSecond = await planInstall("claude", customClaudeOptions);
	assert.deepEqual(customClaudeSecond.changes, []);
	assert.deepEqual(customClaudeSecond.cliSteps, []);
	record("CLAUDE_CONFIG_DIR MCP path and idempotence");

	const repairBase = path.join(temp, "planner-mixed-root");
	const repairPkg = await createPackage(repairBase);
	const stalePkg = await createPackage(path.join(temp, "planner-stale-package"));
	const repairRoots = await installFixture(path.join(repairBase, "fixture"), repairPkg);
	const repairMcpFile = path.join(repairRoots.cursor, "mcp.json");
	const repairMcp = JSON.parse(await readFile(repairMcpFile, "utf8"));
	repairMcp.mcpServers[PI_BRIDGE_MCP_KEY].args[0] = path.join(stalePkg, "agent/claude-bridge-client/pi-bridge-mcp.js");
	await writeJson(repairMcpFile, repairMcp);
	const repairPlan = await planInstall("cursor", { pkgRoot: repairPkg, roots: repairRoots, agentDir: path.join(repairBase, "agent-dir") });
	assert.ok(repairPlan.changes.some(({ path: file }) => file === repairMcpFile));
	assert.ok((await applyPlan(repairPlan)).every(({ applied: ok }) => ok));
	const repairedMcp = JSON.parse(await readFile(repairMcpFile, "utf8"));
	assert.equal(repairedMcp.mcpServers[PI_BRIDGE_MCP_KEY].args[0], path.join(repairPkg, "agent/claude-bridge-client/pi-bridge-mcp.js"));
	assert.equal((await inspectHarness("cursor", { pkgRoot: repairPkg, roots: repairRoots })).state, "ok");
	record("mixed-root config repaired to selected package root");

	const mixedAgent = path.join(temp, "mixed-agent-dir");
	for (const harness of ["claude", "cursor", "opencode"] as const) {
		const fullRepair = await planInstall(harness, { pkgRoot, roots: mixedRoots, agentDir: mixedAgent, platform: "darwin" });
		assert.ok(fullRepair.changes.length > 0, `${harness} mixed-root plan contains repair`);
		assert.ok((await applyPlan(fullRepair)).every(({ applied: ok }) => ok), `${harness} mixed-root apply`);
		assert.equal((await inspectHarness(harness, { pkgRoot, roots: mixedRoots, stamp: await readStamp(mixedAgent), platform: "darwin" })).state, "ok", `${harness} repaired mixed-root fixture`);
	}
	await assert.rejects(lstat(path.join(mixedRoots.claude, "commands/discuss.md")));
	record("full live mixed-root fixture repairs across harnesses");

	const mcpKeyBase = path.join(temp, "planner-mcp-key-ownership");
	const mcpKeyPkg = await createPackage(mcpKeyBase);
	const mcpKeyRoots = await installFixture(path.join(mcpKeyBase, "fixture"), mcpKeyPkg);
	const mcpKeyFile = path.join(mcpKeyRoots.cursor, "mcp.json");
	const mcpKeyConfig = JSON.parse(await readFile(mcpKeyFile, "utf8"));
	mcpKeyConfig.mcpServers[PI_BRIDGE_MCP_KEY] = null;
	await writeJson(mcpKeyFile, mcpKeyConfig);
	const mcpKeyPlan = await planInstall("cursor", { pkgRoot: mcpKeyPkg, roots: mcpKeyRoots, agentDir: path.join(mcpKeyBase, "agent-dir") });
	assert.ok(mcpKeyPlan.changes.some(({ path: file }) => file === mcpKeyFile));
	assert.ok((await applyPlan(mcpKeyPlan)).every(({ applied: ok }) => ok));
	assert.equal(JSON.parse(await readFile(mcpKeyFile, "utf8")).mcpServers[PI_BRIDGE_MCP_KEY].args[0], path.join(mcpKeyPkg, "agent/claude-bridge-client/pi-bridge-mcp.js"));
	record("MCP ownership by key repairs malformed owned entry");

	const preserveBase = path.join(temp, "planner-preserve-foreign");
	const preservePkg = await createPackage(preserveBase);
	const preserveRoots = await installFixture(path.join(preserveBase, "fixture"), preservePkg);
	const preserveSettingsFile = path.join(preserveRoots.claude, "settings.json");
	const preserveSettings = JSON.parse(await readFile(preserveSettingsFile, "utf8"));
	const foreignHookGroup = { matcher: "Bash", hooks: [{ type: "command", command: "node /opt/foreign/hook.js", timeout: 10 }] };
	preserveSettings.hooks.PreToolUse.push(foreignHookGroup);
	await writeJson(preserveSettingsFile, preserveSettings);
	const preservePlan = await planInstall("claude", { pkgRoot: preservePkg, roots: preserveRoots, agentDir: path.join(preserveBase, "agent-dir") });
	assert.ok((await applyPlan(preservePlan)).every(({ applied: ok }) => ok));
	const preserved = JSON.parse(await readFile(preserveSettingsFile, "utf8"));
	assert.deepEqual(preserved.hooks.PreToolUse[1], foreignHookGroup);
	record("foreign hook deep-equal preservation");

	const skipBase = path.join(temp, "planner-skip-user");
	const skipPkg = await createPackage(skipBase);
	const skipRoots = await installFixture(path.join(skipBase, "fixture"), skipPkg);
	const skipSettingsFile = path.join(skipRoots.claude, "settings.json");
	const skipSettings = JSON.parse(await readFile(skipSettingsFile, "utf8"));
	skipSettings.statusLine = { type: "command", command: "node /opt/user/status.js", refreshInterval: 1 };
	await writeJson(skipSettingsFile, skipSettings);
	const plainCommandPath = path.join(skipRoots.claude, "commands/pi-build.md");
	await rm(plainCommandPath);
	await writeFile(plainCommandPath, "user-authored command\n");
	await chmod(plainCommandPath, 0o640);
	const skipPlan = await planInstall("claude", { pkgRoot: skipPkg, roots: skipRoots, agentDir: path.join(skipBase, "agent-dir") });
	assert.ok(skipPlan.skipped.some(({ path: file, reason }) => file === skipSettingsFile && /statusLine/.test(reason)));
	const plainCommandChange = skipPlan.changes.find(({ path: file }) => file === plainCommandPath);
	assert.equal(plainCommandChange?.legacyFile, true);
	const skipIso = "2024-01-02T03:04:05.000Z";
	const skipResults = await applyPlan(skipPlan, { now: new Date(skipIso) });
	assert.ok(skipResults.every(({ applied: ok }) => ok));
	const plainCommandResult = skipResults.find(({ path: file }) => file === plainCommandPath)!;
	assert.equal(plainCommandResult.backup, `${plainCommandPath}.harness-bak-${backupTimestamp(skipIso)}`);
	assert.equal(await readFile(plainCommandResult.backup!, "utf8"), "user-authored command\n");
	assert.equal((await lstat(plainCommandResult.backup!)).mode & 0o777, 0o640);
	assert.equal(await readlink(plainCommandPath), path.join(skipPkg, "agent/harness-commands/claude/pi-build.md"));
	assert.equal(JSON.parse(await readFile(skipSettingsFile, "utf8")).statusLine.command, "node /opt/user/status.js");
	record("foreign statusLine preserved and plain Pi command backed up/replaced");

	const legacyPlanBase = path.join(temp, "planner-legacy-link");
	const legacyPlanPkg = await createPackage(legacyPlanBase);
	const legacyPlanRoots = await installFixture(path.join(legacyPlanBase, "fixture"), legacyPlanPkg);
	const legacyOwnedPath = path.join(legacyPlanRoots.claude, "commands/discuss.md");
	await symlink(path.join(legacyPlanPkg, "agent/harness-commands/claude/pi-discuss.md"), legacyOwnedPath);
	const legacyPlan = await planInstall("claude", { pkgRoot: legacyPlanPkg, roots: legacyPlanRoots, agentDir: path.join(legacyPlanBase, "agent-dir") });
	assert.ok(legacyPlan.changes.some(({ path: file, kind }) => file === legacyOwnedPath && kind === "delete"));
	assert.ok((await applyPlan(legacyPlan)).every(({ applied: ok }) => ok));
	await assert.rejects(lstat(legacyOwnedPath));
	assert.ok((await lstat(path.join(legacyPlanRoots.claude, "commands/pi-discuss.md"))).isSymbolicLink());
	record("owned legacy symlink removal during install");

	const legacyPlainBase = path.join(temp, "planner-legacy-plain");
	const legacyPlainPkg = await createPackage(legacyPlainBase);
	const legacyPlainRoots = await installFixture(path.join(legacyPlainBase, "fixture"), legacyPlainPkg);
	const legacyPlainPrefixed = path.join(legacyPlainRoots.cursor, "commands/pi-plan.md");
	const legacyPlainUnprefixed = path.join(legacyPlainRoots.cursor, "commands/discuss.md");
	await rm(legacyPlainPrefixed);
	await writeFile(legacyPlainPrefixed, "hand-copied prefixed command\n");
	await chmod(legacyPlainPrefixed, 0o640);
	await writeFile(legacyPlainUnprefixed, "unrelated command at Pi name\n");
	const legacyPlainOptions = { pkgRoot: legacyPlainPkg, roots: legacyPlainRoots, agentDir: path.join(legacyPlainBase, "agent-dir"), platform: "darwin" as const };
	const legacyPlainPlan = await planInstall("cursor", legacyPlainOptions);
	const prefixedChange = legacyPlainPlan.changes.find(({ path: file }) => file === legacyPlainPrefixed);
	const unprefixedChange = legacyPlainPlan.changes.find(({ path: file }) => file === legacyPlainUnprefixed);
	assert.equal(prefixedChange?.legacyFile, true);
	assert.equal(prefixedChange?.kind, "symlink");
	assert.equal(unprefixedChange?.legacyFile, true);
	assert.equal(unprefixedChange?.kind, "delete");
	const legacyPlainIso = "2024-05-06T07:08:09.000Z";
	const legacyPlainResults = await applyPlan(legacyPlainPlan, { now: new Date(legacyPlainIso) });
	assert.ok(legacyPlainResults.every(({ applied: ok }) => ok), JSON.stringify(legacyPlainResults));
	for (const [file, expected] of [[legacyPlainPrefixed, "hand-copied prefixed command\n"], [legacyPlainUnprefixed, "unrelated command at Pi name\n"]] as const) {
		const result = legacyPlainResults.find(({ path: resultPath }) => resultPath === file)!;
		assert.equal(result.backup, `${file}.harness-bak-${backupTimestamp(legacyPlainIso)}`);
		assert.deepEqual(await readFile(result.backup!), Buffer.from(expected));
	}
	assert.equal((await lstat(`${legacyPlainPrefixed}.harness-bak-${backupTimestamp(legacyPlainIso)}`)).mode & 0o777, 0o640);
	assert.equal(await readlink(legacyPlainPrefixed), path.join(legacyPlainPkg, "agent/harness-commands/cursor/pi-plan.md"));
	await assert.rejects(lstat(legacyPlainUnprefixed));
	assert.deepEqual((await planInstall("cursor", legacyPlainOptions)).changes, [], "second install has no file changes");
	assert.equal((await inspectHarness("cursor", { ...legacyPlainOptions, stamp: await readStamp(legacyPlainOptions.agentDir) })).state, "ok");
	record("plain Pi command replacement, verified backups, and idempotence");

	const pluginFileBase = path.join(temp, "planner-plain-plugin");
	const pluginFilePkg = await createPackage(pluginFileBase);
	const pluginFileRoots = await installFixture(path.join(pluginFileBase, "fixture"), pluginFilePkg);
	const pluginFile = path.join(pluginFileRoots.opencode, "plugins/pi-opencode-build-lease.js");
	await rm(pluginFile);
	await writeFile(pluginFile, "user plugin file\n");
	const pluginFilePlan = await planInstall("opencode", { pkgRoot: pluginFilePkg, roots: pluginFileRoots, agentDir: path.join(pluginFileBase, "agent-dir") });
	assert.ok(pluginFilePlan.skipped.some(({ path: skippedPath }) => skippedPath === pluginFile));
	assert.ok(!pluginFilePlan.changes.some(({ path: changedPath }) => changedPath === pluginFile));
	assert.ok((await applyPlan(pluginFilePlan)).every(({ applied: ok }) => ok));
	assert.equal(await readFile(pluginFile, "utf8"), "user plugin file\n");
	noted((await inspectHarness("opencode", { pkgRoot: pluginFilePkg, roots: pluginFileRoots })).problems, "entry-not-ours");
	record("plain OpenCode plugin remains foreign and preserved");

	const oversizedLegacyBase = path.join(temp, "planner-oversized-legacy");
	const oversizedLegacyPkg = await createPackage(oversizedLegacyBase);
	const oversizedLegacyRoots = await installFixture(path.join(oversizedLegacyBase, "fixture"), oversizedLegacyPkg);
	const oversizedPrefixed = path.join(oversizedLegacyRoots.cursor, "commands/pi-build.md");
	const oversizedUnprefixed = path.join(oversizedLegacyRoots.cursor, "commands/build.md");
	await rm(oversizedPrefixed);
	const oversizedLegacyText = "x".repeat(MAX_CONFIG_BYTES + 1);
	await writeFile(oversizedPrefixed, oversizedLegacyText);
	await writeFile(oversizedUnprefixed, oversizedLegacyText);
	const oversizedLegacyPlan = await planInstall("cursor", { pkgRoot: oversizedLegacyPkg, roots: oversizedLegacyRoots, agentDir: path.join(oversizedLegacyBase, "agent-dir") });
	for (const file of [oversizedPrefixed, oversizedUnprefixed]) {
		assert.ok(oversizedLegacyPlan.skipped.some(({ path: skippedPath, reason }) => skippedPath === file && /unreadable or oversized/.test(reason)));
		assert.ok(!oversizedLegacyPlan.changes.some(({ path: changedPath }) => changedPath === file));
	}
	assert.ok((await applyPlan(oversizedLegacyPlan)).every(({ applied: ok }) => ok));
	assert.equal((await readFile(oversizedPrefixed, "utf8")).length, MAX_CONFIG_BYTES + 1);
	assert.equal((await readFile(oversizedUnprefixed, "utf8")).length, MAX_CONFIG_BYTES + 1);
	record("oversized plain Pi command files remain untouched");

	const legacyRaceBase = path.join(temp, "planner-legacy-toctou");
	const legacyRacePkg = await createPackage(legacyRaceBase);
	const legacyRaceRoots = await installFixture(path.join(legacyRaceBase, "fixture"), legacyRacePkg);
	const legacyRaceFile = path.join(legacyRaceRoots.cursor, "commands/pi-build.md");
	await rm(legacyRaceFile);
	await writeFile(legacyRaceFile, "planned command\n");
	const legacyRacePlan = await planInstall("cursor", { pkgRoot: legacyRacePkg, roots: legacyRaceRoots, agentDir: path.join(legacyRaceBase, "agent-dir") });
	await writeFile(legacyRaceFile, "changed after planning\n");
	const legacyRaceIso = "2024-01-02T03:04:05.000Z";
	const legacyRaceResult = (await applyPlan(legacyRacePlan, { now: new Date(legacyRaceIso) })).find(({ path: file }) => file === legacyRaceFile)!;
	assert.equal(legacyRaceResult.applied, false);
	assert.equal(await readFile(legacyRaceFile, "utf8"), "changed after planning\n");
	await assert.rejects(lstat(`${legacyRaceFile}.harness-bak-${backupTimestamp(legacyRaceIso)}`));
	record("legacy command preimage mismatch aborts without backup or mutation");

	const rootSwitchBase = path.join(temp, "planner-root-switch");
	const rootSwitchPkgA = await createPackage(path.join(rootSwitchBase, "package-a"));
	const rootSwitchPkgB = await createPackage(path.join(rootSwitchBase, "package-b"));
	const rootSwitchRoots = await installFixture(path.join(rootSwitchBase, "fixture"), rootSwitchPkgA);
	const rootSwitchAgent = path.join(rootSwitchBase, "agent-dir");
	const rootSwitchPlan = await planInstall("claude", { pkgRoot: rootSwitchPkgB, roots: rootSwitchRoots, agentDir: rootSwitchAgent });
	const rootSwitchEntries = HARNESS_MANIFEST.claude.filter(({ kind }) => kind === "command");
	assert.equal(rootSwitchEntries.length, 3);
	for (const entry of rootSwitchEntries) {
		const file = path.join(rootSwitchRoots.claude, entry.dest);
		const change = rootSwitchPlan.changes.find(({ path: changePath }) => changePath === file);
		assert.ok(change, `root-switch preview includes ${entry.dest}`);
		assert.equal(change.kind, "symlink");
		assert.equal(change.before, path.join(rootSwitchPkgA, entry.script));
		assert.equal(change.after, path.join(rootSwitchPkgB, entry.script));
	}
	const rootSwitchIso = "2024-05-06T07:08:09.000Z";
	const rootSwitchResults = await applyPlan(rootSwitchPlan, { now: new Date(rootSwitchIso) });
	assert.ok(rootSwitchResults.every(({ applied: ok }) => ok), JSON.stringify(rootSwitchResults));
	assert.deepEqual(rootSwitchPlan.cliSteps, [
		{ executable: "claude", args: ["mcp", "remove", "-s", "user", PI_BRIDGE_MCP_KEY] },
		{ executable: "claude", args: ["mcp", "add", "-s", "user", PI_BRIDGE_MCP_KEY, "--", "node", path.join(rootSwitchPkgB, "agent/claude-bridge-client/pi-bridge-mcp.js")] },
	]);
	for (const entry of rootSwitchEntries) {
		const file = path.join(rootSwitchRoots.claude, entry.dest);
		const backup = `${file}.harness-bak-${backupTimestamp(rootSwitchIso)}`;
		assert.equal(await readlink(file), path.join(rootSwitchPkgB, entry.script));
		assert.ok((await lstat(backup)).isSymbolicLink());
		assert.equal(await readlink(backup), path.join(rootSwitchPkgA, entry.script));
	}
	await writeJson(rootSwitchRoots.claudeMcp, {
		mcpServers: { [PI_BRIDGE_MCP_KEY]: { command: "node", args: [path.join(rootSwitchPkgB, "agent/claude-bridge-client/pi-bridge-mcp.js")] } },
	});
	const rootSwitchInspect = await inspectHarness("claude", { pkgRoot: rootSwitchPkgB, roots: rootSwitchRoots, agentDir: rootSwitchAgent });
	assert.equal(rootSwitchInspect.state, "ok", JSON.stringify(rootSwitchInspect.problems));
	record("live owned links retarget across package roots with backups");

	const danglingBase = path.join(temp, "planner-dangling-owned-symlink");
	const danglingPkgA = await createPackage(path.join(danglingBase, "removed-package"));
	const danglingPkgB = await createPackage(path.join(danglingBase, "selected-package"));
	const danglingRoots = await installFixture(path.join(danglingBase, "fixture"), danglingPkgA);
	const danglingAgent = path.join(danglingBase, "agent-dir");
	const danglingEntry = HARNESS_MANIFEST.opencode.find(({ kind }) => kind === "plugin")!;
	const danglingPath = path.join(danglingRoots.opencode, danglingEntry.dest);
	await rm(danglingPkgA, { recursive: true, force: true });
	const danglingPlan = await planInstall("opencode", { pkgRoot: danglingPkgB, roots: danglingRoots, agentDir: danglingAgent });
	const danglingChange = danglingPlan.changes.find(({ path: file }) => file === danglingPath);
	assert.deepEqual(danglingChange, {
		path: danglingPath,
		kind: "symlink",
		before: path.join(danglingPkgA, danglingEntry.script),
		after: path.join(danglingPkgB, danglingEntry.script),
	});
	const danglingIso = "2024-06-07T08:09:10.000Z";
	const danglingResults = await applyPlan(danglingPlan, { now: new Date(danglingIso) });
	assert.ok(danglingResults.every(({ applied: ok }) => ok), JSON.stringify(danglingResults));
	assert.equal(await readlink(danglingPath), path.join(danglingPkgB, danglingEntry.script));
	const danglingBackup = `${danglingPath}.harness-bak-${backupTimestamp(danglingIso)}`;
	assert.ok((await lstat(danglingBackup)).isSymbolicLink());
	assert.equal(await readlink(danglingBackup), path.join(danglingPkgA, danglingEntry.script));
	const danglingInspect = await inspectHarness("opencode", { pkgRoot: danglingPkgB, roots: danglingRoots, agentDir: danglingAgent });
	assert.equal(danglingInspect.state, "ok", JSON.stringify(danglingInspect.problems));
	record("dangling owned plugin link retargets from removed package root");

	const uninstallOwnedBase = path.join(temp, "planner-uninstall-other-root-symlinks");
	const uninstallOwnedPkgA = await createPackage(path.join(uninstallOwnedBase, "package-a"));
	const uninstallOwnedPkgB = await createPackage(path.join(uninstallOwnedBase, "package-b"));
	const uninstallOwnedRoots = makeRoots(path.join(uninstallOwnedBase, "fixture"));
	await setupRoot(uninstallOwnedRoots.cursor, "cursor", uninstallOwnedPkgA);
	const uninstallOwnedPlan = await planUninstall("cursor", { pkgRoot: uninstallOwnedPkgB, roots: uninstallOwnedRoots, agentDir: path.join(uninstallOwnedBase, "agent-dir") });
	const uninstallOwnedEntries = HARNESS_MANIFEST.cursor.filter(({ kind }) => kind === "command");
	for (const entry of uninstallOwnedEntries) {
		const file = path.join(uninstallOwnedRoots.cursor, entry.dest);
		const change = uninstallOwnedPlan.changes.find(({ path: changePath }) => changePath === file);
		assert.ok(change, `uninstall plan includes ${entry.dest}`);
		assert.deepEqual(change, { path: file, kind: "delete", before: path.join(uninstallOwnedPkgA, entry.script), after: null });
	}
	const uninstallOwnedResults = await applyPlan(uninstallOwnedPlan);
	assert.ok(uninstallOwnedResults.every(({ applied: ok }) => ok), JSON.stringify(uninstallOwnedResults));
	for (const entry of uninstallOwnedEntries) await assert.rejects(lstat(path.join(uninstallOwnedRoots.cursor, entry.dest)));
	const uninstalledOwnedInspect = await inspectHarness("cursor", { pkgRoot: uninstallOwnedPkgB, roots: uninstallOwnedRoots, agentDir: path.join(uninstallOwnedBase, "agent-dir") });
	assert.equal(uninstalledOwnedInspect.state, "not-installed", JSON.stringify(uninstalledOwnedInspect.problems));
	record("uninstall deletes owned links from another package root");

	const foreignLinkBase = path.join(temp, "planner-foreign-symlink");
	const foreignLinkPkg = await createPackage(foreignLinkBase);
	const foreignLinkRoots = makeRoots(path.join(foreignLinkBase, "fixture"));
	const foreignLinkPath = path.join(foreignLinkRoots.cursor, "commands/pi-plan.md");
	const foreignLinkTarget = path.join(foreignLinkBase, "elsewhere/pi-plan.md");
	await mkdir(path.dirname(foreignLinkTarget), { recursive: true });
	await writeFile(foreignLinkTarget, "foreign command\n");
	await mkdir(path.dirname(foreignLinkPath), { recursive: true });
	await symlink(foreignLinkTarget, foreignLinkPath);
	const foreignLinkPlan = await planInstall("cursor", { pkgRoot: foreignLinkPkg, roots: foreignLinkRoots, agentDir: path.join(foreignLinkBase, "agent-dir") });
	assert.ok(foreignLinkPlan.skipped.some(({ path: file, reason }) => file === foreignLinkPath && reason === "Symlink target is outside selected package; preserve it."));
	assert.ok(!foreignLinkPlan.changes.some(({ path: file }) => file === foreignLinkPath));
	assert.ok((await applyPlan(foreignLinkPlan)).every(({ applied: ok }) => ok));
	assert.equal(await readlink(foreignLinkPath), foreignLinkTarget);
	const foreignUninstallPlan = await planUninstall("cursor", { pkgRoot: foreignLinkPkg, roots: foreignLinkRoots, agentDir: path.join(foreignLinkBase, "agent-dir") });
	assert.ok(foreignUninstallPlan.skipped.some(({ path: file, reason }) => file === foreignLinkPath && reason === "Symlink target is outside selected package; preserve it."));
	assert.ok(!foreignUninstallPlan.changes.some(({ path: file }) => file === foreignLinkPath));
	assert.ok((await applyPlan(foreignUninstallPlan)).every(({ applied: ok }) => ok));
	assert.equal(await readlink(foreignLinkPath), foreignLinkTarget);
	record("foreign non-owned symlink preserved on install and uninstall");

	const invalidPlanBase = path.join(temp, "planner-unparseable");
	const invalidPlanPkg = await createPackage(invalidPlanBase);
	const invalidPlanRoots = await installFixture(path.join(invalidPlanBase, "fixture"), invalidPlanPkg);
	const invalidFile = path.join(invalidPlanRoots.claude, "settings.json");
	const invalidBytes = "{ broken config\n";
	await writeFile(invalidFile, invalidBytes);
	const invalidPlan = await planInstall("claude", { pkgRoot: invalidPlanPkg, roots: invalidPlanRoots, agentDir: path.join(invalidPlanBase, "agent-dir") });
	assert.deepEqual(invalidPlan.changes.filter(({ path: file }) => file === invalidFile), []);
	assert.ok(invalidPlan.skipped.some(({ path: file }) => file === invalidFile));
	assert.ok((await applyPlan(invalidPlan)).every(({ applied: ok }) => ok));
	assert.equal(await readFile(invalidFile, "utf8"), invalidBytes);
	await assert.rejects(lstat(`${invalidFile}.harness-bak-2024-01-02T03:04:05.000Z`));
	record("unparseable config plans zero writes for that file");

	const raceBase = path.join(temp, "planner-toctou");
	const racePkg = await createPackage(raceBase);
	const raceRoots = await installFixture(path.join(raceBase, "fixture"), racePkg);
	const raceHooksFile = path.join(raceRoots.cursor, "hooks.json");
	const raceMcpFile = path.join(raceRoots.cursor, "mcp.json");
	const raceHooks = JSON.parse(await readFile(raceHooksFile, "utf8"));
	raceHooks.hooks.beforeShellExecution[0].failClosed = false;
	await writeJson(raceHooksFile, raceHooks);
	const raceMcp = JSON.parse(await readFile(raceMcpFile, "utf8"));
	raceMcp.mcpServers[PI_BRIDGE_MCP_KEY].args[0] = path.join(stalePkg, "agent/claude-bridge-client/pi-bridge-mcp.js");
	await writeJson(raceMcpFile, raceMcp);
	const racePlan = await planInstall("cursor", { pkgRoot: racePkg, roots: raceRoots, agentDir: path.join(raceBase, "agent-dir") });
	const hooksChange = racePlan.changes.find(({ path: file }) => file === raceHooksFile)!;
	await writeJson(raceHooksFile, { userEdit: true });
	const raceResults = await applyPlan(racePlan);
	assert.equal(raceResults.find(({ path: file }) => file === raceHooksFile)?.applied, false);
	assert.equal(raceResults.find(({ path: file }) => file === raceMcpFile)?.applied, true);
	assert.equal(JSON.parse(await readFile(raceHooksFile, "utf8")).userEdit, true);
	assert.notEqual(hooksChange.before, await readFile(raceHooksFile, "utf8"));
	record("TOCTOU mismatch aborts only changed file");

	const cappedApplyBase = path.join(temp, "planner-capped-apply");
	const cappedApplyPkg = await createPackage(cappedApplyBase);
	const cappedApplyRoots = await installFixture(path.join(cappedApplyBase, "fixture"), cappedApplyPkg);
	const cappedApplyMcp = path.join(cappedApplyRoots.cursor, "mcp.json");
	const cappedApplyConfig = JSON.parse(await readFile(cappedApplyMcp, "utf8"));
	cappedApplyConfig.mcpServers[PI_BRIDGE_MCP_KEY].args[0] = path.join(cappedApplyBase, "stale-mcp.js");
	await writeJson(cappedApplyMcp, cappedApplyConfig);
	const cappedApplyPlan = await planInstall("cursor", { pkgRoot: cappedApplyPkg, roots: cappedApplyRoots, agentDir: path.join(cappedApplyBase, "agent-dir") });
	const oversizedEdit = "x".repeat(MAX_CONFIG_BYTES + 1);
	await writeFile(cappedApplyMcp, oversizedEdit);
	const cappedApplyResults = await applyPlan(cappedApplyPlan);
	assert.equal(cappedApplyResults.find(({ path: file }) => file === cappedApplyMcp)?.applied, false);
	assert.equal((await readFile(cappedApplyMcp, "utf8")).length, oversizedEdit.length);
	record("apply re-read respects 1 MiB config cap");

	const backupBase = path.join(temp, "planner-backups");
	const backupPkg = await createPackage(backupBase);
	const backupRoots = await installFixture(path.join(backupBase, "fixture"), backupPkg);
	const backupSettingsFile = path.join(backupRoots.claude, "settings.json");
	const backupSettings = JSON.parse(await readFile(backupSettingsFile, "utf8"));
	backupSettings.hooks.PreToolUse[0].hooks[0].command = command(stalePkg, "agent/claude-bridge-client/pi-readonly-hook.js");
	await writeJson(backupSettingsFile, backupSettings);
	await chmod(backupSettingsFile, 0o640);
	const replacedLink = path.join(backupRoots.claude, "commands/pi-plan.md");
	await rm(replacedLink);
	await symlink(path.join(backupPkg, "agent/harness-commands/cursor/pi-plan.md"), replacedLink);
	const backupLegacy = path.join(backupRoots.claude, "commands/build.md");
	await symlink(path.join(backupPkg, "agent/harness-commands/claude/pi-build.md"), backupLegacy);
	const backupPlan = await planInstall("claude", { pkgRoot: backupPkg, roots: backupRoots, agentDir: path.join(backupBase, "agent-dir") });
	const priorExistingChanges = backupPlan.changes.filter(({ before }) => before !== null);
	assert.ok(priorExistingChanges.length >= 3);
	const backupIso = "2024-02-03T04:05:06.000Z";
	const backupStamp = backupTimestamp(backupIso);
	const backupResults = await applyPlan(backupPlan, { now: new Date(backupIso) });
	assert.ok(backupResults.every(({ applied: ok }) => ok), JSON.stringify(backupResults));
	assert.equal((await lstat(backupSettingsFile)).mode & 0o777, 0o640, "atomic replacement preserves original mode");
	for (const change of priorExistingChanges) {
		const backup = `${change.path}.harness-bak-${backupStamp}`;
		const info = await lstat(backup);
		if (change.kind === "json") {
			assert.ok(info.isFile());
			assert.equal(await readFile(backup, "utf8"), change.before);
		} else {
			assert.ok(info.isSymbolicLink());
			assert.equal(await readlink(backup), change.before);
		}
	}
	record("backup before every changed existing file or symlink");

	const uninstallBase = path.join(temp, "planner-uninstall");
	const uninstallPkg = await createPackage(uninstallBase);
	const uninstallRoots = await installFixture(path.join(uninstallBase, "fixture"), uninstallPkg);
	const uninstallAgent = path.join(uninstallBase, "agent-dir");
	const uninstallSettingsFile = path.join(uninstallRoots.claude, "settings.json");
	const uninstallSettings = JSON.parse(await readFile(uninstallSettingsFile, "utf8"));
	const uninstallForeignHook = { hooks: [{ type: "command", command: "node /opt/foreign/preserve.js" }] };
	uninstallSettings.hooks.PreToolUse.push(uninstallForeignHook);
	await writeJson(uninstallSettingsFile, uninstallSettings);
	const foreignUninstallCommand = path.join(uninstallRoots.claude, "commands/pi-build.md");
	await rm(foreignUninstallCommand);
	await writeFile(foreignUninstallCommand, "preserve this file\n");
	await writeStamp(uninstallAgent, {
		version: "1.2.3",
		harnesses: {
			claude: { pkgRoot: uninstallPkg, installedAt: "2024-01-01T00:00:00.000Z" },
			cursor: { pkgRoot: uninstallPkg, installedAt: "2024-01-01T00:00:00.000Z" },
		},
	});
	const plainLegacyUninstallCommand = path.join(uninstallRoots.claude, "commands/discuss.md");
	await writeFile(plainLegacyUninstallCommand, "leave unprefixed command alone\n");
	const uninstallPlan = await planUninstall("claude", { pkgRoot: uninstallPkg, roots: uninstallRoots, agentDir: uninstallAgent });
	assert.deepEqual(uninstallPlan.cliSteps, [{ executable: "claude", args: ["mcp", "remove", "-s", "user", PI_BRIDGE_MCP_KEY] }]);
	const uninstallBackupIso = "2024-04-05T06:07:08.000Z";
	assert.ok(!uninstallPlan.changes.some(({ path: file }) => file === foreignUninstallCommand || file === plainLegacyUninstallCommand), "uninstall never plans changes to plain commands");
	assert.ok((await applyPlan(uninstallPlan, { now: new Date(uninstallBackupIso) })).every(({ applied: ok }) => ok));
	const uninstalledSettings = JSON.parse(await readFile(uninstallSettingsFile, "utf8"));
	assert.deepEqual(uninstalledSettings.hooks.PreToolUse[0].hooks, []);
	assert.deepEqual(uninstalledSettings.hooks.PreToolUse[1], uninstallForeignHook);
	assert.equal(Object.hasOwn(uninstalledSettings, "statusLine"), false);
	assert.match(await readFile(foreignUninstallCommand, "utf8"), /preserve this file/);
	assert.equal(await readFile(plainLegacyUninstallCommand, "utf8"), "leave unprefixed command alone\n");
	await assert.rejects(lstat(path.join(uninstallRoots.claude, "commands/pi-discuss.md")));
	await assert.rejects(lstat(path.join(uninstallRoots.claude, "commands/pi-plan.md")));
	assert.deepEqual(Object.keys((await readStamp(uninstallAgent))!.harnesses), ["cursor"]);
	assert.ok((await lstat(path.join(uninstallAgent, `harness-setup.json.harness-bak-${backupTimestamp(uninstallBackupIso)}`))).isFile());
	record("uninstall removes only owned entries and stamp harness");

	const stampApiDir = path.join(temp, "stamp-api");
	const stampValue = { version: "9.8.7", harnesses: { opencode: { pkgRoot: "/pkg", installedAt: "2024-01-01T00:00:00.000Z" } } };
	await writeStamp(stampApiDir, stampValue);
	assert.deepEqual(await readStamp(stampApiDir), stampValue);
	const stampBackupIso = "2024-03-04T05:06:07.000Z";
	await removeStampHarness(stampApiDir, "opencode", { now: new Date(stampBackupIso) });
	assert.deepEqual(await readStamp(stampApiDir), { version: "9.8.7", harnesses: {} });
	assert.ok((await lstat(path.join(stampApiDir, `harness-setup.json.harness-bak-${backupTimestamp(stampBackupIso)}`))).isFile());
	record("stamp shape, write, read, and harness removal");

	const guardBase = path.join(temp, "claude-pretool-guard");
	const guardPkg = await createPackage(guardBase);
	const guardRoots = await installFixture(path.join(guardBase, "fixture"), guardPkg);
	const guardAgent = path.join(guardBase, "agent-dir");
	const guardFile = path.join(guardRoots.claude, "settings.json");
	const installedSettings = JSON.parse(await readFile(guardFile, "utf8"));
	assert.ok(installedSettings.hooks.PreToolUse[0].hooks[0].command.endsWith("|| exit 2"), "fresh install is guarded");
	installedSettings.hooks.PreToolUse[0].hooks[0].command = command(guardPkg, "agent/claude-bridge-client/pi-readonly-hook.js");
	await writeJson(guardFile, installedSettings);
	const guardInspect = await inspectHarness("claude", { pkgRoot: guardPkg, roots: guardRoots, agentDir: guardAgent });
	noted(guardInspect.problems, "unguarded-hook");
	const guardPlan = await planInstall("claude", { pkgRoot: guardPkg, roots: guardRoots, agentDir: guardAgent });
	const guardChange = guardPlan.changes.find(({ path: file }) => file === guardFile);
	assert.ok(guardChange, "repair plan includes settings.json");
	assert.match(guardChange.after, /\|\| exit 2/);
	const guardResults = await applyPlan(guardPlan);
	assert.ok(guardResults.every(({ applied: ok }) => ok), JSON.stringify(guardResults));
	const repaired = JSON.parse(await readFile(guardFile, "utf8"));
	assert.ok(repaired.hooks.PreToolUse[0].hooks[0].command.endsWith("|| exit 2"), "repair writes the guard");
	for (const event of ["UserPromptSubmit", "SessionEnd"]) {
		assert.equal(repaired.hooks[event][0].hooks[0].command.endsWith("|| exit 2"), false, `${event} must stay unguarded`);
	}
	const repairedInspect = await inspectHarness("claude", { pkgRoot: guardPkg, roots: guardRoots, agentDir: guardAgent });
	assert.equal(repairedInspect.state, "ok", JSON.stringify(repairedInspect.problems));
	record("claude PreToolUse guard installed, legacy flagged, peers unguarded");

	const boundaryBase = path.join(temp, "planner-boundary");
	const boundaryPkg = await createPackage(boundaryBase);
	const boundaryRoots = await installFixture(path.join(boundaryBase, "fixture"), boundaryPkg);
	const boundaryAgent = path.join(boundaryBase, "agent-dir");
	const boundaryPlan = await planInstall("cursor", { pkgRoot: boundaryPkg, roots: boundaryRoots, agentDir: boundaryAgent });
	const outsideFile = path.join(temp, "outside-write-probe.json");
	boundaryPlan.changes.push({ path: outsideFile, kind: "json", before: null, after: "{}\n" });
	const boundaryResults = await applyPlan(boundaryPlan);
	assert.equal(boundaryResults.find(({ path: file }) => file === outsideFile)?.applied, false);
	await assert.rejects(lstat(outsideFile));
	record("apply write confinement to harness roots and stamp");

	console.log(`assertion coverage: ${[...covered].sort().join(", ")}`);
	console.log(`problem-kind coverage: ${[...seenProblems].sort().join(", ")}`);
	console.log("test_setup passed");
} finally {
	await rm(temp, { recursive: true, force: true });
}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
