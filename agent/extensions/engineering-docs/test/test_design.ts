import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

await rm(cwd, { recursive: true, force: true });
console.log("design assertions passed");
