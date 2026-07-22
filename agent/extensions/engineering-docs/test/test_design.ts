import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesignDocs, initDesignDocs, updateDesignTokens } from "../filesystem.ts";
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
assert.equal(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["package.json"]}'), null, "non-CSS files cannot extend Design write scope");
assert.equal(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["src/app.ts"]}'), null, "source files cannot extend Design write scope");
assert.equal(parseDesignManifest('{"version":1,"kind":"design-docs","tokenFiles":["docs/engineering/tokens.css"]}'), null, "engineering docs cannot extend Design write scope");
assert.equal(parseDesignManifest("not json"), null);

const cwd = await mkdtemp(join(tmpdir(), "design-docs-"));
await mkdir(join(cwd, DESIGN_DIR), { recursive: true });
await writeFile(join(cwd, DESIGN_DIR, "manifest.json"), '{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}');
const manifest = await loadDesignManifest(cwd);
assert.ok(manifest);
assert.equal(await isDesignSurfacePath(cwd, "docs/design/components/button.md", manifest), true);
assert.equal(await isDesignSurfacePath(cwd, "src/tokens.css", manifest), true);
assert.equal(await isDesignSurfacePath(cwd, "src/app.ts", manifest), false);
assert.equal(await isDesignSurfacePath(cwd, "../outside.md", manifest), false);
assert.equal(await isDesignSurfacePath(cwd, "src/tokens.css", null), false);
const outside = await mkdtemp(join(tmpdir(), "design-outside-"));
await symlink(outside, join(cwd, DESIGN_DIR, "escape"));
assert.equal(await isDesignSurfacePath(cwd, "docs/design/escape/blocked.md", manifest), false, "design-root symlinks cannot escape write scope");
await mkdir(join(cwd, "src"), { recursive: true });
await writeFile(join(outside, "tokens.css"), "/* @primitive */ :root { --outside: red; }");
await symlink(join(outside, "tokens.css"), join(cwd, "src/tokens.css"));
assert.equal(await isDesignSurfacePath(cwd, "src/tokens.css", manifest), false, "declared token symlinks cannot escape write scope");

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
const darkClassParsed = parseCssTokens(`
/* @semantic */
.dark { --color-text: #111; }
.dark-header { --ignored: red; }
.darkmode { --also-ignored: red; }
`);
assert.deepEqual(darkClassParsed.tokens, [
	{ name: "--color-text", value: "#111", layer: "semantic", theme: "dark" },
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
const scaffoldReadme = await readFile(join(scaffoldRoot, "docs/design/README.md"), "utf8");
assert.match(scaffoldReadme, /\.dark/);
for (const file of ["index.html", "example.html"]) {
	const preview = await readFile(join(scaffoldRoot, "docs/design/preview", file), "utf8");
	assert.match(preview, /<button type="button" data-theme-toggle/);
	assert.match(preview, /root\.dataset\.theme/);
	assert.match(preview, /shadcn/);
}
assert.equal((await checkDesignDocs(scaffoldRoot)).previewViolations.length, 0, "scaffold previews pass lint");
await writeFile(join(scaffoldRoot, "docs/design/components/TEMPLATE.md"), "# Curated button\n");
const beforeRerun = await Promise.all(firstScaffold.created.map(file => readFile(join(scaffoldRoot, file), "utf8")));
const secondScaffold = await initDesignDocs(scaffoldRoot);
const afterRerun = await Promise.all(firstScaffold.created.map(file => readFile(join(scaffoldRoot, file), "utf8")));
assert.deepEqual(afterRerun, beforeRerun, "design scaffold rerun is byte-identical");
assert.equal(secondScaffold.created.length, 0);
assert.equal(await readFile(join(scaffoldRoot, "docs/design/components/TEMPLATE.md"), "utf8"), "# Curated button\n", "curated file remains untouched");
await mkdir(join(scaffoldRoot, "src"), { recursive: true });
await writeFile(join(scaffoldRoot, "src/tokens.css"), `/* @primitive */\n:root { --blue: #00f; }\n/* @semantic */\n:root { --action: var(--blue); }\n[data-theme="dark"] { --action: var(--blue); }\n`);
await writeFile(join(scaffoldRoot, "docs/design/manifest.json"), '{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}\n');
await updateDesignTokens(scaffoldRoot);
const generated = await readFile(join(scaffoldRoot, "docs/design/tokens.md"), "utf8");
assert.match(generated, /\| --action \| var\(--blue\) \| var\(--blue\) \|/);
assert.equal((await checkDesignDocs(scaffoldRoot)).tokensStale, false, "fresh token reference passes");
await writeFile(join(scaffoldRoot, "src/tokens.css"), "/* @primitive */\n:root { --blue: #0ff; }\n");
assert.equal((await checkDesignDocs(scaffoldRoot)).tokensStale, true, "token edits mark reference stale");
await writeFile(join(scaffoldRoot, "docs/design/preview/example.html"), '<style>.bad { color: #fff; margin: 8px; }</style>');
assert.equal((await checkDesignDocs(scaffoldRoot)).previewViolations.length, 1, "preview lint flags literal values");
await writeFile(join(scaffoldRoot, "docs/design/preview/example.html"), '<style>.ok { color: var(--action); }</style>');
assert.equal((await checkDesignDocs(scaffoldRoot)).previewViolations.length, 0, "preview lint accepts var-only values");

await rm(cwd, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });
await rm(scaffoldRoot, { recursive: true, force: true });
console.log("design assertions passed");
