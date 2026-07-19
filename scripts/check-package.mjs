import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
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
  /^agent\/extensions\/(?:[^/]+\/)?[^/]+\.ts$/.test(file) ||
  file === "agent/extensions/engineering-docs/README.md" ||
  file === "agent/extensions/filechanges/README.md" ||
  file === "agent/extensions/workflow-modes/plan-template.md" ||
  /^agent\/agents\/[^/]+\.md$/.test(file) ||
  /^agent\/skills\/.*\.md$/.test(file) ||
  file.startsWith("docs/engineering/");

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
  const segments = file.split("/");
  assert.ok(!segments.some((segment) => forbiddenSegments.has(segment)), `forbidden package path: ${file}`);
  assert.ok(file === "package.json" || path.posix.basename(file) !== "package.json", `nested package manifest: ${file}`);
  assert.ok(!forbiddenFile.test(path.posix.basename(file)), `forbidden package file: ${file}`);
  assert.ok(isAllowed(file), `file outside package allowlist: ${file}`);
}

const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const entry of manifest.pi.extensions) {
  assert.ok(files.has(entry.slice(2)), `missing extension: ${entry}`);
}

const expectedAgents = ["agent/agents/explorer.md", "agent/agents/worker.md"];
assert.deepEqual(
  [...files].filter((file) => file.startsWith("agent/agents/")).sort(),
  expectedAgents,
);
const expectedSkillRoots = ["grill", "grill-with-docs", "worker-orchestration"];
assert.deepEqual(
  [...new Set([...files].flatMap((file) => file.match(/^agent\/skills\/([^/]+)\//)?.slice(1) ?? []))].sort(),
  expectedSkillRoots,
);
for (const file of [
  "agent/skills/grill/SKILL.md",
  "agent/skills/grill-with-docs/SKILL.md",
  "agent/skills/worker-orchestration/SKILL.md",
  ...expectedAgents,
  "agent/extensions/workflow-modes/plan-template.md",
  "docs/engineering/manifest.json",
  "README.md",
  "LICENSE",
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
assert.ok(pack.unpackedSize <= 1024 * 1024, `unpacked size exceeds 1 MiB: ${pack.unpackedSize}`);
console.log(`package check passed (${files.size} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes)`);
