import assert from "node:assert/strict";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const relative = (value) => path.join(root, value);
const extensions = [
  "agent/extensions/browser/index.ts",
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

const HOST_PACKAGE_LITERAL = /["'`](?:@earendil-works\/pi-|@mariozechner\/pi-)[^"'`]*["'`]/;
const VARIABLE_NAME = /[A-Za-z_$][\w$]*/;

function hasVariableHostImport(source) {
  for (const match of source.matchAll(new RegExp(`\\bimport\\s*\\(\\s*(${VARIABLE_NAME.source})\\s*\\)`, "g"))) {
    const variable = match[1];
    const beforeImport = source.slice(0, match.index);
    const binding = new RegExp(
      `(?:\\b(?:const|let|var)\\s+${variable}\\s*=\\s*|\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${variable}\\s+of\\s*)`,
      "g",
    );
    for (const bound of beforeImport.matchAll(binding)) {
      const expressionStart = (bound.index ?? 0) + bound[0].length;
      if (HOST_PACKAGE_LITERAL.test(source.slice(expressionStart, match.index))) return true;
    }
  }
  return false;
}

const agents = ["agent/agents/explorer.md", "agent/agents/worker.md"];
const publishedFiles = [
  "agent/extensions/browser/index.ts",
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
assert.equal(manifest.version, "0.3.0");
assert.equal(manifest.private, undefined);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.author, "lopezpetergabriel");
assert.equal(manifest.engines?.node, ">=22.19.0");
assert.deepEqual(manifest.publishConfig, { access: "public" });
assert.deepEqual(manifest.files, publishedFiles);
assert.deepEqual(manifest.dependencies, { diff: "^5.2.0", "playwright-core": "^1.62.1" });
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

const extensionSources = await Promise.all(
  extensions.map(async (file) => ({ file, source: await readFile(relative(file), "utf8") })),
);
for (const { file, source } of extensionSources) {
  assert.ok(!/\bcreateRequire\b/.test(source), `forbidden createRequire in ${file}`);
  assert.ok(!hasVariableHostImport(source), `forbidden variable-specifier Pi host import in ${file}`);
}

const modeSites = [["agent/extensions/workflow-modes/index.ts", /export type Mode = ([^;]+);/],
  ["agent/extensions/workflow-modes/caveman.ts", /export type CavemanWorkflowMode = ([^;]+);/],
  ["agent/extensions/engineering-docs/constants.ts", /export type WorkflowMode = ([^;]+);/],
  ["agent/extensions/subagents/index.ts", /type WorkflowMode = ([^;]+);/],
  ["agent/extensions/subagents/index.ts", /function isWorkflowMode\([^)]*\)[^{]*\{\s*return ([^;]+);/]];
const parsedModeSites = await Promise.all(modeSites.map(async ([file, pattern]) => {
  const match = (await readFile(relative(file), "utf8")).match(pattern);
  assert.ok(match?.[1], `workflow mode site not found in ${file}`);
  const modes = [...new Set([...match[1].matchAll(/"([^"]+)"/g)].map((literal) => literal[1]))].sort();
  assert.ok(modes.length > 0, `workflow modes not parsed in ${file}`);
  return { file, modes };
}));
for (const site of parsedModeSites.slice(1)) assert.deepEqual(site.modes, parsedModeSites[0].modes, `workflow mode union drift: ${site.file} vs ${parsedModeSites[0].file}`);

const agentsLink = relative(".pi/agents");
assert.ok((await lstat(agentsLink)).isSymbolicLink(), ".pi/agents must be an internal symlink");
assert.equal(await realpath(agentsLink), await realpath(relative("agent/agents")));

const workflowSource = await readFile(relative("agent/extensions/workflow-modes/index.ts"), "utf8");
assert.ok(workflowSource.includes("new URL(\"./plan-template.md\", import.meta.url)"));
assert.ok(!/\/(?:Users|home)\/[^/]+\/\.pi\//.test(workflowSource));
await access(relative("agent/extensions/workflow-modes/plan-template.md"));

console.log(`workspace check passed (${extensions.length} extensions, ${skills.length} skills, ${agents.length} agents)`);
