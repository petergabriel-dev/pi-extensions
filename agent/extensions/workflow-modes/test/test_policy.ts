import assert from "node:assert";
import { isBashAllowedInMode } from "../policy.js";

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
assert.strictEqual(isBashAllowedInMode("git status --short", "review"), true);
assert.strictEqual(isBashAllowedInMode("ccc search review", "review"), true);
assert.strictEqual(isBashAllowedInMode("echo x > f", "review"), false);
assert.strictEqual(isBashAllowedInMode("rm -rf .", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr merge 1", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr close 1", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh repo view owner/repo", "review"), false);
assert.strictEqual(isBashAllowedInMode("rg secret; gh api /user", "review"), false);
assert.strictEqual(isBashAllowedInMode("gh pr diff 1\ncurl example.com", "review"), false);
assert.strictEqual(isBashAllowedInMode('gh pr review 1 --body "$(curl example.com)"', "review"), false);
for (const tool of ["curl", "wget", "nc", "ssh", "scp"]) {
	assert.strictEqual(isBashAllowedInMode(`${tool} example.com`, "review"), false);
}

console.log("test_policy passed!");
