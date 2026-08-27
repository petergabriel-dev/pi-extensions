import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";

import { CAVEMAN_PROMPT } from "../../workflow-modes/caveman.ts";
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
      socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "result", owner: process.env.PI_SUBAGENT_OWNER, type: "result", payload: { childSessionId: process.env.PI_SUBAGENT_CHILD_SESSION_ID, text: "child result" } }));
    } else if (response.requestId === "result") {
      socket.end();
    }
  }
};
socket.on("connect", () => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "hello", owner: process.env.PI_SUBAGENT_OWNER, type: "hello", payload: { pid: process.pid } })));
socket.on("data", read);
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
	createdAt: new Date().toISOString(),
};

try {
	assert.ok(loadout.appendSystemPrompt.includes(CAVEMAN_PROMPT.trim()));
	assert.equal(buildSubagentSystemPrompt("Agent rules", false), "Agent rules");
	assert.ok(Buffer.byteLength(truncateSubagentResult("x".repeat(MAX_SUBAGENT_RESULT_BYTES + 100)), "utf8") <= MAX_SUBAGENT_RESULT_BYTES);
	assert.deepEqual(buildSubagentCommandArgs(loadout, "do work"), [
		"--no-extensions", "-e", loadout.extensionPath, "--print", "--tools", "read,grep",
		"--append-system-prompt", loadout.appendSystemPrompt, "--session-id", "child-session",
		"--no-approve", "--model", "openai/test-model", "--thinking", "high", "do work",
	]);

	const steered: string[] = [];
	const host = new SubagentLaunchHost({
		parentSessionId: "parent-session",
		agentDir: tempDir,
		command: "pi",
		spawnProcess: fakeSpawn,
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
	assert.equal(fs.statSync(handle.loadoutPath).mode & 0o777, 0o600);
	assert.deepEqual(await handle.result, { owner: "worker-one", childSessionId: "child-session", text: "child result" });
	assert.deepEqual(steered, ["child result"]);

	const hangingSpawn = (command: string, args: readonly string[], options: SpawnOptions) => {
		captured.command = command;
		captured.args = [...args];
		captured.options = options;
		hangingProcess = spawn(process.execPath, ["-e", hangingScript], options);
		return hangingProcess!;
	};
	const hostWithHangingChild = new SubagentLaunchHost({ parentSessionId: "parent-hanging", agentDir: tempDir, spawnProcess: hangingSpawn });
	const hanging = await hostWithHangingChild.launch({
		parentSessionId: "parent-hanging",
		owner: "worker-hanging",
		role: "worker",
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "do work",
		tools: ["read", "grep"],
		cavemanEnabled: true,
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
	assert.ok(processToKill.exitCode !== null || processToKill.signalCode !== null);
	await host.close();
	console.log("subagent launch tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
