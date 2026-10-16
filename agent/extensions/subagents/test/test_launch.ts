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
	MAX_SUBAGENT_ITEM_BYTES,
	MAX_SUBAGENT_ITEMS,
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

interface ItemRunForTest {
	itemBuffer: { listeners: Set<unknown> };
}

function itemListeners(host: SubagentLaunchHost, owner: string): Set<unknown> | undefined {
	return (host as unknown as { runs: Map<string, ItemRunForTest> }).runs.get(owner)?.itemBuffer.listeners;
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
	projectTrusted: false,
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
	const untrustedArgs = buildSubagentCommandArgs(loadout);
	assert.deepEqual(untrustedArgs, [
		"--no-extensions", "-e", loadout.extensionPath, "--tools", "read,grep",
		"--append-system-prompt", loadout.appendSystemPrompt, "--session-id", "child-session",
		"--no-approve", "--model", "openai/test-model", "--thinking", "high",
	]);
	const trustedArgs = buildSubagentCommandArgs({ ...loadout, projectTrusted: true });
	assert.equal(trustedArgs.includes("--approve"), true);
	assert.equal(trustedArgs.includes("--no-approve"), false);
	for (const args of [untrustedArgs, trustedArgs]) {
		assert.equal(args.includes("--no-extensions"), true);
		assert.equal(args.filter((argument) => argument === "-e").length, 1);
		assert.equal(args[args.indexOf("-e") + 1], loadout.extensionPath);
		assert.equal(args.some((argument) => argument.startsWith("builtin:")), false);
		assert.equal(args.some((argument) => argument.includes("claude-bridge") || argument.includes("discussion-notes")), false);
	}

	const legacyLoadoutPath = path.join(tempDir, "legacy-loadout.json");
	const legacyLoadout = { ...loadout } as Partial<SubagentLoadout>;
	delete legacyLoadout.projectTrusted;
	fs.writeFileSync(legacyLoadoutPath, JSON.stringify(legacyLoadout));
	assert.equal(readSubagentLoadout(legacyLoadoutPath).projectTrusted, false);
	const invalidLoadoutPath = path.join(tempDir, "invalid-loadout.json");
	fs.writeFileSync(invalidLoadoutPath, JSON.stringify({ ...loadout, projectTrusted: "true" }));
	assert.throws(() => readSubagentLoadout(invalidLoadoutPath), /Invalid subagent loadout\./);

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
			projectTrusted: true,
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
		assert.equal(saved.projectTrusted, true);
		assert.equal(calls[0]?.args.includes("--approve"), true);
		assert.equal(calls[0]?.args.includes("--no-approve"), false);
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

	const itemCalls: SpawnCall[] = [];
	const questions: Array<{ question: string }> = [];
	const itemHost = new SubagentLaunchHost({
		parentSessionId: "items",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["items"], itemCalls),
	});
	try {
		const handle = await itemHost.launch({
			...launchOptions("items", "worker-items"),
			onQuestion: (question) => { questions.push(question); },
		});
		const listeners = itemListeners(itemHost, "worker-items");
		assert.ok(listeners);
		const token = itemCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "";
		assert.ok(token);
		let notifications = 0;
		let tokenLeaked = false;
		const unsubscribe = itemHost.subscribeItems("worker-items", (snapshot) => {
			notifications += 1;
			tokenLeaked ||= snapshot.some((item) => item.text.includes(token));
		});
		assert.equal(listeners.size, 1);
		const temporaryUnsubscribe = itemHost.subscribeItems("worker-items", () => undefined);
		assert.equal(listeners.size, 2);
		temporaryUnsubscribe();
		assert.equal(listeners.size, 1);
		await waitFor(() => itemHost.readItems("worker-items").some((item) => item.kind === "question"));
		assert.equal(questions.length, 1);
		assert.equal(questions[0]?.question, "Choose [REDACTED]");
		assert.equal(itemHost.answerQuestion("worker-items", "item-question", "yes"), true);
		await handle.request("message", { text: "user steer text" });
		await handle.result;
		await waitForExit(itemCalls[0]!.child);

		const items = itemHost.readItems("worker-items");
		assert.equal(items.filter((item) => item.kind === "text").length, 1);
		assert.equal(items.find((item) => item.kind === "text")?.text, "message end [REDACTED]");
		assert.equal(items.filter((item) => item.kind === "thinking").length, 1);
		assert.equal(items.find((item) => item.kind === "thinking")?.text, "thinking final");
		assert.equal(items.filter((item) => item.kind === "tool").length, 1);
		assert.match(items.find((item) => item.kind === "tool")?.text ?? "", /read .*error \(23ms\)/);
		assert.ok(items.some((item) => item.kind === "user" && item.text.includes("user steer text")));
		assert.equal(items.find((item) => item.kind === "question")?.text, "Choose [REDACTED]\nOptions: safe");
		const statuses = items.filter((item) => item.kind === "status").map((item) => item.text);
		assert.ok(statuses.includes("running") && statuses.includes("waiting") && statuses.includes("done"));
		assert.ok(items.every((item) => !item.text.includes(token)));
		assert.ok(items.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_SUBAGENT_ITEM_BYTES));
		assert.ok(items.length <= MAX_SUBAGENT_ITEMS);
		assert.ok(notifications > 1);
		assert.equal(tokenLeaked, false);
		assert.equal(listeners.size, 0);
		unsubscribe();
		assert.equal(listeners.size, 0);
	} finally {
		await itemHost.close();
	}

	const capCalls: SpawnCall[] = [];
	const capHost = new SubagentLaunchHost({
		parentSessionId: "item-cap",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["item-cap"], capCalls),
	});
	try {
		const capped = await capHost.launch(launchOptions("item-cap", "worker-item-cap"));
		await capped.result;
		await waitForExit(capCalls[0]!.child);
		const items = capHost.readItems("worker-item-cap");
		assert.equal(items.length, MAX_SUBAGENT_ITEMS);
		assert.equal(items.some((item) => item.text.includes("user-0")), false);
		assert.ok(items.some((item) => item.text.includes("user-204")));
		const longItem = items.find((item) => item.kind === "user" && item.text.endsWith("tail-marker"));
		assert.ok(longItem);
		assert.equal(longItem.text.startsWith("long-prefix:"), false);
		assert.ok(items.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_SUBAGENT_ITEM_BYTES));
	} finally {
		await capHost.close();
	}

	const nestedCalls: SpawnCall[] = [];
	let nestedHost!: SubagentLaunchHost;
	let nestedHandle: Awaited<ReturnType<SubagentLaunchHost["launch"]>> | undefined;
	nestedHost = new SubagentLaunchHost({
		parentSessionId: "nested-items",
		agentDir: tempDir,
		spawnProcess: fakeSpawn(["nested-spawn", "launch"], nestedCalls),
		onSpawn: async () => {
			nestedHandle = await nestedHost.launch(launchOptions("nested-items", "nested-child"));
			return { started: true };
		},
	});
	try {
		const parent = await nestedHost.launch(launchOptions("nested-items", "parent-child"));
		await waitFor(() => nestedHandle !== undefined);
		const nested = nestedHandle;
		assert.ok(nested);
		await Promise.all([parent.result, nested.result]);
		await Promise.all(nestedCalls.map((call) => waitForExit(call.child)));
		const parentItems = nestedHost.readItems("parent-child");
		const nestedItems = nestedHost.readItems("nested-child");
		assert.ok(parentItems.some((item) => item.kind === "text"));
		assert.equal(parentItems.some((item) => item.kind === "tool"), false);
		assert.ok(nestedItems.some((item) => item.kind === "tool"));
	} finally {
		await nestedHost.close();
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
		spawnProcess: fakeSpawn(["fail-later"], failureCalls),
	});
	try {
		const failed = await failureHost.launch({
			...launchOptions("failure", "worker-failure"),
			tools: ["edit"],
			fileOwnership: ["failure/**"],
		});
		const failureListeners = itemListeners(failureHost, "worker-failure");
		assert.ok(failureListeners);
		failureHost.subscribeItems("worker-failure", () => undefined);
		assert.equal(failureListeners.size, 1);
		await failed.request("message", { text: "trigger failure" });
		await assert.rejects(failed.result, (error: unknown) => {
			assert.ok(error instanceof SubagentFailureError);
			assert.equal(error.info.kind, "process");
			assert.equal(error.info.logPath, failed.logPath);
			assert.equal(error.message.includes(failureCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
			assert.match(error.info.tail, /sentinel stderr/);
			assert.equal(error.info.tail.includes(failureCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
			return true;
		});
		assert.equal(failureListeners.size, 0);
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
		const tailListeners = itemListeners(tailHost, "worker-tail");
		assert.ok(tailListeners);
		tailHost.subscribeItems("worker-tail", () => undefined);
		assert.equal(tailListeners.size, 1);
		await waitFor(async () => Boolean(await tailHost.readTail("worker-tail", 20)));
		const tail = await tailHost.readTail("worker-tail", 20);
		assert.match(tail ?? "", /tail sentinel/);
		assert.equal(tail?.includes(tailCalls[0]?.options.env?.PI_SUBAGENT_TOKEN ?? "missing"), false);
		assert.ok(Buffer.byteLength(tail ?? "", "utf8") <= 8 * 1024);
		await tailHost.close();
		assert.equal(tailListeners.size, 0);
		assert.deepEqual(tailHost.readItems("worker-tail"), []);
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
		const abortListeners = itemListeners(abortHost, "writer-abort");
		assert.ok(abortListeners);
		abortHost.subscribeItems("writer-abort", () => undefined);
		assert.equal(abortListeners.size, 1);
		aborted.kill();
		await assert.rejects(aborted.result, /aborted/);
		assert.equal(abortListeners.size, 0);
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
