import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmReviewPost, getBuildGuardBlocker, isBashAllowedInMode, isDesignWriteAllowed, isReviewPostingCommand, sanitizeReviewCommand } from "../policy.js";

console.log("Running test_policy...");

assert.strictEqual(getBuildGuardBlocker((payload) => { payload.blockedBy = "cursor:holder"; }), "cursor:holder");
assert.strictEqual(getBuildGuardBlocker(() => {}), undefined);
assert.strictEqual(getBuildGuardBlocker((payload) => {
	payload.blockedBy = "cursor:holder";
	throw new Error("listener failed");
}), undefined);

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
assert.strictEqual(isBashAllowedInMode("ls > file", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("ls >> file", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("find . -delete", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("find . -exec touch x \\;", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("ls | xargs touch x", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("git diff --output=out.patch", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("git apply test.patch", "plan"), false);
assert.strictEqual(isBashAllowedInMode("git config corpus.test value", "plan"), false);
assert.strictEqual(isBashAllowedInMode("awk 'BEGIN{system(\"touch x\")}'", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("ls `touch x`", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("ls $(touch x)", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("write file", "discuss"), false);
assert.strictEqual(isBashAllowedInMode("format", "discuss"), false);

assert.strictEqual(isBashAllowedInMode("gh pr view 1", "review"), true);
assert.strictEqual(isBashAllowedInMode("gh pr diff 1", "review"), true);
assert.strictEqual(isBashAllowedInMode("gh pr review 1 --body 'looks good'", "review"), true);
assert.strictEqual(isBashAllowedInMode("gh pr comment 1 --body 'looks good'", "review"), true);
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

assert.strictEqual(isReviewPostingCommand("gh  pr\treview 1"), true, "posting detector accepts allow-list spacing");
assert.strictEqual(isReviewPostingCommand("gh\tpr  comment 1"), true, "comment posting is detected");
for (const command of ["gh pr review\n", "gh pr comment\r\n", " gh pr review\t"]) {
	assert.strictEqual(isBashAllowedInMode(command, "review"), true);
	assert.strictEqual(await confirmReviewPost(command, false, { confirm: async () => assert.fail("headless confirmation must not run") }), false, "trailing whitespace cannot bypass posting approval");
}
for (const command of ["gh pr view 1", "gh pr diff 1", "gh pr list"]) {
	assert.strictEqual(isReviewPostingCommand(command), false, `${command} does not post`);
}

const confirmationCalls: Array<{ title: string; message?: string }> = [];
const approvingUI = {
	async confirm(title: string, message?: string): Promise<boolean> {
		confirmationCalls.push({ title, message });
		return true;
	},
};
const originalPost = "  gh  pr\treview 42 --body '\u001b\r\u202e'  ";
assert.strictEqual(await confirmReviewPost(originalPost, true, approvingUI), true, "literal approval allows post");
assert.deepStrictEqual(confirmationCalls.at(-1), {
	title: "Post this GitHub review?",
	message: "  gh  pr\\x09review 42 --body '\\x1B\\x0D\\u202E'  ",
}, "confirm message is exact sanitized original command");

const callCountAfterApproval = confirmationCalls.length;
for (const command of ["gh pr view 42", "gh pr diff 42"]) {
	assert.strictEqual(await confirmReviewPost(command, false, approvingUI), true, `${command} remains untouched without UI`);
}
assert.strictEqual(confirmationCalls.length, callCountAfterApproval, "view and diff never prompt");
assert.strictEqual(await confirmReviewPost("gh pr review 42", true, { confirm: async () => false }), false, "decline blocks post");
assert.strictEqual(await confirmReviewPost("gh pr review 42", false, approvingUI), false, "headless UI blocks post");
assert.strictEqual(confirmationCalls.length, callCountAfterApproval, "no UI does not prompt");
assert.strictEqual(await confirmReviewPost("gh pr review 42", true, { confirm: async () => { throw new Error("dismissed"); } }), false, "confirmation failure blocks post");
assert.strictEqual(await confirmReviewPost("gh pr review 42", true, { confirm: async () => "yes" as unknown as boolean }), false, "only literal true approves post");
assert.strictEqual(await confirmReviewPost("gh pr review 42", true, undefined), false, "missing UI blocks post");

let repeatedCalls = 0;
const repeatedUI = { confirm: async () => { repeatedCalls += 1; return true; } };
assert.strictEqual(await confirmReviewPost("gh pr comment 42", true, repeatedUI), true);
assert.strictEqual(await confirmReviewPost("gh pr comment 42", true, repeatedUI), true);
assert.strictEqual(repeatedCalls, 2, "each posting command requires fresh approval");
assert.strictEqual(confirmationCalls.length, callCountAfterApproval, "other UI calls remain isolated");

const sanitizedCodes = [
	...Array.from({ length: 0x20 }, (_, index) => index).filter((code) => code !== 0x0a),
	...Array.from({ length: 0x21 }, (_, index) => index + 0x7f),
	...Array.from({ length: 5 }, (_, index) => index + 0x202a),
	...Array.from({ length: 4 }, (_, index) => index + 0x2066),
];
const rawControls = sanitizedCodes.map((code) => String.fromCodePoint(code)).join("");
const expectedEscapes = sanitizedCodes.map((code) => code <= 0xff
	? `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`
	: `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`).join("");
assert.strictEqual(sanitizeReviewCommand(rawControls), expectedEscapes, "all required control and bidi ranges are visible");
assert.strictEqual(sanitizeReviewCommand("line1\nline2"), "line1\nline2", "newline remains newline");
assert.strictEqual(sanitizeReviewCommand(`gh pr review ${"x".repeat(10_000)}`).length, 10_013, "sanitizer never truncates");
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
