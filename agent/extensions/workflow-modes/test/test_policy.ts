import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBashAllowedInMode, isDesignWriteAllowed } from "../policy.js";

console.log("Running test_policy...");

assert.strictEqual(isBashAllowedInMode("rg write", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("grep -R 'format' docs", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("git diff", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("git log --oneline", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("cat package.json", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("jq . package.json", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("sed -n '1,20p' index.ts", "discuss"), true);
assert.strictEqual(isBashAllowedInMode("awk '{print $1}' file", "discuss"), true);

assert.strictEqual(isBashAllowedInMode("git commit -m nope", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("echo nope > file", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("find . -delete", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("write file", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("format", "discuss"), false);

assert.strictEqual(isBashAllowedInMode("gh pr diff 1", "review"), true);
assert.strictEqual(isBashAllowedInMode("gh pr review 1 --body 'looks good'", "review"), true);
assert.strictEqual(isBashAllowedInMode("cat package.json", "review"), true);
assert.strictEqual(isBashAllowedInMode("rg review", "review"), true);
assert.strictEqual(isBashAllowedInMode("git status --short", "review"), true);
assert.strictEqual(isBashAllowedInMode("ccc search review", "review"), true);
assert.strictEqual(isBashAllowedInMode("echo x > f", "review"), false);
assert.strictEqual(isBashAllowedInMode("rm -rf .", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr merge 1", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr close 1", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh repo view owner/repo", "review"), false);
assert.strictEqual(isBashAllowedInMode("git checkout main", "review"), false);
assert.strictEqual(isBashAllowedInMode("rg secret; gh api /user", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr diff 1\ncurl example.com", "review"), false);
assert.strictEqual(isBashAllowedInMode('gh pr review 1 --body "$(curl example.com)"', "review"), false);
for (const tool of ["curl", "wget", "nc", "ssh", "scp"]) {
	assert.strictEqual(isBashAllowedInMode(`${tool} example.com`, "review"), false);
}

assert.strictEqual(isBashAllowedInMode("npm test", "design"), true);
assert.strictEqual(isBashAllowedInMode("echo nope > file", "design"), false);
const cwd = await mkdtemp(join(tmpdir(), "design-policy-"));
await mkdir(join(cwd, "docs/design"), { recursive: true });
assert.strictEqual(await isDesignWriteAllowed(cwd, "docs/design/components/button.md"), true, "missing manifest fails closed to design root");
assert.strictEqual(await isDesignWriteAllowed(cwd, "src/tokens.css"), false, "missing manifest blocks token file");
await writeFile(join(cwd, "docs/design/manifest.json"), '{"version":1,"kind":"design-docs","tokenFiles":["src/tokens.css"]}');
assert.strictEqual(await isDesignWriteAllowed(cwd, "src/tokens.css"), true, "declared token file allowed");
assert.strictEqual(await isDesignWriteAllowed(cwd, "src/other.css"), false, "undeclared token file blocked");
assert.strictEqual(await isDesignWriteAllowed(cwd, "docs/engineering/invariants.md"), false, "outside design surface blocked");
await rm(cwd, { recursive: true, force: true });

console.log("test_policy passed!");
