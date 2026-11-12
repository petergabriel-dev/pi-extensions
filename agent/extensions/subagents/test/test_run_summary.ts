import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import subagentsExtension from "../index.ts";
import {
	MAX_RUN_EVIDENCE_FAILED_COMMANDS,
	MAX_RUN_EVIDENCE_FILES,
	SubagentFailureError,
	SubagentLaunchHost,
	type SubagentLaunchHandle,
	type SubagentLaunchOptions,
	type SubagentResult,
	type SubagentRunEvidence,
} from "../launch.ts";

console.log("Running test_run_summary...");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-summary-"));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-rpc-child.mjs", import.meta.url));
const children: ChildProcess[] = [];
const tokens: string[] = [];

function fakeSpawn(mode: string): (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess {
	return (_command, _args, options) => {
		const child = spawn(process.execPath, [fixturePath, "--fixture-mode", mode], options);
		children.push(child);
		tokens.push(String(options.env?.PI_SUBAGENT_TOKEN ?? ""));
		return child;
	};
}

function launchOptions(parentSessionId: string, owner: string) {
	return {
		parentSessionId,
		owner,
		role: "worker" as const,
		agent: { name: "worker", systemPrompt: "Agent rules", model: "openai/test-model" },
		cwd: process.cwd(),
		task: "do work",
		tools: ["read", "bash", "edit", "write"],
		cavemanEnabled: true,
		childSessionId: `${owner}-session`,
	};
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

async function eventually(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

try {
	// Host: tool counts, successful edit/write paths, failed bash with exit and redacted tail.
	{
		const host = new SubagentLaunchHost({ parentSessionId: "summary-done", agentDir: tempDir, spawnProcess: fakeSpawn("evidence") });
		try {
			const handle = await host.launch(launchOptions("summary-done", "worker-done"));
			await handle.result;
			await waitForExit(children.at(-1)!);
			const token = tokens.at(-1)!;
			assert.ok(token);
			const evidence = host.readRunEvidence("worker-done")!;
			assert.ok(evidence, "evidence is retained after the run is released");
			assert.deepEqual({ ...evidence.tools }, { bash: 2, edit: 1, write: 1, read: 1 });
			assert.deepEqual(evidence.files, ["src/a.ts"], "only successful edit/write paths");
			assert.equal(evidence.failedCommands.length, 1);
			const [failed] = evidence.failedCommands;
			assert.equal(failed.exit, 3);
			const serialized = JSON.stringify(evidence);
			assert.ok(!serialized.includes(token), "run token is redacted");
			assert.ok(!serialized.includes(`ghp_${"a1".repeat(18)}`), "secret patterns are redacted");
			assert.ok(failed.cmd.startsWith("npm test --token "));
			assert.ok(Buffer.byteLength(failed.tail, "utf8") <= 2048 && failed.tail.endsWith("Command exited with code 3"));
		} finally {
			await host.close();
		}
	}

	// Host: evidence survives a run that fails after its tool events.
	{
		const host = new SubagentLaunchHost({ parentSessionId: "summary-exit", agentDir: tempDir, spawnProcess: fakeSpawn("evidence-exit") });
		try {
			const handle = await host.launch(launchOptions("summary-exit", "worker-exit"));
			await assert.rejects(handle.result, SubagentFailureError);
			await waitForExit(children.at(-1)!);
			const evidence = host.readRunEvidence("worker-exit")!;
			assert.equal(evidence.failedCommands[0]?.exit, 3);
			assert.deepEqual(evidence.files, ["src/a.ts"]);
		} finally {
			await host.close();
		}
	}

	// Host: caps on files and failed commands.
	{
		const host = new SubagentLaunchHost({ parentSessionId: "summary-cap", agentDir: tempDir, spawnProcess: fakeSpawn("evidence-cap") });
		try {
			const handle = await host.launch(launchOptions("summary-cap", "worker-cap"));
			await handle.result;
			await waitForExit(children.at(-1)!);
			const evidence = host.readRunEvidence("worker-cap")!;
			assert.equal(evidence.files.length, MAX_RUN_EVIDENCE_FILES);
			assert.equal(evidence.droppedFiles, 60 - MAX_RUN_EVIDENCE_FILES);
			assert.equal(evidence.failedCommands.length, MAX_RUN_EVIDENCE_FAILED_COMMANDS);
			assert.equal(evidence.droppedFailedCommands, 15 - MAX_RUN_EVIDENCE_FAILED_COMMANDS);
		} finally {
			await host.close();
		}
	}

	// Extension: exactly one subagents:run-summary per run on each terminal path.
	{
		const parentSessionId = "summary-extension";
		const registeredTools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
		const summaries: Array<Record<string, unknown>> = [];
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
				if (name === "subagents:run-summary") summaries.push(data as Record<string, unknown>);
				for (const listener of eventHandlers.get(name) ?? []) listener(data);
			},
		};
		const pi = {
			on(name: string, handler: (event: unknown, context: unknown) => unknown) { handlers.set(name, handler); },
			events,
			getThinkingLevel: () => "medium",
			sendUserMessage() {},
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
		const outcomes = ["done", "failed", "stopped", "launch_failed"];
		const owners: string[] = [];
		const evidence: SubagentRunEvidence = { tools: { bash: 1 }, files: ["src/x.ts"], failedCommands: [{ cmd: "npm test", exit: 1, tail: "fail" }], droppedFiles: 0, droppedFailedCommands: 0 };
		const originalLaunch = SubagentLaunchHost.prototype.launch;
		const originalRead = SubagentLaunchHost.prototype.readRunEvidence;
		let launchIndex = 0;
		SubagentLaunchHost.prototype.launch = async function (options: SubagentLaunchOptions): Promise<SubagentLaunchHandle> {
			const outcome = outcomes[launchIndex++]!;
			owners.push(options.owner);
			if (outcome === "launch_failed") throw new Error("launch boom");
			const resultValue: SubagentResult = { owner: options.owner, childSessionId: `${options.owner}-child`, text: "result" };
			const failure = (kind: "process" | "stopped") => new SubagentFailureError(options.owner, { transport: "rpc", kind, logPath: "/tmp/log", error: "boom", tail: "" });
			const result = outcome === "done" ? Promise.resolve(resultValue) : Promise.reject(failure(outcome === "stopped" ? "stopped" : "process"));
			result.catch(() => undefined);
			return { owner: options.owner, childSessionId: resultValue.childSessionId, pid: undefined, loadoutPath: `/tmp/${options.owner}.json`, transport: "rpc", logPath: "/tmp/log", result, request: async () => undefined, kill() {} };
		};
		SubagentLaunchHost.prototype.readRunEvidence = function () { return evidence; };
		try {
			subagentsExtension(pi as never);
			const launchTool = registeredTools.get("subagent")!;
			for (let index = 0; index < outcomes.length; index += 1) {
				await launchTool.execute(`call-${index}`, { task: `task-${index}`, agentScope: "project" }, new AbortController().signal, undefined, context);
			}
			await eventually(() => summaries.length >= outcomes.length, "run summaries");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(summaries.length, outcomes.length, "exactly one summary per run");
			assert.deepEqual(summaries.map((summary) => [summary.owner, summary.status]), owners.map((owner, index) => [owner, outcomes[index]]));
			for (const summary of summaries) {
				assert.equal(typeof summary.agentName, "string");
				assert.ok(Number.isFinite(summary.startedAt) && Number.isFinite(summary.finishedAt));
				assert.deepEqual(summary.failedCommands, evidence.failedCommands);
			}
		} finally {
			SubagentLaunchHost.prototype.launch = originalLaunch;
			SubagentLaunchHost.prototype.readRunEvidence = originalRead;
			await handlers.get("session_shutdown")?.({}, context);
		}
	}
} finally {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("test_run_summary passed");
