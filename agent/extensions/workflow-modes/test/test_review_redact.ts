import assert from "node:assert/strict";
import { isSensitivePath, MAX_REDACT_INPUT_BYTES, REDACTED_ENV, REDACTED_PATTERN, redactText, secretEnvValues } from "../review-redact.js";

console.log("Running test_review_redact...");

const P = REDACTED_PATTERN;

// Env rule: secret-named values of length >= 8 are replaced everywhere.
{
	const env = { OPENAI_API_KEY: "abcd1234efgh5678", HOME: "/Users/someone/projects", SHORT_TOKEN: "abc", GIT_AUTHOR_NAME: "Jane Developer", SSH_AUTH_SOCK: "/tmp/agent.12345.sock" };
	const input = "key abcd1234efgh5678 again abcd1234efgh5678 home /Users/someone/projects abc by Jane Developer sock /tmp/agent.12345.sock";
	const result = redactText(input, env);
	assert.ok(!result.text.includes("abcd1234efgh5678"), "secret env value must be redacted");
	assert.equal(result.text.split(REDACTED_ENV).length - 1, 3, "two key hits plus AUTH-segment sock value");
	assert.ok(result.text.includes("/Users/someone/projects"), "non-secret env names are not redacted");
	assert.ok(result.text.includes(" abc "), "values shorter than 8 are not redacted");
	assert.ok(result.text.includes("Jane Developer"), "AUTHOR is not an AUTH segment");
	assert.equal(result.redactions, 3);
	assert.equal(result.truncated, false);
	assert.deepEqual(secretEnvValues({ A_KEY: "short", B_SECRET: "x".repeat(8), C_SECRET: "y".repeat(20) }), ["y".repeat(20), "x".repeat(8)], "longest secret first");
}

// Token shapes.
const patternCases: Array<[string, string, string]> = [
	["openai", "use sk-proj-ABCDEFGHIJKLMNOPQRST123 now", `use ${P} now`],
	["anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwx", P],
	["github classic", `token ghp_${"a1".repeat(18)} end`, `token ${P} end`],
	["github oauth", `gho_${"B2".repeat(18)}`, P],
	["github fine-grained", `github_pat_${"11ABCDEFG_".repeat(4)}`, P],
	["aws access key", "aws AKIAIOSFODNN7EXAMPLE id", `aws ${P} id`],
	["bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", `Authorization: Bearer ${P}`],
	["url credentials", "postgres://admin:hunter2pass@db:5432/app", `postgres://${P}@db:5432/app`],
	["env assignment", "DB_PASSWORD=hunter2 next", `DB_PASSWORD=${P} next`],
	["quoted assignment", "API_TOKEN='abc def ghi' x", `API_TOKEN=${P} x`],
	["cli flag assignment", "cli --api-key=xyz123 --verbose", `cli --api-key=${P} --verbose`],
	["json assignment", '{"apiKey": "abc123secret", "name": "demo"}', `{"apiKey": "${P}", "name": "demo"}`],
	["pem block", "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\nb", `a\n${P}\nb`],
	["unterminated pem", "x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r", `x\n${P}`],
];
for (const [name, input, expected] of patternCases) {
	const result = redactText(input);
	assert.equal(result.text, expected, `pattern case: ${name}`);
	assert.ok(result.redactions >= 1, `pattern case counts: ${name}`);
}

// Already-redacted env values are not counted twice by assignment rules.
{
	const result = redactText("OPENAI_API_KEY=abcd1234efgh5678 and postgres://u:abcd1234efgh5678@h/db", { OPENAI_API_KEY: "abcd1234efgh5678" });
	assert.equal(result.text, `OPENAI_API_KEY=${REDACTED_ENV} and postgres://u:${REDACTED_ENV}@h/db`);
	assert.equal(result.redactions, 2);
}

// False-positive guard: ordinary prose, config, and URLs stay unchanged.
{
	const benign = [
		"the key point is clear and the keyboard layout is fine",
		"tokens used: 1500; password policy requires 8 chars",
		"color=red size=10 mode=build",
		"https://example.com/path?q=1 and git@github.com:org/repo.git and ssh://git@github.com/org/repo",
		"uses Bearer authentication",
		"task-runner risk-assessment sk-learn",
		"npm test passed: 42 tests, 0 failures",
	].join("\n");
	const result = redactText(benign, { HOME: "/Users/someone" });
	assert.equal(result.text, benign, "benign text must not change");
	assert.equal(result.redactions, 0);
}

// Input cap: truncated at 256 KiB and a cut env secret prefix is masked.
{
	const secret = "SECRETVALUE-0123456789";
	const filler = "a".repeat(MAX_REDACT_INPUT_BYTES - 10);
	const result = redactText(filler + secret, { MY_SECRET: secret });
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_REDACT_INPUT_BYTES + REDACTED_ENV.length);
	assert.ok(result.text.endsWith(REDACTED_ENV), "partial secret at the cut is masked");
	assert.ok(!result.text.includes("SECRETVALU"), "no secret prefix survives truncation");
}

// Bounded work on adversarial input.
{
	const adversarial = [
		"a".repeat(MAX_REDACT_INPUT_BYTES),
		"Bearer ".repeat(30000),
		"x://" + ":".repeat(200000),
		"KEY".repeat(80000) + "=",
		"-----BEGIN PRIVATE KEY-----".repeat(9000),
		'"'.repeat(200000),
	];
	for (const input of adversarial) {
		const started = Date.now();
		redactText(input, { SOME_TOKEN: "zzzzzzzzzz" });
		assert.ok(Date.now() - started < 2000, `adversarial input finished quickly (${input.slice(0, 12)}...)`);
	}
}

// Sensitive paths.
for (const path of [".env", ".env.local", "config/.env.production", ".envrc", "certs/server.pem", "keys/app.KEY", "/home/u/.ssh/id_ed25519", "C:\\Users\\u\\.ssh\\id_rsa"]) {
	assert.equal(isSensitivePath(path), true, `sensitive: ${path}`);
}
for (const path of ["README.md", "src/keys.ts", "environment.ts", "docs/env.md", "src/identity.ts", ""]) {
	assert.equal(isSensitivePath(path), false, `not sensitive: ${path}`);
}

assert.throws(() => redactText(42 as unknown as string), TypeError);

console.log("test_review_redact passed");
