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

const manifest = JSON.parse(await readFile(relative("package.json"), "utf8"));
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
