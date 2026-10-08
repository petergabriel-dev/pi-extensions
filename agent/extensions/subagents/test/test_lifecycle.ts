import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import subagentsExtension from "../index.ts";
import { getConcurrencySnapshot } from "../concurrency.ts";
import { SubagentIpcClient } from "../ipc.ts";
import {
	SubagentFailureError,
	SubagentLaunchHost,
	type SubagentLaunchHandle,
	type SubagentLaunchOptions,
	type SubagentResult,
} from "../launch.ts";
import type { SubagentWatchdogClock } from "../timeout.ts";

interface SpawnCall {
	child: ChildProcess;
	args: string[];
	options: SpawnOptions;
}

interface RunInternals {
	pendingQuestion?: unknown;
}

interface HostInternals {
	runs: Map<string, RunInternals>;
}

interface ServerInternals {
	runTokens: Map<string, string>;
	sockets: Set<unknown>;
}

interface Settlement<T> {
	count(): number;
	promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
}

class ManualClock implements SubagentWatchdogClock {
	private currentTime = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, ms: number): number {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.currentTime + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") this.timers.delete(handle);
	}

	now(): number {
		return this.currentTime;
	}

	get pendingCount(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		const deadline = this.currentTime + ms;
		while (true) {
			const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
			if (!next || next[1].at > deadline) break;
			this.timers.delete(next[0]);
			this.currentTime = next[1].at;
			next[1].callback();
		}
		this.currentTime = deadline;
	}
}

const tempDir = fs.mkdtempSync(path.join("/tmp", "pi-lc-"));
const agentDir = path.join(tempDir, "agent");
const fixturePath = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
fs.mkdirSync(agentDir, { recursive: true });

function deferred<T = void>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: (value?: T) => resolvePromise(value as T),
		reject: (error: unknown) => rejectPromise(error),
	};
}

function trackSettlement<T>(promise: Promise<T>): Settlement<T> {
	let count = 0;
	return {
		count: () => count,
		promise: promise.then(
			(value) => {
				count += 1;
				return { ok: true as const, value };
			},
			(error: unknown) => {
				count += 1;
				return { ok: false as const, error };
			},
		),
	};
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 4_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`${label} did not settle.`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await within("child exit", once(child, "exit"));
}

function makeProject(name: string, concurrencyCap = 2): string {
	const project = path.join(tempDir, name);
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { concurrencyCap } }));
	return project;
}

function launchOptions(parentSessionId: string, owner: string, cwd: string, options: Partial<SubagentLaunchOptions> = {}): SubagentLaunchOptions {
	return {
		parentSessionId,
		owner,
		role: "worker",
		agent: { name: "worker", systemPrompt: "Lifecycle test agent", model: undefined },
		cwd,
		task: "run lifecycle test",
		tools: ["read"],
		cavemanEnabled: true,
		childSessionId: `${owner}-child`,
		...options,
	};
}

function fakeSpawn(modes: string[], calls: SpawnCall[], onSpawn?: () => void) {
	let index = 0;
	return (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
		const mode = modes[Math.min(index, modes.length - 1)]!;
		index += 1;
		const child = spawn(process.execPath, [fixturePath, "--fixture-mode", mode], options);
		calls.push({ child, args: [...args], options });
		onSpawn?.();
		return child;
	};
}

function hostInternals(host: SubagentLaunchHost): HostInternals {
	return host as unknown as HostInternals;
}

function serverInternals(host: SubagentLaunchHost): ServerInternals {
	return host.server as unknown as ServerInternals;
}

async function assertHostClean(host: SubagentLaunchHost, clock: ManualClock, cwd: string): Promise<void> {
	await eventually(() => {
		const slots = getConcurrencySnapshot(cwd).defaultLane;
		return hostInternals(host).runs.size === 0 && serverInternals(host).runTokens.size === 0 && slots.active === 0 && slots.queued === 0 && clock.pendingCount === 0;
	}, "host cleanup");
	assert.deepEqual(host.getOwnershipSnapshot(), {});
	assert.equal(hostInternals(host).runs.size, 0);
	assert.equal(serverInternals(host).runTokens.size, 0);
	assert.equal(serverInternals(host).sockets.size, 0);
	assert.equal(getConcurrencySnapshot(cwd).defaultLane.active, 0);
	assert.equal(getConcurrencySnapshot(cwd).defaultLane.queued, 0);
	assert.equal(clock.pendingCount, 0);
}

async function timedCase(name: string, run: () => Promise<void>): Promise<void> {
	const startedAt = Date.now();
	await run();
	assert.ok(Date.now() - startedAt < 5_000, `${name} exceeded 5 seconds.`);
}

async function testTimeoutExitRaces(): Promise<void> {
	const project = makeProject("timeout-races");
	for (const scenario of [
		{ name: "idle", idleMs: 100, maxTotalMs: 1_000, advanceMs: 100, message: /idle timeout exceeded/ },
		{ name: "max-total", idleMs: 1_000, maxTotalMs: 100, advanceMs: 100, message: /maximum total timeout exceeded/ },
	]) {
		await timedCase(`${scenario.name} timeout/exit race`, async () => {
			const clock = new ManualClock();
			const calls: SpawnCall[] = [];
			const host = new SubagentLaunchHost({
				parentSessionId: `timeout-${scenario.name}`,
				agentDir,
				spawnProcess: fakeSpawn(["wait"], calls),
				watchdogClock: clock,
				timeoutPolicy: { idleTimeoutMs: scenario.idleMs, maxTotalMs: scenario.maxTotalMs },
			});
			try {
				const handle = await within("timeout race launch", host.launch(launchOptions(`timeout-${scenario.name}`, `writer-${scenario.name}`, project, { tools: ["edit"], fileOwnership: [`${scenario.name}/**`] })));
				const settled = trackSettlement(handle.result);
				const child = calls[0]!.child;
				child.kill("SIGTERM");
				clock.advance(scenario.advanceMs);
				const outcome = await within("timeout race result", settled.promise);
				assert.equal(outcome.ok, false);
				assert.ok(outcome.error instanceof SubagentFailureError);
				assert.match(outcome.error.info.error, scenario.message);
				assert.equal(settled.count(), 1);
				await waitForExit(child);
				await assertHostClean(host, clock, project);
			} finally {
				await host.close();
			}
		});
	}
}

async function testAbortAndIpcDisconnectRace(): Promise<void> {
	await timedCase("abort/IPC disconnect race", async () => {
		const project = makeProject("abort-disconnect");
		const clock = new ManualClock();
		const calls: SpawnCall[] = [];
		const browserStarted = deferred();
		const browserGate = deferred();
		const browserFinished = deferred();
		const questionStarted = deferred();
		const controller = new AbortController();
		const owner = "abort-disconnect-owner";
		const host = new SubagentLaunchHost({
			parentSessionId: "abort-disconnect",
			agentDir,
			spawnProcess: fakeSpawn(["question"], calls),
			watchdogClock: clock,
			timeoutPolicy: { idleTimeoutMs: 100, maxTotalMs: 1_000 },
			onBrowser: async () => {
				browserStarted.resolve();
				await browserGate.promise;
				browserFinished.resolve();
				return { ok: true };
			},
		});
		try {
			const handle = await within("abort race launch", host.launch(launchOptions("abort-disconnect", owner, project, {
				tools: ["read", "browser_console"],
				signal: controller.signal,
				onQuestion: () => { questionStarted.resolve(); },
			})));
			const settled = trackSettlement(handle.result);
			await within("question arrival", questionStarted.promise);
			const run = hostInternals(host).runs.get(owner)!;
			assert.ok(run.pendingQuestion);

			const token = calls[0]!.options.env?.PI_SUBAGENT_TOKEN;
			assert.equal(typeof token, "string");
			const client = SubagentIpcClient.create({ socketPath: host.server.socketPath, owner, token: token! });
			const requestOutcome = client.request("browser", { tool: "browser_console", params: {} }).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await within("browser IPC request", browserStarted.promise);

			controller.abort();
			const clientClosing = client.close();
			const result = await within("aborted result", settled.promise);
			const request = await within("disconnected IPC result", requestOutcome);
			await clientClosing;
			assert.equal(result.ok, false);
			assert.match(String(result.error), /aborted/);
			assert.equal(request.ok, false);
			browserGate.resolve();
			await within("browser callback drain", browserFinished.promise);
			await eventually(() => run.pendingQuestion === undefined, "pending question cleanup");
			const connection = (client as unknown as { connection?: { pending: Map<string, unknown> } }).connection;
			assert.equal(connection?.pending.size ?? 0, 0);
			await waitForExit(calls[0]!.child);
			assert.equal(settled.count(), 1);
			await assertHostClean(host, clock, project);
		} finally {
			browserGate.resolve();
			await host.close();
		}
	});
}

async function testCloseDuringBrowserCleanup(): Promise<void> {
	await timedCase("host close/browser cleanup race", async () => {
		const project = makeProject("close-browser");
		const clock = new ManualClock();
		const calls: SpawnCall[] = [];
		const browserStarted = deferred();
		const browserGate = deferred();
		const browserFinished = deferred();
		let reapCount = 0;
		const host = new SubagentLaunchHost({
			parentSessionId: "close-browser",
			agentDir,
			spawnProcess: fakeSpawn(["result"], calls),
			watchdogClock: clock,
			onBrowser: async (_owner, payload) => {
				if ((payload as { tool?: string }).tool !== "browser_close") return undefined;
				reapCount += 1;
				browserStarted.resolve();
				await browserGate.promise;
				browserFinished.resolve();
				return { closed: true };
			},
		});
		try {
			const handle = await within("browser cleanup launch", host.launch(launchOptions("close-browser", "browser-owner", project, { tools: ["read", "browser_close"] })));
			const settled = trackSettlement(handle.result);
			const outcome = await within("browser cleanup result", settled.promise);
			assert.equal(outcome.ok, true);
			await within("browser reap start", browserStarted.promise);
			assert.equal(reapCount, 1);
			await within("host close during browser cleanup", host.close());
			await waitForExit(calls[0]!.child);
			assert.equal(reapCount, 1);
			browserGate.resolve();
			await within("browser cleanup completion", browserFinished.promise);
			await host.close();
			assert.equal(reapCount, 1);
			assert.equal(settled.count(), 1);
			await assertHostClean(host, clock, project);
		} finally {
			browserGate.resolve();
			await host.close();
		}
	});
}

async function testNestedFailureReleasesSlot(): Promise<void> {
	await timedCase("nested failure releases concurrency slot", async () => {
		const project = makeProject("nested-slot", 2);
		const clock = new ManualClock();
		const calls: SpawnCall[] = [];
		const activeAtSpawn: number[] = [];
		const modes = ["nested-spawn", "exit-before-settle", "result"];
		let host!: SubagentLaunchHost;
		const nestedStarted = deferred();
		const nestedFinished = deferred();
		let failureSettlement: Settlement<SubagentResult> | undefined;
		let recoveredSettlement: Settlement<SubagentResult> | undefined;
		const spawnProcess = (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			const mode = modes[calls.length]!;
			activeAtSpawn.push(getConcurrencySnapshot(project).defaultLane.active);
			const child = spawn(process.execPath, [fixturePath, "--fixture-mode", mode], options);
			calls.push({ child, args: [...args], options });
			return child;
		};
		host = new SubagentLaunchHost({
			parentSessionId: "nested-slot",
			agentDir,
			spawnProcess,
			watchdogClock: clock,
			onSpawn: async (owner) => {
				nestedStarted.resolve();
				try {
					assert.equal(owner, "nested-worker");
					const failed = await host.launch(launchOptions("nested-slot", "nested-explorer-failure", project, {
						role: "explorer",
						agent: { name: "explorer", systemPrompt: "Explorer", model: undefined },
					}));
					failureSettlement = trackSettlement(failed.result);
					const failure = await within("nested explorer failure", failureSettlement.promise);
					assert.equal(failure.ok, false);
					assert.ok(failure.error instanceof SubagentFailureError);
					const recovered = await host.launch(launchOptions("nested-slot", "nested-explorer-recovered", project, {
						role: "explorer",
						agent: { name: "explorer", systemPrompt: "Explorer", model: undefined },
					}));
					recoveredSettlement = trackSettlement(recovered.result);
					const recovery = await within("nested explorer recovery", recoveredSettlement.promise);
					assert.equal(recovery.ok, true);
					nestedFinished.resolve();
					return { recovered: recovery.value.text };
				} catch (error) {
					nestedFinished.reject(error);
					throw error;
				}
			},
		});
		try {
			const parent = await within("nested worker launch", host.launch(launchOptions("nested-slot", "nested-worker", project, { tools: ["read", "subagent"], subagentAgents: ["explorer"] })));
			const parentSettlement = trackSettlement(parent.result);
			await within("nested spawn start", nestedStarted.promise);
			await within("nested failure and recovery", nestedFinished.promise);
			assert.deepEqual(activeAtSpawn, [1, 2, 2]);
			assert.equal(failureSettlement?.count(), 1);
			assert.equal(recoveredSettlement?.count(), 1);
			assert.equal(getConcurrencySnapshot(project).defaultLane.active, 1);
			const parentResult = await within("nested worker result", parentSettlement.promise);
			assert.equal(parentResult.ok, true);
			await Promise.all(calls.map(({ child }) => waitForExit(child)));
			await eventually(() => host.server.getConnection("nested-worker") === undefined, "nested IPC disconnect");
			assert.equal(parentSettlement.count(), 1);
			await assertHostClean(host, clock, project);
		} finally {
			await host.close();
		}
	});
}

async function testLateResultAfterRecordEviction(): Promise<void> {
	await timedCase("late RPC result after record eviction", async () => {
		const parentSessionId = "late-result-eviction";
		const clock = new ManualClock();
		const calls: SpawnCall[] = [];
		const actualHost = new SubagentLaunchHost({
			parentSessionId,
			agentDir,
			spawnProcess: fakeSpawn(["follow-up"], calls),
			watchdogClock: clock,
		});
		const registeredTools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
		const sentMessages: string[] = [];
		const events = {
			on(name: string, handler: (data: unknown) => void) {
				const listeners = eventHandlers.get(name) ?? new Set();
				listeners.add(handler);
				eventHandlers.set(name, listeners);
				return () => listeners.delete(handler);
			},
			emit(name: string, data: unknown) {
				if (name === "workflow-modes:get") {
					for (const listener of eventHandlers.get("workflow-modes:state") ?? []) listener({ mode: "build", cavemanEnabled: true });
				}
				for (const listener of eventHandlers.get(name) ?? []) listener(data);
			},
		};
		const pi = {
			on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, handler); },
			events,
			getThinkingLevel: () => "medium",
			sendUserMessage(content: string) { sentMessages.push(content); },
			registerCommand() {},
			registerTool(tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) { registeredTools.set(tool.name, tool); },
		};
		const context = {
			cwd: process.cwd(),
			mode: "tui",
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: { getSessionId: () => parentSessionId },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
		};
		const originalLaunch = SubagentLaunchHost.prototype.launch;
		let launchCount = 0;
		let lateHandle: SubagentLaunchHandle | undefined;
		SubagentLaunchHost.prototype.launch = async function (options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
			if (launchCount++ === 0) {
				lateHandle = await originalLaunch.call(actualHost, options);
				return lateHandle;
			}
			const result: SubagentResult = { owner: options.owner, childSessionId: `${options.owner}-child`, text: `result-${options.owner}` };
			return {
				owner: options.owner,
				childSessionId: result.childSessionId,
				pid: undefined,
				loadoutPath: `/tmp/${options.owner}.json`,
				transport: "rpc",
				logPath: `/tmp/${options.owner}.log`,
				result: Promise.resolve(result),
				request: async () => undefined,
				kill() {},
			};
		};
		try {
			subagentsExtension(pi as never);
			const launchTool = registeredTools.get("subagent")!;
			const listTool = registeredTools.get("subagents_list")!;
			let firstOwner = "";
			for (let index = 0; index < 101; index += 1) {
				const result = await launchTool.execute(`call-${index}`, { task: `record-${index}`, agentScope: "project" }, new AbortController().signal, undefined, context);
				if (index === 0) firstOwner = (result as { details: { owner: string } }).details.owner;
			}
			const before = await listTool.execute("list-before", {}, new AbortController().signal, undefined, context) as { details: { agents: Array<{ owner: string }> } };
			assert.equal(before.details.agents.length, 100);
			assert.equal(before.details.agents.some((record) => record.owner === firstOwner), false);
			assert.ok(lateHandle);

			const lateSettlement = trackSettlement(lateHandle.result);
			await lateHandle.request("message", { text: "late result after eviction" });
			const outcome = await within("late evicted result", lateSettlement.promise);
			assert.equal(outcome.ok, true);
			assert.equal(outcome.value.text, "steer: late result after eviction");
			await eventually(() => sentMessages.filter((message) => message.includes("late result after eviction")).length === 1, "late parent result delivery");
			const after = await listTool.execute("list-after", {}, new AbortController().signal, undefined, context) as { details: { agents: Array<{ owner: string }> } };
			assert.equal(after.details.agents.length, 100);
			assert.equal(after.details.agents.some((record) => record.owner === firstOwner), false);
			assert.equal(sentMessages.filter((message) => message.includes("late result after eviction")).length, 1);
			await waitForExit(calls[0]!.child);
			assert.equal(lateSettlement.count(), 1);
			await assertHostClean(actualHost, clock, process.cwd());
		} finally {
			SubagentLaunchHost.prototype.launch = originalLaunch;
			await handlers.get("session_shutdown")?.({}, context);
			await actualHost.close();
		}
	});
}

try {
	await testTimeoutExitRaces();
	await testAbortAndIpcDisconnectRace();
	await testCloseDuringBrowserCleanup();
	await testNestedFailureReleasesSlot();
	await testLateResultAfterRecordEviction();
	console.log("subagent lifecycle race tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
