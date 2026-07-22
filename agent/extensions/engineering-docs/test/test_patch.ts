import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestDesignDrift } from "../design-drift.ts";

const cwd = await mkdtemp(join(tmpdir(), "design-patch-"));
await mkdir(join(cwd, "docs/design/components"), { recursive: true });
await writeFile(join(cwd, "docs/design/manifest.json"), '{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}');
await writeFile(join(cwd, "docs/design/components/Button.md"), "# Button\n");
const actions = await suggestDesignDrift(["src/tokens.css", "src/components/Button.tsx", "src/components/Missing.tsx"], cwd);
assert.match(actions.join("\n"), /update-tokens.*src\/tokens\.css/);
assert.match(actions.join("\n"), /Button\.tsx/);
assert.doesNotMatch(actions.join("\n"), /Missing\.tsx/);
await rm(cwd, { recursive: true, force: true });
console.log("patch assertions passed");
