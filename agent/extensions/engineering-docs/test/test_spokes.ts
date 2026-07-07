import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocs, generateSpokeBody, initDocs, mergeSpokeContent, writeSpokes } from "../filesystem.ts";

const body = generateSpokeBody();

assert.equal(mergeSpokeContent(null), body, "absent file becomes block-only");

const userContent = "# Hand written\nkeep me\n";
const appended = mergeSpokeContent(userContent);
assert.ok(appended.startsWith(`${userContent}\n`), "user content stays byte-for-byte before appended block");
assert.ok(appended.includes(body), "body appended to file without markers");
assert.equal(mergeSpokeContent(appended), appended, "append path is idempotent");

const oldBlock = "<!-- pi-docs:start (generated — edit docs/engineering/, not this block) -->\nold\n<!-- pi-docs:end -->\n";
const wrapped = `pre\n${oldBlock}post\n`;
const replaced = mergeSpokeContent(wrapped);
assert.equal(replaced, `pre\n${body}post\n`, "marker replace preserves surrounding content");
assert.equal(mergeSpokeContent(replaced), replaced, "replace path is idempotent");

const root = await mkdtemp(join(tmpdir(), "spokes-"));
const sourceAgents = fileURLToPath(new URL("../../../AGENTS.md", import.meta.url));
await cp(sourceAgents, join(root, "AGENTS.md"));
const beforeAgents = await readFile(join(root, "AGENTS.md"), "utf8");
assert.ok(!beforeAgents.includes("pi-docs:start"), "fixture must cover no-marker preservation path");

const first = await writeSpokes(root);
const afterAgents = await readFile(join(root, "AGENTS.md"), "utf8");
const expectedSeparator = beforeAgents.endsWith("\n") ? "\n" : "\n\n";
assert.ok(afterAgents.startsWith(beforeAgents + expectedSeparator), "copied AGENTS.md content preserved before block");
assert.ok(afterAgents.includes(body), "copied AGENTS.md got managed block");
assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), body, "absent CLAUDE.md is block-only");
assert.deepEqual(first, { written: ["AGENTS.md", "CLAUDE.md"], unchanged: [] });

const second = await writeSpokes(root);
assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), afterAgents, "AGENTS.md second run no-op");
assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), body, "CLAUDE.md second run no-op");
assert.deepEqual(second, { written: [], unchanged: ["AGENTS.md", "CLAUDE.md"] });

const initRoot = await mkdtemp(join(tmpdir(), "docs-init-spokes-"));
const initResult = await initDocs(initRoot);
assert.equal(await readFile(join(initRoot, "AGENTS.md"), "utf8"), body, "init creates AGENTS.md spoke");
assert.equal(await readFile(join(initRoot, "CLAUDE.md"), "utf8"), body, "init creates CLAUDE.md spoke");
assert.ok(initResult.manifest.generated.includes("AGENTS.md"), "manifest lists AGENTS.md spoke");
assert.ok(initResult.manifest.generated.includes("CLAUDE.md"), "manifest lists CLAUDE.md spoke");
assert.ok(initResult.created.includes("AGENTS.md"), "init reports AGENTS.md as written");
assert.ok(initResult.created.includes("CLAUDE.md"), "init reports CLAUDE.md as written");

const beforeRerun = await Promise.all([
	readFile(join(initRoot, "AGENTS.md"), "utf8"),
	readFile(join(initRoot, "CLAUDE.md"), "utf8"),
	readFile(join(initRoot, "docs/engineering/manifest.json"), "utf8"),
]);
const rerunResult = await initDocs(initRoot);
const afterRerun = await Promise.all([
	readFile(join(initRoot, "AGENTS.md"), "utf8"),
	readFile(join(initRoot, "CLAUDE.md"), "utf8"),
	readFile(join(initRoot, "docs/engineering/manifest.json"), "utf8"),
]);
assert.deepEqual(afterRerun, beforeRerun, "init rerun leaves spokes and manifest byte-identical");
assert.ok(rerunResult.skipped.includes("AGENTS.md"), "rerun reports unchanged AGENTS.md");
assert.ok(rerunResult.skipped.includes("CLAUDE.md"), "rerun reports unchanged CLAUDE.md");

await writeFile(join(initRoot, "AGENTS.md"), "# user content\n", "utf8");
const checkOnly = await checkDocs(initRoot);
assert.equal(checkOnly.spokes.find((spoke) => spoke.path === "AGENTS.md")?.hasBlock, false, "check detects missing spoke block");
assert.equal(await readFile(join(initRoot, "AGENTS.md"), "utf8"), "# user content\n", "check without repair does not write");

const repaired = await checkDocs(initRoot, { repairSpokes: true });
assert.deepEqual(repaired.spokesRepaired, ["AGENTS.md"], "repair reports rewritten spoke");
assert.ok(repaired.spokes.every((spoke) => spoke.healthy), "repair makes spokes healthy");
assert.ok((await readFile(join(initRoot, "AGENTS.md"), "utf8")).startsWith("# user content\n\n"), "repair preserves user content");

await rename(join(initRoot, "docs/engineering/invariants.md"), join(initRoot, "docs/engineering/invariants.md.bak"));
const deadLinkCheck = await checkDocs(initRoot, { repairSpokes: true });
assert.ok(deadLinkCheck.spokes.every((spoke) => spoke.deadLinks.includes("docs/engineering/invariants.md")), "check detects dead spoke doc link");
assert.equal(deadLinkCheck.spokesRepaired.length, 0, "dead link alone is not repaired by rewriting spokes");
