import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	resolvePiCliPath,
	SUBAGENT_RPC_MAX_RECORD_BYTES,
	SUBAGENT_RPC_MAX_STDERR_BYTES,
	SubagentRpcError,
	SubagentRpcProcess,
	type SubagentRpcEvent,
	type SubagentRpcSpawnProcess,
} from "../rpc.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));

async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms.`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function createProcess(
	mode: string,
	callbacks: {
		logger?: (event: string, details?: Record<string, unknown>) => void;
		stderrSink?: (chunk: Uint8Array) => void;
		onEvent?: (event: SubagentRpcEvent) => void;
		onUiRequest?: (id: string, method: string, payload: Record<string, unknown>) => void | Promise<void>;
		onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
	} = {},
): { rpc: SubagentRpcProcess; command: string; args: string[]; options: SpawnOptions } {
	const originalArgv = process.argv[1]!;
	process.argv[1] = fixturePath;
	let command = "";
	let args: string[] = [];
	let spawnOptions: SpawnOptions | undefined;
	const spawnProcess: SubagentRpcSpawnProcess = (spawnCommand, spawnArgs, options) => {
		command = spawnCommand;
		args = [...spawnArgs];
		spawnOptions = options;
		return spawn(spawnCommand, [...spawnArgs], options);
	};
	try {
		const rpc = new SubagentRpcProcess({ args: ["--fixture-mode", mode], cwd: path.dirname(fixturePath), spawnProcess, ...callbacks });
		return { rpc, command, args, options: spawnOptions! };
	} finally {
		process.argv[1] = originalArgv;
	}
}

assert.equal(SUBAGENT_RPC_MAX_RECORD_BYTES, 32 * 1024 * 1024);
assert.equal(SUBAGENT_RPC_MAX_STDERR_BYTES, 1024 * 1024);
assert.equal(resolvePiCliPath(fixturePath), fixturePath);
const originalArgv = process.argv[1]!;
try {
	process.argv[1] = path.join(path.dirname(fixturePath), "missing-pi-cli.js");
	assert.throws(() => new SubagentRpcProcess({ args: [] }), (error: unknown) => error instanceof SubagentRpcError && error.kind === "launch");
} finally {
	process.argv[1] = originalArgv;
}

const logs: string[] = [];
const events: SubagentRpcEvent[] = [];
const uiRequests: Array<{ id: string; method: string; payload: Record<string, unknown> }> = [];
const uiWrites: Promise<void>[] = [];
let rpcForUi!: SubagentRpcProcess;
let resolveQueue!: (event: SubagentRpcEvent) => void;
const queueEvent = new Promise<SubagentRpcEvent>((resolve) => { resolveQueue = resolve; });
const roundtrip = createProcess("roundtrip", {
	logger: (event) => logs.push(event),
	onEvent: (event) => {
		events.push(event);
		if (event.type === "queue_update") resolveQueue(event);
	},
	onUiRequest: (id, method, payload) => {
		uiRequests.push({ id, method, payload });
		const response = id === "ui-value-1" ? { value: "answer", type: "prompt", id: "spoof" } : { cancelled: true as const };
		uiWrites.push(rpcForUi.respondUi(id, response));
	},
});
rpcForUi = roundtrip.rpc;

try {
	assert.equal(roundtrip.command, process.execPath);
	assert.equal(roundtrip.args[0], fixturePath);
	assert.deepEqual(roundtrip.args.slice(1, 3), ["--mode", "rpc"]);
	assert.deepEqual(roundtrip.args.slice(3), ["--fixture-mode", "roundtrip"]);
	assert.deepEqual(roundtrip.options.stdio, ["pipe", "pipe", "pipe"]);

	assert.deepEqual(await within(roundtrip.rpc.prompt("start")), { disposition: "started" });
	const queue = await within(queueEvent);
	await Promise.all(uiWrites);
	assert.deepEqual(uiRequests, [
		{ id: "ui-value-1", method: "input", payload: { title: "Answer?" } },
		{ id: "ui-cancel-2", method: "select", payload: { options: ["A", "B"] } },
	]);
	assert.deepEqual(queue.steering, ["ui:answer", "ui:cancelled"]);
	assert.equal(events.find((event) => event.type === "message_update")?.marker, "separator:\u2028\u2029");
	assert.ok(logs.includes("invalid_record_ignored"));
	assert.ok(logs.includes("unknown_record_ignored"));

	await Promise.all([roundtrip.rpc.followUp("next"), roundtrip.rpc.steer("change"), roundtrip.rpc.abort()]);
	assert.equal((await roundtrip.rpc.getState()).sessionFile, "/tmp/fake-child-session.jsonl");
	assert.equal(await roundtrip.rpc.getLastAssistantText(), "fake assistant result");
} finally {
	await within(roundtrip.rpc.stop());
}
assert.equal(roundtrip.rpc.child.exitCode, 0);

const oldVersion = createProcess("missing-disposition");
try {
	assert.deepEqual(await within(oldVersion.rpc.prompt("legacy response")), { disposition: "started" });
} finally {
	await within(oldVersion.rpc.stop());
}

const correlated = createProcess("correlation");
try {
	const followUpFailure = assert.rejects(correlated.rpc.followUp("fail this command"), (error: unknown) => error instanceof SubagentRpcError && error.kind === "command" && error.message === "expected follow_up failure");
	await correlated.rpc.steer("succeed out of order");
	await followUpFailure;
} finally {
	await within(correlated.rpc.stop());
}

const exit = createProcess("exit");
const exitPending = exit.rpc.getState();
await assert.rejects(within(exitPending), (error: unknown) => error instanceof SubagentRpcError && error.kind === "process");
await within(exit.rpc.stop());
assert.equal(exit.rpc.child.exitCode, 23);

const stopped = createProcess("hang");
const stoppedPending = stopped.rpc.getState();
const stoppedRejection = assert.rejects(stoppedPending, (error: unknown) => error instanceof SubagentRpcError && error.kind === "stopped");
await within(stopped.rpc.stop());
await stoppedRejection;
assert.equal(stopped.rpc.child.exitCode, 0);

const errored = createProcess("hang");
const errorPending = errored.rpc.getState();
const errorRejection = assert.rejects(errorPending, (error: unknown) => error instanceof SubagentRpcError && error.kind === "process");
errored.rpc.child.stdin!.destroy(new Error("forced stdin failure"));
await within(errorRejection);
await within(errored.rpc.stop());

const oversized = createProcess("oversize");
const oversizedPending = oversized.rpc.getState();
await assert.rejects(within(oversizedPending, 10_000), (error: unknown) => error instanceof SubagentRpcError && error.kind === "protocol");
await within(oversized.rpc.stop(), 5_000);

let stderrBytes = 0;
let stderrText = "";
let leakedToParent = false;
let resolveStderrLimit!: () => void;
const stderrLimitReached = new Promise<void>((resolve) => { resolveStderrLimit = resolve; });
const stderrStream = process.stderr as any;
const originalStderrWrite = stderrStream.write.bind(stderrStream);
stderrStream.write = (...args: any[]) => {
	if (String(args[0]).includes("rpc-stderr-sentinel")) leakedToParent = true;
	return originalStderrWrite(...args);
};
const stderr = createProcess("stderr", {
	stderrSink: (chunk) => {
		stderrBytes += chunk.byteLength;
		stderrText += Buffer.from(chunk).toString("utf8");
		if (stderrBytes >= SUBAGENT_RPC_MAX_STDERR_BYTES) resolveStderrLimit();
	},
});
try {
	await within(stderr.rpc.getState());
	await within(stderrLimitReached);
	const stderrEnd = once(stderr.rpc.child.stderr!, "end");
	await within(stderr.rpc.stop());
	await within(stderrEnd);
} finally {
	await within(stderr.rpc.stop());
	stderrStream.write = originalStderrWrite;
}
assert.equal(stderrBytes, SUBAGENT_RPC_MAX_STDERR_BYTES);
assert.ok(stderrText.includes("rpc-stderr-sentinel"));
assert.equal(leakedToParent, false);

let exitSignal: NodeJS.Signals | null = null;
const stubborn = createProcess("ignore-term", {
	onExit: (_code, signal) => { exitSignal = signal; },
});
const stopStartedAt = Date.now();
await within(stubborn.rpc.stop(), 5_000);
assert.ok(Date.now() - stopStartedAt >= 1_400);
assert.equal(exitSignal, "SIGKILL");
assert.equal(stubborn.rpc.child.signalCode, "SIGKILL");

console.log("subagent RPC tests passed");
