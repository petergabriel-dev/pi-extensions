import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURSOR_HOOK_FAIL_CLOSED, HARNESS_MANIFEST, MAX_CONFIG_BYTES, PI_BRIDGE_MCP_KEY, STATUSLINE_REFRESH_INTERVAL } from "../manifest.ts";
import { classifyPackageRoot, inspectHarness, resolveHarnessRoots } from "../setup.ts";
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
			if (entry.kind !== "command" && entry.kind !== "plugin") {
				const asset = path.join(pkgRoot, entry.script);
				await mkdir(path.dirname(asset), { recursive: true });
				await writeFile(asset, "fixture asset\n");
			}
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
const installFixture = async (root: string, pkgRoot: string) => {
	const roots = makeRoots(root);
	await Promise.all([
		setupRoot(roots.claude, "claude", pkgRoot),
		setupRoot(roots.cursor, "cursor", pkgRoot),
		setupRoot(roots.opencode, "opencode", pkgRoot),
	]);
	await writeJson(path.join(roots.claude, "settings.json"), {
		hooks: {
			PreToolUse: [{ hooks: [{ type: "command", command: command(pkgRoot, "agent/claude-bridge-client/pi-readonly-hook.js") }] }],
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
		claudeMcp: "/users/tester/.claude.json",
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
	noted(foreignCommand.problems, "entry-not-ours");
	assert.ok(foreignCommand.problems.some(({ dest }) => dest === "commands/pi-build.md"), "foreign command file is identified at its destination");
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
	noted(legacyForeign.problems, "entry-not-ours");
	assert.ok(legacyForeign.problems.some(({ dest }) => dest === "commands/discuss.md"), "plain legacy command is reported");
	assert.ok(legacyForeign.problems.some(({ dest }) => dest === "commands/plan.md"), "foreign legacy symlink is reported");
	record("plain and foreign legacy command preservation");

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
