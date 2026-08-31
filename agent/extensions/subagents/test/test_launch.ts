import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { mock } from "node:test";

import { CAVEMAN_PROMPT } from "../../workflow-modes/caveman.ts";
import { CmuxTransport } from "../cmux.ts";
import { SubagentIpcClient } from "../ipc.ts";
import {
	buildSubagentCommandArgs,
	buildSubagentSystemPrompt,
	MAX_SUBAGENT_RESULT_BYTES,
	readSubagentLoadout,
	resolveSubagentExtensionPath,
	SubagentLaunchHost,
	truncateSubagentResult,
	type SubagentLoadout,
} from "../launch.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-launch-"));
const captured: { command?: string; args?: string[]; options?: SpawnOptions } = {};
const childScript = `
const net = require("node:net");
let buffer = Buffer.alloc(0);
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
const read = (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    if (response.kind !== "response") continue;
    if (response.requestId === "hello") {
      socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "result", owner: process.env.PI_SUBAGENT_OWNER, type: "result", payload: { childSessionId: process.env.PI_SUBAGENT_CHILD_SESSION_ID, text: "child result", sessionFile: "/tmp/child-session.jsonl" } }));
    } else if (response.requestId === "result") {
      socket.end();
    }
  }
};
socket.on("connect", () => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "hello", owner: process.env.PI_SUBAGENT_OWNER, type: "hello", payload: { pid: process.pid } })));
socket.on("data", read);
`;
const disconnectScript = `
const net = require("node:net");
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
process.stderr.write("sentinel stderr " + process.env.PI_SUBAGENT_TOKEN + "\\n");
socket.on("connect", () => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "hello", owner: process.env.PI_SUBAGENT_OWNER, type: "hello", payload: { pid: process.pid } })));
socket.on("data", () => { socket.destroy(); setTimeout(() => process.exit(0), 10); });
`;
const hangingScript = `setInterval(() => {}, 1000);`;
let hangingProcess: ReturnType<typeof spawn> | undefined;

function fakeSpawn(command: string, args: readonly string[], options: SpawnOptions) {
	captured.command = command;
	captured.args = [...args];
	captured.options = options;
	return spawn(process.execPath, ["-e", childScript], options);
}

const loadout: SubagentLoadout = {
	version: 1,
	parentSessionId: "parent-session",
	childSessionId: "child-session",
	owner: "worker-one",
	role: "worker",
	agentName: "worker",
	cwd: process.cwd(),
	extensionPath: resolveSubagentExtensionPath(),
	tools: ["read", "grep"],
	model: "openai/test-model",
	thinkingLevel: "high",
	appendSystemPrompt: buildSubagentSystemPrompt("Agent rules", true),
	cavemanEnabled: true,
	depth: 0,
	createdAt: new Date().toISOString(),
};

try {
	assert.ok(loadout.appendSystemPrompt.includes(CAVEMAN_PROMPT.trim()));
	assert.equal(buildSubagentSystemPrompt("Agent rules", false), "Agent rules");
	assert.ok(Buffer.byteLength(truncateSubagentResult("x".repeat(MAX_SUBAGENT_RESULT_BYTES + 100)), "utf8") <= MAX_SUBAGENT_RESULT_BYTES);
	assert.deepEqual(buildSubagentCommandArgs(loadout, "do work"), [
		"--no-extensions", "-e", loadout.extensionPath, "--tools", "read,grep",
		"--append-system-prompt", loadout.appendSystemPrompt, "--session-id", "child-session",
		"--no-approve", "--model", "openai/test-model", "--thinking", "high", "--", "do work",
	]);
	assert.equal(buildSubagentCommandArgs(loadout, "do work").includes("--print"), false);

	const steered: string[] = [];
	const host = new SubagentLaunchHost({
		parentSessionId: "parent-session",
		agentDir: tempDir,
		command: "pi",
		spawnProcess: fakeSpawn,
		cmux: false,
	});
	const handle = await host.launch({
		parentSessionId: "parent-session",
		owner: "worker-one",
		role: "worker",
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "do work",
		tools: ["read", "grep"],
		cavemanEnabled: true,
		depth: 0,
		subagentAgents: ["explorer"],
		fileOwnership: ["src/**"],
		childSessionId: "child-session",
		thinkingLevel: "high",
		onResult: (text) => { steered.push(text); },
	});
	assert.equal(captured.command, "pi");
	assert.equal(captured.args?.includes("--no-extensions"), true);
	assert.equal(captured.options?.env?.PI_SUBAGENT_OWNER, "worker-one");
	const saved = readSubagentLoadout(handle.loadoutPath);
	assert.deepEqual(saved.tools, ["read", "grep"]);
	assert.equal(saved.cavemanEnabled, true);
	assert.equal(saved.depth, 0);
	assert.deepEqual(saved.subagentAgents, ["explorer"]);
	assert.deepEqual(saved.fileOwnership, ["src/**"]);
	assert.equal(fs.statSync(handle.loadoutPath).mode & 0o777, 0o600);
	assert.deepEqual(await handle.result, { owner: "worker-one", childSessionId: "child-session", text: "child result", sessionFile: "/tmp/child-session.jsonl" });
	assert.deepEqual(steered, ["child result"]);

	let fallbackSpawned = false;
	const unavailableHost = new SubagentLaunchHost({
		parentSessionId: "fallback",
		agentDir: tempDir,
		spawnProcess: () => { fallbackSpawned = true; throw new Error("headless spawn must not run"); },
		cmux: new CmuxTransport({ run: async () => { throw new Error("cmux socket refused"); } }),
	});
	const unavailable = await unavailableHost.launch({
		parentSessionId: "fallback",
		owner: "worker-fallback",
		role: "worker",
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "do fallback work",
		tools: ["read", "grep"],
		cavemanEnabled: true,
		childSessionId: "child-fallback",
	});
	assert.equal(unavailable.transport, "cmux");
	assert.equal(unavailable.cmuxFailureReason, "cmux socket unreachable.");
	await assert.rejects(unavailable.result, (error: unknown) => {
		assert.equal((error as { name?: string }).name, "SubagentFailureError");
		assert.equal((error as { info: { transport: string } }).info.transport, "cmux");
		assert.equal((error as { info: { cmuxFailureReason?: string } }).info.cmuxFailureReason, "cmux socket unreachable.");
		assert.match((error as { message: string }).message, /Log: .*\.log/);
		return true;
	});
	assert.equal(fallbackSpawned, false);
	assert.deepEqual(unavailableHost.getOwnershipSnapshot(), {});
	await unavailableHost.close();

	const failureHost = new SubagentLaunchHost({
		parentSessionId: "failure",
		agentDir: tempDir,
		spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e", disconnectScript], options),
		cmux: false,
	});
	const failed = await failureHost.launch({
		parentSessionId: "failure",
		owner: "worker-failure",
		role: "worker",
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "disconnect",
		tools: ["read", "grep"],
		cavemanEnabled: true,
		childSessionId: "child-failure",
	});
	await assert.rejects(failed.result, (error: unknown) => {
		assert.equal((error as { name?: string }).name, "SubagentFailureError");
		assert.equal((error as { info: { transport: string } }).info.transport, "headless");
		assert.equal((error as { message: string }).message.includes("0123456789"), false);
		assert.match((error as { info: { tail: string } }).info.tail, /sentinel stderr/);
		return true;
	});
	const failureLog = fs.readFileSync(failed.logPath, "utf8");
	assert.equal(failureLog.includes("0123456789"), false);
	assert.match(failureLog, /sentinel stderr/);
	assert.ok(Buffer.byteLength(failureLog, "utf8") <= 1_024 * 1_024);
	await failureHost.close();

	const hangingSpawn = (command: string, args: readonly string[], options: SpawnOptions) => {
		captured.command = command;
		captured.args = [...args];
		captured.options = options;
		hangingProcess = spawn(process.execPath, ["-e", hangingScript], options);
		return hangingProcess!;
	};
	const hostWithHangingChild = new SubagentLaunchHost({ parentSessionId: "hanging", agentDir: tempDir, spawnProcess: hangingSpawn, cmux: false });
	const hanging = await hostWithHangingChild.launch({
		parentSessionId: "hanging",
		owner: "worker-hanging",
		role: "worker",
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "do work",
		tools: ["read", "grep"],
		cavemanEnabled: true,
		fileOwnership: ["hanging/**"],
		childSessionId: "child-hanging",
		thinkingLevel: "high",
	});
	assert.ok(hanging.pid);
	assert.ok(hangingProcess);
	const processToKill = hangingProcess;
	void hanging.result.catch(() => undefined);
	const exited = once(processToKill, "exit");
	await hostWithHangingChild.close();
	await exited;
	assert.deepEqual(hostWithHangingChild.getOwnershipSnapshot(), {});
	assert.ok(processToKill.exitCode !== null || processToKill.signalCode !== null);

	mock.timers.enable();
	try {
		const healthySurface = {
			surface: "surface:healthy",
			readScreen: async () => "healthy output",
			close: async () => undefined,
		};
		const healthyCmux = {
			launch: async () => ({ transport: "cmux" as const, surface: healthySurface }),
		} as unknown as CmuxTransport;
		const healthyHost = new SubagentLaunchHost({ parentSessionId: "healthy", agentDir: tempDir, cmux: healthyCmux });
		const healthy = await healthyHost.launch({
			parentSessionId: "healthy",
			owner: "worker-healthy",
			role: "worker",
			agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
			cwd: process.cwd(),
			task: "healthy handshake",
			tools: ["read"],
			cavemanEnabled: true,
			childSessionId: "child-healthy",
		});
		const healthyClient = await SubagentIpcClient.connect({ socketPath: healthyHost.server.socketPath, token: healthyHost.server.token, owner: "worker-healthy" });
		mock.timers.tick(30_000);
		await healthyClient.request("result", { childSessionId: "child-healthy", text: "healthy result" });
		assert.deepEqual(await healthy.result, { owner: "worker-healthy", childSessionId: "child-healthy", text: "healthy result" });
		await healthyClient.close();
		await healthyHost.close();

		let timeoutSurfaceClosed = false;
		const timeoutSurface = {
			surface: "surface:timeout",
			readScreen: async () => "booting output",
			close: async () => { timeoutSurfaceClosed = true; },
		};
		const timeoutCmux = {
			launch: async () => ({ transport: "cmux" as const, surface: timeoutSurface }),
		} as unknown as CmuxTransport;
		const reapedOwners: string[] = [];
		const timeoutHost = new SubagentLaunchHost({
			parentSessionId: "timeout",
			agentDir: tempDir,
			cmux: timeoutCmux,
			onBrowser: (owner) => { reapedOwners.push(owner); },
		});
		const timedOut = await timeoutHost.launch({
			parentSessionId: "timeout",
			owner: "worker-timeout",
			role: "worker",
			agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
			cwd: process.cwd(),
			task: "missing handshake",
			tools: ["read", "browser_close"],
			cavemanEnabled: true,
			childSessionId: "child-timeout",
		});
		mock.timers.tick(30_000);
		await assert.rejects(timedOut.result, (error: unknown) => {
			const failure = error as { message: string; info: { transport: string; logPath: string; tail: string } };
			assert.equal(failure.info.transport, "cmux");
			assert.equal(failure.info.logPath, timedOut.logPath);
			assert.match(failure.message, /launched but never connected/);
			assert.match(failure.info.tail, /booting output/);
			return true;
		});
		assert.equal(timeoutSurfaceClosed, true);
		assert.deepEqual(reapedOwners, ["worker-timeout"]);
		assert.deepEqual(timeoutHost.getOwnershipSnapshot(), {});
		assert.ok(fs.existsSync(timedOut.logPath));
		assert.match(fs.readFileSync(timedOut.logPath, "utf8"), /booting output/);
		await timeoutHost.close();
	} finally {
		mock.timers.reset();
	}
	await host.close();
	console.log("subagent launch tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
