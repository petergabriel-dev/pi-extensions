import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bridgeClients = [
  "agent/claude-bridge-client/pi-bridge-mcp.js",
  "agent/claude-bridge-client/pi-readonly-hook.js",
  "agent/claude-bridge-client/pi-peer-hook.js",
  "agent/claude-bridge-client/pi-statusline.js",
  "agent/cursor-bridge-client/cursor-readonly-hook.js",
  "agent/opencode-bridge-client/pi-opencode-plugin.js",
  "agent/codex-bridge-client/pi-codex-hook.js",
];
const harnessTemplates = [
  "agent/harness-commands/claude/pi-discuss.md",
  "agent/harness-commands/claude/pi-plan.md",
  "agent/harness-commands/claude/pi-build.md",
  "agent/harness-commands/claude/pi-review.md",
  "agent/harness-commands/cursor/pi-discuss.md",
  "agent/harness-commands/cursor/pi-plan.md",
  "agent/harness-commands/cursor/pi-build.md",
  "agent/harness-commands/cursor/pi-review.md",
  "agent/harness-commands/opencode/pi-discuss.md",
  "agent/harness-commands/opencode/pi-plan.md",
  "agent/harness-commands/opencode/pi-build.md",
  "agent/harness-commands/opencode/pi-review.md",
  "agent/harness-commands/codex/pi-discuss/SKILL.md",
  "agent/harness-commands/codex/pi-discuss/agents/openai.yaml",
  "agent/harness-commands/codex/pi-plan/SKILL.md",
  "agent/harness-commands/codex/pi-plan/agents/openai.yaml",
  "agent/harness-commands/codex/pi-build/SKILL.md",
  "agent/harness-commands/codex/pi-build/agents/openai.yaml",
  "agent/harness-commands/codex/pi-review/SKILL.md",
  "agent/harness-commands/codex/pi-review/agents/openai.yaml",
];
const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  maxBuffer: 20 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
assert.equal(result.status, 0, `npm pack failed (${result.status ?? "signal"})`);

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  assert.fail("npm pack did not return JSON");
}
const pack = Array.isArray(report) ? report[0] : report;
assert.ok(pack?.files && Number.isFinite(pack.size) && Number.isFinite(pack.unpackedSize), "invalid npm pack report");

const files = new Set(pack.files.map((entry) => entry.path.replaceAll("\\", "/")));
const isAllowed = (file) =>
  file === "package.json" ||
  file === "README.md" ||
  file === "LICENSE" ||
  file === "CHANGELOG.md" ||
  bridgeClients.includes(file) ||
  harnessTemplates.includes(file) ||
  /^agent\/extensions\/(?:[^/]+\/)?[^/]+\.ts$/.test(file) ||
  file === "agent/extensions/engineering-docs/README.md" ||
  file === "agent/extensions/filechanges/README.md" ||
  file === "agent/extensions/workflow-modes/plan-template.md" ||
  file === "agent/extensions/workflow-modes/README.md" ||
  /^agent\/agents\/[^/]+\.md$/.test(file) ||
  /^agent\/skills\/.*\.md$/.test(file);

const forbiddenSegments = new Set([
  ".pi",
  ".cursor",
  "node_modules",
  "test",
  "tests",
  "client",
  "clients",
  "session",
  "sessions",
  "memory",
  "bridge",
  "cache",
  "logs",
]);
const forbiddenFile = /^(?:auth|trust|settings|models-store)\.json$|^(?:memory|MEMORY)\.md(?:\.bak)?$|^(?:\.npmrc|npmrc|package-lock\.json|npm-shrinkwrap\.json)$|^tsconfig(?:\.[^/]+)?\.json$|\.(?:db|sqlite|sqlite3|log|tmp|lock)$/i;
for (const file of files) {
  assert.ok(!file.startsWith("docs/engineering/"), `engineering docs must not be packaged: ${file}`);
  assert.ok(!/^test-.*\.js$/.test(path.posix.basename(file)), `test file must not be packaged: ${file}`);
  const segments = file.split("/");
  assert.ok(!segments.some((segment) => forbiddenSegments.has(segment)), `forbidden package path: ${file}`);
  assert.ok(file === "package.json" || path.posix.basename(file) !== "package.json", `nested package manifest: ${file}`);
  assert.ok(!forbiddenFile.test(path.posix.basename(file)), `forbidden package file: ${file}`);
  assert.ok(isAllowed(file), `file outside package allowlist: ${file}`);
}
assert.deepEqual(
  [...files]
    .filter(
      (file) =>
        file.startsWith("agent/claude-bridge-client/") ||
        file.startsWith("agent/cursor-bridge-client/") ||
        file.startsWith("agent/opencode-bridge-client/") ||
        file.startsWith("agent/codex-bridge-client/"),
    )
    .sort(),
  bridgeClients.slice().sort(),
);
assert.deepEqual(
  [...files].filter((file) => file.startsWith("agent/harness-commands/")).sort(),
  harnessTemplates.slice().sort(),
);

const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const entry of manifest.pi.extensions) {
  assert.ok(files.has(entry.slice(2)), `missing extension: ${entry}`);
}

const expectedAgents = ["agent/agents/explorer.md", "agent/agents/worker.md"];
assert.deepEqual(
  [...files].filter((file) => file.startsWith("agent/agents/")).sort(),
  expectedAgents,
);
const expectedSkillRoots = [
  "animate", "animate-expo", "animation-performance", "animation-vocabulary", "apple-design", "ask-sonner",
  "break-ui", "emil-design-eng", "find-animation-opportunities", "grill", "grill-with-docs", "impeccable",
  "improve-animations", "mobile-native", "pick-ui-library", "playwright-cli", "prototype", "remove-animations",
  "review-animations", "web-debug", "web-design-guidelines", "worker-orchestration", "write-swift",
];
const derivedSkillRoots = [
  "animate", "animate-expo", "animation-performance", "animation-vocabulary", "apple-design", "ask-sonner",
  "break-ui", "emil-design-eng", "find-animation-opportunities", "improve-animations", "mobile-native",
  "pick-ui-library", "prototype", "remove-animations", "review-animations", "write-swift",
];
for (const skill of derivedSkillRoots) {
  const skillFile = `agent/skills/${skill}/SKILL.md`;
  assert.ok(files.has(skillFile), `missing derived skill: ${skillFile}`);
  const size = (await readFile(path.join(root, skillFile))).byteLength;
  assert.ok(size <= 12 * 1024, `derived SKILL.md exceeds 12 KiB: ${skillFile} (${size} bytes)`);
}
// Only nested `agent/skills/<name>/...` paths are skill roots; top-level files
// such as THIRD_PARTY_NOTICES.md ship as package assets, not skills.
assert.deepEqual(
  [...new Set([...files].flatMap((file) => file.match(/^agent\/skills\/([^/]+)\//)?.slice(1) ?? []))].sort(),
  expectedSkillRoots,
);
for (const file of [
  "agent/skills/THIRD_PARTY_NOTICES.md",
  "agent/skills/grill/SKILL.md",
  "agent/skills/grill-with-docs/SKILL.md",
  "agent/skills/impeccable/SKILL.md",
  "agent/skills/impeccable/references/critique.md",
  "agent/skills/impeccable/references/polish.md",
  "agent/skills/impeccable/references/audit.md",
  "agent/skills/impeccable/references/direction.md",
  "agent/skills/playwright-cli/SKILL.md",
  "agent/skills/web-design-guidelines/SKILL.md",
  "agent/skills/web-design-guidelines/references/guidelines.md",
  "agent/skills/worker-orchestration/SKILL.md",
  ...expectedAgents,
  "agent/extensions/workflow-modes/plan-template.md",
  ...bridgeClients,
  ...harnessTemplates,
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "agent/skills/web-debug/SKILL.md",
]) {
  assert.ok(files.has(file), `missing required asset: ${file}`);
}

const runtime = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test" && entry.name !== "node_modules") await walk(entryPath);
    } else if (entryPath.endsWith(".ts")) {
      runtime.push(path.relative(root, entryPath).replaceAll(path.sep, "/"));
    }
  }
}
await walk(path.join(root, "agent/extensions"));
for (const file of runtime) assert.ok(files.has(file), `missing runtime asset: ${file}`);

assert.ok(pack.size <= 512 * 1024, `packed size exceeds 512 KiB: ${pack.size}`);
assert.ok(pack.unpackedSize <= 2 * 1024 * 1024, `unpacked size exceeds 2 MiB: ${pack.unpackedSize}`);
console.log(`package check passed (${files.size} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes)`);
