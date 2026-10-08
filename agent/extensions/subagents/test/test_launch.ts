import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mock } from "node:test";

import { CAVEMAN_PROMPT } from "../../workflow-modes/caveman.ts";
import {
	buildSubagentCommandArgs,
	buildSubagentSystemPrompt,
	MAX_SUBAGENT_RESULT_BYTES,
	readSubagentLoadout,
	resolveSubagentExtensionPath,
	SubagentFailureError,
	SubagentLaunchHost,
	truncateSubagentResult,
	type SubagentLoadout,
} from "../launch.ts";
import { resolvePiCliPath } from "../rpc.ts";

interface SpawnCall {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: ChildProcess;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-launch-"));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
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

function fakeSpawn(modes: string[], calls: SpawnCall[], onSpawn?: () => void): (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess {
	let index = 0;
	return (command, args, options) => {
		const mode = modes[Math.min(index, modes.length - 1)]!;
		index += 1;
		const child = spawn(process.execPath, [fixturePath, "--fixture-mode", mode], options);
		calls.push({ command, args: [...args], options, child });
		onSpawn?.();
		return child;
	};
}

function launchOptions(parentSessionId: string, owner: string, task = "do work") {
	return {
		parentSessionId,
		owner,
		role: "worker" as const,
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task,
		tools: ["read", "grep"],
		cavemanEnabled: true,
		childSessionId: `${owner}-session`,
	};
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for RPC child event.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

try {
	assert.ok(loadout.appendSystemPrompt.includes(CAVEMAN_PROMPT.trim()));
	assert.equal(buildSubagentSystemPrompt("Agent rules", false), "Agent rules");
	assert.ok(Buffer.byteLength(truncateSubagentResult("x".repeat(MAX_SUBAGENT_RESULT_BYTES + 100)), "utf8") <= MAX_SUBAGENT_RESULT_BYTES);
	assert.deepEqual(buildSubagentCommandArgs(loadout), [
		"--no-extensions", "-e", loadout.extensionPath, "--tools", "read,grep",
		"--append-system-prompt", loadout.appendSystemPrompt, "--session-id", "child-session",
		"--no-approve", "--model", "openai/test-model", "--thinking", "high",
	]);

	const calls: SpawnCall[] = [];
	const steered: string[] = [];
	const host = new SubagentLaunchHost({
		parentSessionId: "parent-session",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["launch"], calls),
	});
	try {
		const handle = await host.launch({
			...launchOptions("parent-session", "worker-one"),
			subagentAgents: ["explorer"],
			fileOwnership: ["src/**"],
			onResult: (text) => { steered.push(text); throw new Error("steering callback failed"); },
		});
		assert.equal(handle.transport, "rpc");
		assert.equal(calls[0]?.command, process.execPath);
		assert.equal(calls[0]?.args[0], resolvePiCliPath());
		assert.deepEqual(calls[0]?.args.slice(1, 3), ["--mode", "rpc"]);
		assert.equal(calls[0]?.args.includes("--no-extensions"), true);
		assert.equal(calls[0]?.args.includes("do work"), false);
		assert.equal(calls[0]?.args.includes("--print"), false);
		assert.equal(calls[0]?.options.env?.PI_SUBAGENT_OWNER, "worker-one");
		assert.equal(typeof calls[0]?.options.env?.PI_SUBAGENT_TOKEN, "string");
		assert.deepEqual(calls[0]?.options.stdio, ["pipe", "pipe", "pipe"]);
		const saved = readSubagentLoadout(handle.loadoutPath);
		assert.deepEqual(saved.tools, ["read", "grep"]);
		assert.equal(saved.cavemanEnabled, true);
		assert.equal(saved.depth, 0);
		assert.deepEqual(saved.subagentAgents, ["explorer"]);
		assert.deepEqual(saved.fileOwnership, ["src/**"]);
		assert.equal(fs.statSync(handle.loadoutPath).mode & 0o777, 0o600);
		assert.deepEqual(await handle.result, {
			owner: "worker-one",
			childSessionId: "worker-one-session",
			text: "fake assistant result",
			sessionFile: "/tmp/fake-child-session.jsonl",
		});
		await waitFor(() => steered.length === 1);
		assert.deepEqual(steered, ["fake assistant result"]);
		await waitForExit(calls[0]!.child);
		assert.deepEqual(host.getOwnershipSnapshot(), {});
	} finally {
		await host.close();
	}

	const handledCalls: SpawnCall[] = [];
	const handledHost = new SubagentLaunchHost({
		parentSessionId: "handled",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["handled", "result"], handledCalls),
	});
	try {
		const handled = await handledHost.launch({
			...launchOptions("handled", "writer-handled"),
			tools: ["edit"],
			fileOwnership: ["shared/**"],
		});
		await assert.rejects(handled.result, (error: unknown) => {
			assert.ok(error instanceof SubagentFailureError);
			assert.equal(error.info.kind, "launch");
			assert.match(error.info.error, /handled without a run/);
			assert.match(error.info.logPath, /writer-handled\.log/);
			return true;
		});
		assert.deepEqual(handledHost.getOwnershipSnapshot(), {});
		const recovered = await handledHost.launch({
			...launchOptions("handled", "writer-recovered"),
			tools: ["edit"],
			fileOwnership: ["shared/**"],
		});
		assert.equal((await recovered.result).text, "fake assistant result");
		await waitForExit(handledCalls[1]!.child);
		assert.deepEqual(handledHost.getOwnershipSnapshot(), {});
	} finally {
		await handledHost.close();
	}

	const timeoutCalls: SpawnCall[] = [];
	let spawned!: () => void;
	const spawnObserved = new Promise<void>((resolve) => { spawned = resolve; });
	const timeoutHost = new SubagentLaunchHost({
		parentSessionId: "readiness",
		agentDir: tempDir,
		timeoutPolicy: { idleTimeoutMs: 600_000, maxTotalMs: 1_200_000 },
		spawnProcess: fakeSpawn(["ready-hang"], timeoutCalls, () => spawned()),
	});
	mock.timers.enable();
	try {
		const pendingLaunch = timeoutHost.launch(launchOptions("readiness", "worker-readiness"));
		await spawnObserved;
		mock.timers.tick(30_000);
		const timedOut = await pendingLaunch;
		await assert.rejects(timedOut.result, (error: unknown) => {
			assert.ok(error instanceof SubagentFailureError);
			assert.equal(error.info.kind, "launch");
			assert.match(error.info.error, /prompt readiness timed out after 30 seconds/);
			return true;
		});
		await waitForExit(timeoutCalls[0]!.child);
		assert.deepEqual(timeoutHost.getOwnershipSnapshot(), {});
	} finally {
		await timeoutHost.close();
		mock.timers.reset();
	}

	const failureCalls: SpawnCall[] = [];
	const failureHost = new SubagentLaunchHost({
		parentSessionId: "failure",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["exit-before-settle"], failureCalls),
	});
	try {
		const failed = await failureHost.launch({
			...launchOptions("failure", "worker-failure"),
			tools: ["edit"],
			fileOwnership: ["failure/**"],
		});
		await assert.rejects(failed.result, (error: unknown) => {
			assert.ok(error instanceof SubagentFailureError);
			assert.equal(error.info.kind, "process");
			assert.equal(error.info.logPath, failed.logPath);
			assert.equal(error.message.includes(failureCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
			assert.match(error.info.tail, /sentinel stderr/);
			assert.equal(error.info.tail.includes(failureCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
			return true;
		});
		await waitForExit(failureCalls[0]!.child);
		const log = fs.readFileSync(failed.logPath, "utf8");
		assert.match(log, /sentinel stderr/);
		assert.equal(log.includes(failureCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
		assert.ok(Buffer.byteLength(log, "utf8") <= 1_024 * 1_024);
		assert.deepEqual(failureHost.getOwnershipSnapshot(), {});
	} finally {
		await failureHost.close();
	}

	const tailCalls: SpawnCall[] = [];
	const tailHost = new SubagentLaunchHost({
		parentSessionId: "tail",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["tail"], tailCalls),
	});
	try {
		const tailHandle = await tailHost.launch(launchOptions("tail", "worker-tail"));
		await waitFor(async () => Boolean(await tailHost.readTail("worker-tail", 20)));
		const tail = await tailHost.readTail("worker-tail", 20);
		assert.match(tail ?? "", /tail sentinel/);
		assert.equal(tail?.includes(tailCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
		assert.ok(Buffer.byteLength(tail ?? "", "utf8") <= 8 * 1024);
		await tailHost.close();
		await assert.rejects(tailHandle.result, /host closed/);
		await waitForExit(tailCalls[0]!.child);
	} finally {
		await tailHost.close();
	}

	const abortCalls: SpawnCall[] = [];
	const abortHost = new SubagentLaunchHost({
		parentSessionId: "abort",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["abort"], abortCalls),
	});
	try {
		const aborted = await abortHost.launch({
			...launchOptions("abort", "writer-abort"),
			tools: ["edit"],
			fileOwnership: ["abort/**"],
		});
		aborted.kill();
		await assert.rejects(aborted.result, /aborted/);
		await waitForExit(abortCalls[0]!.child);
		assert.deepEqual(abortHost.getOwnershipSnapshot(), {});
		assert.ok(abortCalls[0]!.child.exitCode !== null || abortCalls[0]!.child.signalCode !== null);
	} finally {
		await abortHost.close();
	}

	const concurrentCalls: SpawnCall[] = [];
	const concurrentHost = new SubagentLaunchHost({
		parentSessionId: "concurrent",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["launch"], concurrentCalls),
	});
	try {
		const handles = await Promise.all([0, 1, 2, 3].map((index) => concurrentHost.launch(launchOptions("concurrent", `worker-${index}`, `work ${index}`))));
		assert.deepEqual((await Promise.all(handles.map((handle) => handle.result))).map((result) => result.text), Array(4).fill("fake assistant result"));
		await Promise.all(concurrentCalls.map((call) => waitForExit(call.child)));
		assert.deepEqual(concurrentHost.getOwnershipSnapshot(), {});
	} finally {
		await concurrentHost.close();
	}

	console.log("subagent launch tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
