#!/usr/bin/env node
/* Core protocol tests for Pi ↔ Claude Code bridge. Zero Pi imports. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

const TIMEOUT_MS = 2_000;
const POLL_MS = 50;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function bridgeRoot(projectRoot) { return path.join(projectRoot, ".pi", "memory", "bridge"); }
function paths(projectRoot) {
	const root = bridgeRoot(projectRoot);
	return { root, requests: path.join(root, "requests"), responses: path.join(root, "responses"), processed: path.join(root, "processed"), policy: path.join(root, "policy.json"), session: path.join(root, "session.json") };
}
async function waitFor(file, timeoutMs = TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exists(file)) return true;
		await sleep(POLL_MS);
	}
	return false;
}
async function sendRequest(projectRoot, type, payload, id = crypto.randomUUID()) {
	const p = paths(projectRoot);
	const res = path.join(p.responses, `${id}.json`);
	writeJson(path.join(p.requests, `${id}.json`), { id, type, payload, ts: Date.now() });
	if (!(await waitFor(res))) throw new Error(`No response for ${type} within ${TIMEOUT_MS}ms`);
	return { id, response: readJson(res), responsePath: res };
}
function runHook(input, cwd) {
	const hook = path.resolve(__dirname, "pi-readonly-hook.js");
	const out = cp.spawnSync("node", [hook], { input: JSON.stringify(input), cwd, encoding: "utf8" });
	if (out.status !== 0) throw new Error(out.stderr || `hook exit ${out.status}`);
	return JSON.parse(out.stdout || "{}");
}
function denied(result) { return result.hookSpecificOutput?.permissionDecision === "deny"; }
function updatedInput(result) { return result.hookSpecificOutput?.updatedInput; }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function freshTarget(projectRoot) {
	const p = paths(projectRoot);
	assert(exists(p.session), `Missing bridge session: ${p.session}`);
	assert(exists(p.policy), `Missing bridge policy: ${p.policy}`);
	const session = readJson(p.session);
	const heartbeat = Date.parse(session.heartbeatAt || "");
	assert(session.status === "active" && Number.isFinite(heartbeat) && Date.now() - heartbeat <= 5_000, "Bridge session stale/not active");
	return { p, session };
}

function makeTempPiProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hook-test-"));
	fs.mkdirSync(path.join(root, ".pi", "memory", "bridge"), { recursive: true });
	return root;
}

test("bridge active dirs, session, policy", async ({ projectRoot }) => {
	const { p, session } = freshTarget(projectRoot);
	for (const key of ["requests", "responses", "processed"]) assert(exists(p[key]), `Missing ${key}`);
	const policy = readJson(p.policy);
	assert(policy.policy?.planBashAllow, "policy missing planBashAllow");
	assert(session.bridgeSessionId, "session missing bridgeSessionId");
});

test("malformed/invalid request returns error", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const p = paths(projectRoot);
	writeJson(path.join(p.requests, `${id}.json`), { id, type: "bad_type", payload: {}, ts: Date.now() });
	const res = path.join(p.responses, `${id}.json`);
	assert(await waitFor(res), "No invalid request response");
	const response = readJson(res);
	assert(response.ok === false, "Invalid request should fail");
	assert(response.error?.code === "invalid_request", `Unexpected error code ${response.error?.code}`);
});

test("recall returns memory/prompts shape", async ({ projectRoot }) => {
	const { response } = await sendRequest(projectRoot, "recall", { query: "bridge", mode: "plan" });
	assert(response.ok === true, `recall failed: ${JSON.stringify(response)}`);
	assert(response.result?.memory, "recall missing memory");
	assert(response.result?.prompts?.planPrompt, "recall missing plan prompt");
});

test("validate_tags valid and invalid", async ({ projectRoot }) => {
	const good = await sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS:architecture] ok\n- [ ] [DOCS:decisions][ADR:new] adr" });
	assert(good.response.ok && good.response.result.valid === true, "valid tags not valid");
	const bad = await sendRequest(projectRoot, "validate_tags", { planText: "- [ ] [DOCS] bad\n- [ ] [DOCS:decisions] missing" });
	assert(bad.response.ok && bad.response.result.valid === false, "invalid tags not invalid");
	assert(bad.response.result.invalid.length >= 2, "invalid tag details missing");
});

test("capture writes note/staging and duplicate id is stable", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const text = `Core protocol capture ${id}`;
	const first = await sendRequest(projectRoot, "capture", { claudeSessionId: `core-${id}`, context: "core protocol", notes: [{ type: "implementation", text }] }, id);
	assert(first.response.ok, `capture failed: ${JSON.stringify(first.response)}`);
	assert(first.response.result.widgetUpdated === true, "capture did not report widget update");
	const staging = first.response.result.stagingFile;
	assert(exists(staging), "staging file missing");
	const before = fs.readFileSync(staging, "utf8");
	assert(before.includes(id) && before.includes(text), "staging missing request/text");
	fs.unlinkSync(first.responsePath);
	const second = await sendRequest(projectRoot, "capture", { claudeSessionId: `core-${id}`, notes: [{ type: "implementation", text: "DUPLICATE SHOULD NOT APPLY" }] }, id);
	assert(JSON.stringify(second.response) === JSON.stringify(first.response), "duplicate capture response changed");
	assert(fs.readFileSync(staging, "utf8") === before, "duplicate capture changed staging");
});

test("save_plan is visible through recall duplicate response stable", async ({ projectRoot }) => {
	const id = crypto.randomUUID();
	const planText = `# Core Protocol Saved Plan ${id}\n\n## Section 4 — Tasks\n- [ ] Core protocol save visible`;
	const first = await sendRequest(projectRoot, "save_plan", { planText, planId: `core-${id}`, confirmed: true }, id);
	assert(first.response.ok, `save_plan failed: ${JSON.stringify(first.response)}`);
	assert(first.response.result.planId === `core-${id}`, "planId mismatch");
	fs.unlinkSync(first.responsePath);
	const second = await sendRequest(projectRoot, "save_plan", { planText: "DIFFERENT", confirmed: true }, id);
	assert(JSON.stringify(second.response) === JSON.stringify(first.response), "duplicate save response changed");
});

test("MCP client fails loudly when bridge down", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-down-"));
	fs.mkdirSync(path.join(tmp, ".pi", "memory", "bridge", "requests"), { recursive: true });
	fs.mkdirSync(path.join(tmp, ".pi", "memory", "bridge", "responses"), { recursive: true });
	const mcp = path.resolve(__dirname, "pi-bridge-mcp.js");
	const out = cp.spawnSync("node", [mcp, "request", "recall", JSON.stringify({ query: "x" }), tmp], { encoding: "utf8" });
	assert(out.status !== 0, "bridge-down request should fail");
	assert((out.stderr + out.stdout).includes("Pi bridge not responding; start/focus Pi in this project."), "missing loud bridge-down message");
});

test("read-only hook allows non-Pi and enforces Pi policy", async ({ projectRoot }) => {
	freshTarget(projectRoot);
	const nonPi = fs.mkdtempSync(path.join(os.tmpdir(), "nonpi-"));
	assert(!denied(runHook({ tool_name: "Edit", tool_input: {} }, nonPi)), "non-Pi Edit denied");
	assert(denied(runHook({ tool_name: "Edit", tool_input: {} }, projectRoot)), "Pi Edit not denied");
	const rg = runHook({ tool_name: "Bash", tool_input: { command: "rg bridge" } }, projectRoot);
	assert(!denied(rg), "Pi rg denied");
	if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
		assert(updatedInput(rg)?.command?.includes("/usr/bin/sandbox-exec"), "Pi rg was not sandbox-wrapped");
	}
	assert(!denied(runHook({ tool_name: "Bash", tool_input: { command: "pytest" } }, projectRoot)), "Pi pytest denied");
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, projectRoot)), "Pi git commit not denied");
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "rg bridge", dangerouslyDisableSandbox: true } }, projectRoot)), "Pi sandbox-disable flag not denied");
	const stale = makeTempPiProject();
	assert(denied(runHook({ tool_name: "Bash", tool_input: { command: "rg x" } }, stale)), "missing policy did not deny");
});

async function main() {
	const projectRoot = path.resolve(process.argv[2] || process.cwd());
	const context = { projectRoot };
	let passed = 0;
	const failures = [];
	for (const t of tests) {
		try {
			await t.fn(context);
			passed++;
			console.log(`PASS ${t.name}`);
		} catch (error) {
			failures.push({ name: t.name, error: error.message });
			console.log(`FAIL ${t.name}: ${error.message}`);
		}
	}
	console.log(`\n${passed}/${tests.length} passed`);
	if (failures.length) {
		console.log(JSON.stringify({ failures }, null, 2));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error.stack || error.message || String(error));
	process.exit(1);
});
