import assert from "node:assert/strict";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const relative = (value) => path.join(root, value);
const extensions = [
  "agent/extensions/ccc-search/index.ts",
  "agent/extensions/claude-bridge/index.ts",
  "agent/extensions/discussion-notes.ts",
  "agent/extensions/engineering-docs/index.ts",
  "agent/extensions/filechanges/index.ts",
  "agent/extensions/notify.ts",
  "agent/extensions/personal-memory/index.ts",
  "agent/extensions/subagents/index.ts",
  "agent/extensions/workflow-modes/index.ts",
];
const skills = [
  "agent/skills/grill",
  "agent/skills/grill-with-docs",
  "agent/skills/worker-orchestration",
];
const agents = ["agent/agents/explorer.md", "agent/agents/worker.md"];
const publishedFiles = [
  "agent/extensions/ccc-search/index.ts",
  "agent/extensions/claude-bridge/index.ts",
  "agent/extensions/discussion-notes.ts",
  "agent/extensions/engineering-docs/*.ts",
  "agent/extensions/engineering-docs/README.md",
  "agent/extensions/filechanges/index.ts",
  "agent/extensions/filechanges/README.md",
  "agent/extensions/notify.ts",
  "agent/extensions/personal-memory/*.ts",
  "agent/extensions/subagents/*.ts",
  "agent/extensions/workflow-modes/*.ts",
  "agent/extensions/workflow-modes/plan-template.md",
  "agent/extensions/workflow-modes/README.md",
  "agent/agents/*.md",
  "agent/skills/**/*.md",
  "docs/engineering/**",
  "README.md",
  "LICENSE",
];

const manifest = JSON.parse(await readFile(relative("package.json"), "utf8"));
assert.equal(manifest.name, "@lopezpetergabriel/pi-extensions");
assert.equal(manifest.version, "0.2.3");
assert.equal(manifest.private, undefined);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.author, "lopezpetergabriel");
assert.equal(manifest.engines?.node, ">=22.19.0");
assert.deepEqual(manifest.publishConfig, { access: "public" });
assert.deepEqual(manifest.files, publishedFiles);
assert.deepEqual(manifest.dependencies, { diff: "^5.2.0" });
assert.deepEqual(manifest.peerDependencies, {
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
  typebox: "*",
});
assert.equal(manifest.scripts?.install, undefined);
assert.equal(manifest.scripts?.postinstall, undefined);
assert.equal(manifest.scripts?.prepublishOnly, "npm test");
assert.deepEqual(manifest.pi?.extensions, extensions.map((entry) => `./${entry}`));
assert.deepEqual(manifest.pi?.skills, skills.map((entry) => `./${entry}`));
for (const resource of [...extensions, ...skills, ...agents]) await access(relative(resource));

const agentsLink = relative(".pi/agents");
assert.ok((await lstat(agentsLink)).isSymbolicLink(), ".pi/agents must be an internal symlink");
assert.equal(await realpath(agentsLink), await realpath(relative("agent/agents")));

const workflowSource = await readFile(relative("agent/extensions/workflow-modes/index.ts"), "utf8");
assert.ok(workflowSource.includes("new URL(\"./plan-template.md\", import.meta.url)"));
assert.ok(!/\/(?:Users|home)\/[^/]+\/\.pi\//.test(workflowSource));
await access(relative("agent/extensions/workflow-modes/plan-template.md"));

console.log(`workspace check passed (${extensions.length} extensions, ${skills.length} skills, ${agents.length} agents)`);
