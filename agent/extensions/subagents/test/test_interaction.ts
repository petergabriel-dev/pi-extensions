import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { SubagentIpcClient } from "../ipc.ts";
import { SubagentLaunchHost } from "../launch.ts";

interface SpawnCall {
	args: string[];
	options: SpawnOptions;
	child: ChildProcess;
	stderr: string[];
}

const tempDir = fs.mkdtempSync(path.join("/tmp", "pi-si-"));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
const agent = { name: "worker", systemPrompt: "Agent rules", model: undefined };

function spawnMode(mode: string, calls: SpawnCall[], results: string[] = []): (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess {
	let index = 0;
	return (_command, args, options) => {
		const result = results[index];
		const env = { ...(options.env ?? {}), ...(result ? { FAKE_RESULT: result } : {}) };
		const child = spawn(process.execPath, [fixturePath, "--fixture-mode", mode], { ...options, env });
		const stderr: string[] = [];
		if (mode === "late-steer") child.stderr?.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
		calls.push({ args: [...args], options: { ...options, env }, child, stderr });
		index += 1;
		return child;
	};
}

function launchOptions(parentSessionId: string, owner: string, childSessionId = `${owner}-child`) {
	return {
		parentSessionId,
		owner,
		role: "worker" as const,
		agent,
		cwd: process.cwd(),
		task: "do work",
		tools: ["edit"],
		cavemanEnabled: true,
		childSessionId,
	};
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for child interaction.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

try {
	const questionCalls: SpawnCall[] = [];
	const questionStatuses: string[] = [];
	let question: { questionId: string; question: string; options?: string[] } | undefined;
	const questionHost = new SubagentLaunchHost({
		parentSessionId: "question",
		agentDir: tempDir,
		timeoutPolicy: { idleTimeoutMs: 100, maxTotalMs: 300 },
		spawnProcess: spawnMode("question", questionCalls),
	});
	try {
		const questionHandle = await questionHost.launch({
			...launchOptions("question", "question-owner", "question-child"),
			fileOwnership: ["src/**"],
			onStatus: (status) => questionStatuses.push(status),
			onQuestion: (value) => { question = value; },
		});
		assert.equal(questionCalls[0]?.args.includes("--print"), false);
		await waitFor(() => Boolean(question));
		assert.deepEqual(question, { questionId: "question-ui-1", question: "Which answer?", options: ["yes", "no"] });
		const ownershipConflict = questionHost.acquireOwnership("other-owner", ["src/file.ts"]);
		assert.equal(ownershipConflict.ok, false);
		assert.equal(ownershipConflict.conflict?.owner, "question-owner");
		let questionSettled = false;
		void questionHandle.result.then(() => { questionSettled = true; }, () => { questionSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(questionSettled, false);
		assert.equal(questionHost.answerQuestion("question-owner", "question-ui-1", "yes"), true);
		assert.equal(questionHost.answerQuestion("question-owner", "question-ui-1", "no"), false);
		assert.deepEqual(await questionHandle.result, {
			owner: "question-owner",
			childSessionId: "question-child",
			text: "answer used: yes",
			sessionFile: "/tmp/fake-child-session.jsonl",
		});
		assert.deepEqual(questionStatuses, ["running", "waiting", "running"]);
		await waitForExit(questionCalls[0]!.child);
		assert.deepEqual(questionHost.getOwnershipSnapshot(), {});
	} finally {
		await questionHost.close();
	}

	const inputCalls: SpawnCall[] = [];
	let inputQuestion: { questionId: string; question: string; options?: string[] } | undefined;
	const inputHost = new SubagentLaunchHost({
		parentSessionId: "question-input",
		agentDir: tempDir,
		spawnProcess: spawnMode("question-input", inputCalls),
	});
	try {
		const inputHandle = await inputHost.launch({
			...launchOptions("question-input", "input-owner"),
			onQuestion: (value) => { inputQuestion = value; },
		});
		await waitFor(() => Boolean(inputQuestion));
		assert.deepEqual(inputQuestion, { questionId: "question-ui-1", question: "Which answer?" });
		assert.equal(inputHost.answerQuestion("input-owner", "question-ui-1", "free text"), true);
		assert.equal((await inputHandle.result).text, "answer used: free text");
		await waitForExit(inputCalls[0]!.child);
	} finally {
		await inputHost.close();
	}

	const messageCalls: SpawnCall[] = [];
	const messageHost = new SubagentLaunchHost({
		parentSessionId: "message",
		agentDir: tempDir,
		spawnProcess: spawnMode("follow-up", messageCalls),
	});
	try {
		const messageHandle = await messageHost.launch(launchOptions("message", "message-owner", "message-child"));
		await messageHandle.request("message", { text: "parent message" });
		assert.equal((await messageHandle.result).text, "steer: parent message");
		await waitForExit(messageCalls[0]!.child);
	} finally {
		await messageHost.close();
	}

	const lateSteerCalls: SpawnCall[] = [];
	let lateSteerResultCount = 0;
	const lateSteerHost = new SubagentLaunchHost({
		parentSessionId: "late-steer",
		agentDir: tempDir,
		spawnProcess: spawnMode("late-steer", lateSteerCalls),
	});
	try {
		const lateSteerHandle = await lateSteerHost.launch({
			...launchOptions("late-steer", "late-steer-owner"),
			onResult: () => { lateSteerResultCount += 1; },
		});
		await waitFor(() => lateSteerCalls[0]?.stderr.join("").includes("late-steer-ready") === true);
		await lateSteerHandle.request("message", { text: "parent message near settlement" });
		assert.equal((await lateSteerHandle.result).text, "steer: parent message near settlement");
		await waitForExit(lateSteerCalls[0]!.child);
		await waitFor(() => lateSteerResultCount === 1);
		assert.equal(lateSteerResultCount, 1);
	} finally {
		await lateSteerHost.close();
	}

	const browserRequests: Array<{ owner: string; payload: unknown }> = [];
	const browserCalls: SpawnCall[] = [];
	const browserHost = new SubagentLaunchHost({
		parentSessionId: "browser",
		agentDir: tempDir,
		spawnProcess: spawnMode("browser", browserCalls),
		onBrowser: (owner, payload) => {
			browserRequests.push({ owner, payload });
			if ((payload as { tool?: string }).tool === "browser_close") throw new Error("browser reap callback failed");
			return { content: [{ type: "text", text: "browser response" }], details: { ok: true } };
		},
	});
	try {
		const browserHandle = await browserHost.launch({
			...launchOptions("browser", "browser-owner", "browser-child"),
			tools: ["read", "browser_console", "browser_close"],
		});
		assert.equal((await browserHandle.result).text, "fake assistant result");
		await waitFor(() => browserRequests.length === 2);
		assert.deepEqual(browserRequests, [
			{ owner: "browser-owner", payload: { tool: "browser_console", params: { clear: false } } },
			{ owner: "browser-owner", payload: { tool: "browser_close", params: {} } },
		]);
		await waitForExit(browserCalls[0]!.child);
	} finally {
		await browserHost.close();
	}

	const disconnectCalls: SpawnCall[] = [];
	const disconnectHost = new SubagentLaunchHost({
		parentSessionId: "disconnect",
		agentDir: tempDir,
		spawnProcess: spawnMode("wait", disconnectCalls),
	});
	try {
		const disconnected = await disconnectHost.launch(launchOptions("disconnect", "disconnect-owner"));
		const token = disconnectCalls[0]?.options.env?.PI_SUBAGENT_TOKEN;
		assert.equal(typeof token, "string");
		const client = SubagentIpcClient.create({ socketPath: disconnectHost.server.socketPath, owner: "disconnect-owner", token: token! });
		assert.equal(disconnectHost.server.getConnection("disconnect-owner"), undefined);
		assert.deepEqual(await client.request("ownership", { action: "release" }), { accepted: true, released: true });
		assert.ok(disconnectHost.server.getConnection("disconnect-owner"));
		await client.close();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await disconnected.request("message", { text: "continue" });
		assert.equal((await disconnected.result).text, "steer: continue");
		await waitForExit(disconnectCalls[0]!.child);
	} finally {
		await disconnectHost.close();
	}

	const resumeCalls: SpawnCall[] = [];
	const resumeHost = new SubagentLaunchHost({
		parentSessionId: "resume",
		agentDir: tempDir,
		spawnProcess: spawnMode("result", resumeCalls, ["initial", "resumed"]),
	});
	try {
		const initial = await resumeHost.launch(launchOptions("resume", "resume-owner", "resume-child"));
		assert.equal((await initial.result).text, "initial");
		await waitForExit(resumeCalls[0]!.child);
		const before = fs.readFileSync(initial.loadoutPath, "utf8");
		const resumed = await resumeHost.resume(initial.loadoutPath, "resume task");
		assert.equal(fs.readFileSync(initial.loadoutPath, "utf8"), before);
		assert.equal((await resumed.result).text, "resumed");
		assert.deepEqual(resumeCalls.map((call) => call.args.slice(call.args.indexOf("--session-id"), call.args.indexOf("--session-id") + 2)), [
			["--session-id", "resume-child"],
			["--session-id", "resume-child"],
		]);
		await waitForExit(resumeCalls[1]!.child);
	} finally {
		await resumeHost.close();
	}

	console.log("subagent interaction tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
