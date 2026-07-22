import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDesignDocs } from "../filesystem.ts";
import {
	DESIGN_DIR,
	MAX_TOKEN_FILE_BYTES,
	isDesignSurfacePath,
	loadDesignManifest,
	parseCssTokens,
	parseDesignManifest,
} from "../design.ts";

assert.deepEqual(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}'), {
	version: 1,
	kind: "design-docs",
	tokenFiles: ["src/tokens.css"],
});
assert.equal(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["../escape.css"]}'), null);
assert.equal(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["/escape.css"]}'), null);
assert.equal(parseDesignManifest("not json"), null);

const cwd = await mkdtemp(join(tmpdir(), "design-docs-"));
await mkdir(join(cwd, DESIGN_DIR), { recursive: true });
await writeFile(join(cwd, DESIGN_DIR, "manifest.json"), '{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}');
const manifest = await loadDesignManifest(cwd);
assert.ok(manifest);
assert.equal(isDesignSurfacePath(cwd, "docs/design/components/button.md", manifest), true);
assert.equal(isDesignSurfacePath(cwd, "src/tokens.css", manifest), true);
assert.equal(isDesignSurfacePath(cwd, "src/app.ts", manifest), false);
assert.equal(isDesignSurfacePath(cwd, "../outside.md", manifest), false);
assert.equal(isDesignSurfacePath(cwd, "src/tokens.css", null), false);

const parsed = parseCssTokens(`
/* @primitive */
:root { --color-blue: #00f; }
/* @semantic */
:root { --color-text: var(--color-blue); }
[data-theme="dark"] { --color-text: #fff; }
`);
assert.deepEqual(parsed.tokens, [
	{ name: "--color-blue", value: "#00f", layer: "primitive", theme: "light" },
	{ name: "--color-text", value: "var(--color-blue)", layer: "semantic", theme: "light" },
	{ name: "--color-text", value: "#fff", layer: "semantic", theme: "dark" },
]);
assert.equal(parseCssTokens(":root { --unmarked: red; }").warnings.length, 1);
assert.match(parseCssTokens("/* @primitive */ :root { --bad: red;").warnings[0] ?? "", /Unclosed/);
assert.match(parseCssTokens("x".repeat(MAX_TOKEN_FILE_BYTES + 1)).warnings[0] ?? "", /exceeds/);

const scaffoldRoot = await mkdtemp(join(tmpdir(), "design-scaffold-"));
const firstScaffold = await initDesignDocs(scaffoldRoot);
assert.deepEqual(firstScaffold.created, [
	"docs/design/manifest.json",
	"docs/design/README.md",
	"docs/design/components/TEMPLATE.md",
	"docs/design/preview/index.html",
	"docs/design/preview/example.html",
]);
await writeFile(join(scaffoldRoot, "docs/design/components/TEMPLATE.md"), "# Curated button\n");
const beforeRerun = await Promise.all(firstScaffold.created.map(file => readFile(join(scaffoldRoot, file), "utf8")));
const secondScaffold = await initDesignDocs(scaffoldRoot);
const afterRerun = await Promise.all(firstScaffold.created.map(file => readFile(join(scaffoldRoot, file), "utf8")));
assert.deepEqual(afterRerun, beforeRerun, "design scaffold rerun is byte-identical");
assert.equal(secondScaffold.created.length, 0);
assert.equal(await readFile(join(scaffoldRoot, "docs/design/components/TEMPLATE.md"), "utf8"), "# Curated button\n", "curated file remains untouched");

await rm(cwd, { recursive: true, force: true });
await rm(scaffoldRoot, { recursive: true, force: true });
console.log("design assertions passed");
