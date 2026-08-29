import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";

import { SubagentLaunchHost } from "../launch.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-interaction-"));
const agent = { name: "worker" as const, systemPrompt: "Agent rules", model: undefined };
let questionArgs: readonly string[] = [];

const questionChild = `
const net = require("node:net");
let buffer = Buffer.alloc(0);
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
const send = (requestId, type, payload) => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId, owner: process.env.PI_SUBAGENT_OWNER, type, payload }));
socket.on("connect", () => send("hello", "hello", { pid: process.pid }));
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    if (response.kind !== "response") continue;
    if (response.requestId === "hello") send("question", "question", { questionId: "question-one", question: "Which answer?", options: ["yes", "no"] });
    else if (response.requestId === "question") send("result", "result", { childSessionId: process.env.PI_SUBAGENT_CHILD_SESSION_ID, text: "answer used" });
    else if (response.requestId === "result") socket.end();
  }
});
`;
const messageChild = `
const net = require("node:net");
let buffer = Buffer.alloc(0);
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
socket.on("connect", () => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "hello", owner: process.env.PI_SUBAGENT_OWNER, type: "hello", payload: { pid: process.pid } })));
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const request = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    if (request.kind !== "request" || request.type !== "message") continue;
    socket.write(frame({ kind: "response", token: process.env.PI_SUBAGENT_TOKEN, requestId: request.requestId, owner: process.env.PI_SUBAGENT_OWNER, ok: true, result: { accepted: true } }));
    socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "result", owner: process.env.PI_SUBAGENT_OWNER, type: "result", payload: { text: "message used" } }));
  }
});
`;
const browserChild = `
const net = require("node:net");
let buffer = Buffer.alloc(0);
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length, 0); body.copy(out, 4); return out; };
const send = (requestId, type, payload) => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId, owner: process.env.PI_SUBAGENT_OWNER, type, payload }));
socket.on("connect", () => send("hello", "hello", { pid: process.pid }));
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    if (response.kind !== "response") continue;
    if (response.requestId === "hello") send("browser", "browser", { tool: "browser_console", params: { clear: false } });
    else if (response.requestId === "browser") send("result", "result", { text: "browser result" });
    else if (response.requestId === "result") socket.end();
  }
});
`;
const resultChild = `
const net = require("node:net");
let buffer = Buffer.alloc(0);
const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
const frame = (value) => { const body = Buffer.from(JSON.stringify(value)); const out = Buffer.alloc(4 + body.length); out.writeUInt32BE(body.length); body.copy(out, 4); return out; };
socket.on("connect", () => socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "hello", owner: process.env.PI_SUBAGENT_OWNER, type: "hello", payload: { pid: process.pid } })));
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < length + 4) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    if (response.kind !== "response") continue;
    if (response.requestId === "hello") socket.write(frame({ kind: "request", token: process.env.PI_SUBAGENT_TOKEN, requestId: "result", owner: process.env.PI_SUBAGENT_OWNER, type: "result", payload: { text: process.env.TEST_MODE } }));
    else if (response.requestId === "result") socket.end();
  }
});
`;

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("Timed out waiting for child interaction."));
			setTimeout(check, 5);
		};
		check();
	});
}

function launchOptions(parentSessionId: string, owner: string, childSessionId?: string) {
	return {
		parentSessionId,
		owner,
		role: "worker" as const,
		agent,
		cwd: process.cwd(),
		task: "do work",
		tools: ["read"],
		cavemanEnabled: true,
		...(childSessionId ? { childSessionId } : {}),
	};
}

try {
	const questionStatuses: string[] = [];
	let question: { questionId: string; question: string; options?: string[] } | undefined;
	const questionHost = new SubagentLaunchHost({
		parentSessionId: "question",
		agentDir: tempDir,
		cmux: false,
		timeoutPolicy: { idleTimeoutMs: 100, maxTotalMs: 300 },
		spawnProcess: (_command, args, options) => {
			questionArgs = [...args];
			return spawn(process.execPath, ["-e", questionChild], options);
		},
	});
	const questionHandle = await questionHost.launch({
		...launchOptions("question", "question-owner", "question-child"),
		fileOwnership: ["src/**"],
		onStatus: (status) => questionStatuses.push(status),
		onQuestion: (value) => { question = value; },
	});
	assert.equal(questionArgs.includes("--print"), false);
	await waitFor(() => Boolean(question));
	assert.deepEqual(question, { questionId: "question-one", question: "Which answer?", options: ["yes", "no"] });
	const ownershipConflict = questionHost.acquireOwnership("other-owner", ["src/file.ts"]);
	assert.equal(ownershipConflict.ok, false);
	assert.equal(ownershipConflict.conflict?.owner, "question-owner");
	let questionSettled = false;
	void questionHandle.result.then(() => { questionSettled = true; }, () => { questionSettled = true; });
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(questionSettled, false);
	assert.equal(questionHost.answerQuestion("question-owner", "question-one", "yes"), true);
	assert.deepEqual(await questionHandle.result, { owner: "question-owner", childSessionId: "question-child", text: "answer used" });
	assert.deepEqual(questionStatuses, ["running", "waiting", "running"]);
	await waitFor(() => Object.keys(questionHost.getOwnershipSnapshot()).length === 0);
	await questionHost.close();

	const messageHost = new SubagentLaunchHost({
		parentSessionId: "message",
		agentDir: tempDir,
		cmux: false,
		spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e", messageChild], options),
	});
	const messageHandle = await messageHost.launch(launchOptions("message", "message-owner", "message-child"));
	await waitFor(() => Boolean(messageHost.server.getConnection("message-owner")));
	await messageHandle.request("message", { text: "parent message" });
	assert.deepEqual(await messageHandle.result, { owner: "message-owner", childSessionId: "message-child", text: "message used" });
	await messageHost.close();

	const browserRequests: Array<{ owner: string; payload: unknown }> = [];
	const browserHost = new SubagentLaunchHost({
		parentSessionId: "browser",
		agentDir: tempDir,
		cmux: false,
		spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e", browserChild], options),
		onBrowser: (owner, payload) => {
			browserRequests.push({ owner, payload });
			return { content: [{ type: "text", text: "browser response" }], details: { ok: true } };
		},
	});
	const browserHandle = await browserHost.launch({
		...launchOptions("browser", "browser-owner", "browser-child"),
		tools: ["read", "browser_console", "browser_close"],
	});
	assert.deepEqual(await browserHandle.result, { owner: "browser-owner", childSessionId: "browser-child", text: "browser result" });
	assert.deepEqual(browserRequests[0], { owner: "browser-owner", payload: { tool: "browser_console", params: { clear: false } } });
	assert.deepEqual(browserRequests[1], { owner: "browser-owner", payload: { tool: "browser_close", params: {} } });
	await browserHost.close();

	let spawnCount = 0;
	const spawned = [] as ReturnType<typeof spawn>[];
	const resumeHost = new SubagentLaunchHost({
		parentSessionId: "resume",
		agentDir: tempDir,
		cmux: false,
		spawnProcess: (_command, _args, options: SpawnOptions) => {
			spawnCount += 1;
			const child = spawn(process.execPath, ["-e", resultChild], { ...options, env: { ...options.env, TEST_MODE: spawnCount === 1 ? "initial" : "resumed" } });
			spawned.push(child);
			return child;
		},
	});
	const initial = await resumeHost.launch(launchOptions("resume", "resume-owner", "resume-child"));
	assert.deepEqual(await initial.result, { owner: "resume-owner", childSessionId: "resume-child", text: "initial" });
	const before = fs.readFileSync(initial.loadoutPath, "utf8");
	const resumed = await resumeHost.resume(initial.loadoutPath, "resume task");
	await waitForExit(spawned[0]!);
	assert.equal(fs.readFileSync(initial.loadoutPath, "utf8"), before);
	assert.deepEqual(await resumed.result, { owner: "resume-owner", childSessionId: "resume-child", text: "resumed" });
	await waitForExit(spawned[1]!);
	await resumeHost.close();

	console.log("subagent interaction tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
