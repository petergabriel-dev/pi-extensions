import assert from "node:assert/strict";

import {
	buildCmuxCommandLine,
	CmuxTransport,
	parseCmuxSurfaceRef,
	shellPromptReady,
	shellQuote,
} from "../cmux.ts";

assert.equal(shellQuote("plain value"), "'plain value'");
assert.equal(shellQuote("a'b"), "'a'\\''b'");
assert.equal(buildCmuxCommandLine("pi", ["--print", "a b"], { PI_SUBAGENT_OWNER: "worker-one" }), "PI_SUBAGENT_OWNER='worker-one' 'pi' '--print' 'a b'");
assert.equal(parseCmuxSurfaceRef("surface:7\n"), "surface:7");
assert.equal(parseCmuxSurfaceRef('{"surface":"surface:8"}'), "surface:8");
assert.equal(shellPromptReady("starting\nuser@host %"), true);
assert.equal(shellPromptReady("starting\nloading"), false);

const calls: Array<{ command: string; args: readonly string[] }> = [];
const runner = async (command: string, args: readonly string[]) => {
	calls.push({ command, args });
	if (args[0] === "identify") return { stdout: "{}", stderr: "" };
	if (args[0] === "new-surface") return { stdout: "surface:7\n", stderr: "" };
	if (args[0] === "read-screen") return { stdout: "shell %", stderr: "" };
	return { stdout: "", stderr: "" };
};
const transport = new CmuxTransport({ command: "cmux-test", run: runner, commandTimeoutMs: 100, promptTimeoutMs: 100, promptPollMs: 1 });
const outcome = await transport.launch({ cwd: "/tmp/project", title: "worker", command: "pi", args: ["--print", "do work"], env: { PI_SUBAGENT_OWNER: "worker-one" } });
assert.equal(outcome.transport, "cmux");
const surface = outcome.surface;
assert.deepEqual(calls.map((call) => call.args[0]), ["identify", "new-surface", "rename-tab", "read-screen", "send"]);
assert.deepEqual(calls[1]?.args, ["new-surface", "--type", "terminal", "--working-directory", "/tmp/project", "--focus", "false"]);
assert.deepEqual(calls[2]?.args, ["rename-tab", "--surface", "surface:7", "--title", "worker"]);
assert.match(String(calls[4]?.args[3]), /PI_SUBAGENT_OWNER='worker-one'/);
assert.equal(String(calls[4]?.args[3]).endsWith("\n"), true);
assert.equal(await surface.readScreen(20), "shell %");
await surface.close();
assert.deepEqual(calls.at(-1)?.args, ["close-surface", "--surface", "surface:7"]);

const fallbackCalls: string[] = [];
const fallback = new CmuxTransport({
	command: "cmux-test",
	run: async (_command, args) => {
		fallbackCalls.push(args[0] ?? "");
		if (args[0] === "identify") throw new Error("socket refused");
		return { stdout: "", stderr: "" };
	},
});
const fallbackOutcome = await fallback.launch({ cwd: "/tmp", title: "worker", command: "pi", args: [], env: {} });
assert.equal(fallbackOutcome.transport, "headless");
assert.equal(fallbackOutcome.reason, "socket refused");
assert.deepEqual(fallbackCalls, ["identify"]);

const notReadyCalls: string[] = [];
const notReady = new CmuxTransport({
	command: "cmux-test",
	promptTimeoutMs: 5,
	promptPollMs: 1,
	run: async (_command, args) => {
		notReadyCalls.push(args[0] ?? "");
		if (args[0] === "identify") return { stdout: "{}", stderr: "" };
		if (args[0] === "new-surface") return { stdout: "surface:9", stderr: "" };
		return { stdout: "booting", stderr: "" };
	},
});
const notReadyOutcome = await notReady.launch({ cwd: "/tmp", title: "worker", command: "pi", args: [], env: {} });
assert.equal(notReadyOutcome.transport, "headless");
assert.match(notReadyOutcome.reason, /shell was not ready/);
assert.equal(notReadyCalls.includes("send"), false);
assert.equal(notReadyCalls.includes("send-key"), true);
assert.equal(notReadyCalls.at(-1), "close-surface");

let boundedReads = 0;
const bounded = new CmuxTransport({
	command: "cmux-test",
	run: async (_command, args) => {
		if (args[0] === "identify") return { stdout: "{}", stderr: "" };
		if (args[0] === "new-surface") return { stdout: "surface:10", stderr: "" };
		if (args[0] === "read-screen") return { stdout: boundedReads++ === 0 ? "shell %" : "x".repeat(20_000), stderr: "" };
		return { stdout: "", stderr: "" };
	},
});
const boundedOutcome = await bounded.launch({ cwd: "/tmp", title: "worker", command: "pi", args: [], env: { PI_SUBAGENT_TOKEN: "screen-secret" } });
assert.equal(boundedOutcome.transport, "cmux");
assert.ok(Buffer.byteLength(await boundedOutcome.surface.readScreen(), "utf8") <= 8 * 1024);
await boundedOutcome.surface.close();

let redactedReads = 0;
const redacted = new CmuxTransport({
	command: "cmux-test",
	run: async (_command, args) => {
		if (args[0] === "identify") return { stdout: "{}", stderr: "" };
		if (args[0] === "new-surface") return { stdout: "surface:11", stderr: "" };
		if (args[0] === "read-screen") return { stdout: redactedReads++ === 0 ? "shell %" : "token=screen-secret", stderr: "" };
		return { stdout: "", stderr: "" };
	},
});
const redactedOutcome = await redacted.launch({ cwd: "/tmp", title: "worker", command: "pi", args: [], env: { PI_SUBAGENT_TOKEN: "screen-secret" } });
assert.equal(redactedOutcome.transport, "cmux");
assert.equal(await redactedOutcome.surface.readScreen(), "token=[REDACTED]");
await redactedOutcome.surface.close();

console.log("cmux transport tests passed");
