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

console.log("test_policy passed!");
