import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import subagentChildExtension from "../child.ts";
import { resolveSubagentSocketPath, SubagentIpcServer } from "../ipc.ts";
import type { SubagentLoadout } from "../launch.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-child-"));
const socketPath = resolveSubagentSocketPath("child-test", tempDir);
const previous = {
	socket: process.env.PI_SUBAGENT_SOCKET,
	token: process.env.PI_SUBAGENT_TOKEN,
	owner: process.env.PI_SUBAGENT_OWNER,
	child: process.env.PI_SUBAGENT_CHILD_SESSION_ID,
	loadout: process.env.PI_SUBAGENT_LOADOUT,
};
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
const sentMessages: string[] = [];
const helloPayloads: unknown[] = [];
const resultPayloads: unknown[] = [];
const PARKED_DELAY_MS = 5_100;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const loadoutPath = path.join(tempDir, "loadout.json");
const loadout: SubagentLoadout = {
	version: 1,
	parentSessionId: "child-test",
	childSessionId: "child-session",
	owner: "child-owner",
	role: "worker",
	agentName: "worker",
	cwd: process.cwd(),
	extensionPath: "child.ts",
	tools: ["read", "ask_question", "subagent", "browser_console", "browser_close"],
	appendSystemPrompt: "Agent rules",
	cavemanEnabled: true,
	depth: 0,
	subagentAgents: ["explorer"],
	createdAt: new Date().toISOString(),
};
fs.writeFileSync(loadoutPath, JSON.stringify(loadout));

const server = new SubagentIpcServer({
	socketPath,
	token: "child-test-token",
	onHello: (_owner, payload) => { helloPayloads.push(payload); },
	onRequest: async (request) => {
		if (request.type === "question") {
			await delay(PARKED_DELAY_MS);
			return { answer: "yes" };
		}
		if (request.type === "spawn") {
			await delay(PARKED_DELAY_MS);
			return { owner: "nested-owner", childSessionId: "nested-child", text: "nested result" };
		}
		if (request.type === "browser") return { content: [{ type: "text", text: "browser result" }], details: { ok: true } };
		if (request.type === "result") resultPayloads.push(request.payload);
		return undefined;
	},
});
const fakePi = {
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
		handlers.set(name, handler);
	},
	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) {
		tools.set(tool.name, tool);
	},
	sendUserMessage(content: string) {
		sentMessages.push(content);
	},
};

process.env.PI_SUBAGENT_SOCKET = socketPath;
process.env.PI_SUBAGENT_TOKEN = server.token;
process.env.PI_SUBAGENT_OWNER = "child-owner";
process.env.PI_SUBAGENT_CHILD_SESSION_ID = "child-session";
process.env.PI_SUBAGENT_LOADOUT = loadoutPath;

try {
	await server.listen();
	subagentChildExtension(fakePi as never);
	assert.ok(tools.has("ask_question"));
	assert.ok(tools.has("subagent"));
	assert.ok(tools.has("browser_console"));
	assert.ok(tools.has("browser_close"));
	const sessionFile = path.join(tempDir, "child-session.jsonl");
	await handlers.get("session_start")?.({}, { sessionManager: { getSessionFile: () => sessionFile } });
	assert.deepEqual(helloPayloads, [{ pid: process.pid, sessionFile }]);
	const questionStartedAt = Date.now();
	const questionResult = await tools.get("ask_question")!.execute("question-call", { question: "Continue?", options: ["yes", "no"] }, new AbortController().signal, undefined, {});
	assert.ok(Date.now() - questionStartedAt >= PARKED_DELAY_MS - 250);
	assert.deepEqual((questionResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "yes" });
	const nestedStartedAt = Date.now();
	const nestedResult = await tools.get("subagent")!.execute("nested-call", { agent: "explorer", task: "inspect" }, new AbortController().signal, undefined, {});
	assert.ok(Date.now() - nestedStartedAt >= PARKED_DELAY_MS - 250);
	assert.deepEqual((nestedResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "nested result" });
	const refusedResult = await tools.get("subagent")!.execute("nested-refused", { agent: "worker", task: "inspect" }, new AbortController().signal, undefined, {});
	assert.match((refusedResult as { content: Array<{ text: string }> }).content[0]!.text, /allowed child agents/);
	const browserResult = await tools.get("browser_console")!.execute("browser-call", { clear: false }, new AbortController().signal, undefined, {});
	assert.deepEqual((browserResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "browser result" });
	const connection = server.getConnection("child-owner");
	assert.ok(connection);
	assert.deepEqual(await connection.request("message", { text: "parent says hello" }), { accepted: true });
	assert.deepEqual(sentMessages, ["parent says hello"]);

	let shutdownCount = 0;
	const lifecycleContext = { sessionManager: { getSessionFile: () => sessionFile }, shutdown: () => { shutdownCount += 1; } };
	handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "pre-retry" }] }] }, lifecycleContext);
	assert.deepEqual(resultPayloads, []);
	handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "final result" }] }] }, lifecycleContext);
	handlers.get("agent_settled")?.({}, lifecycleContext);
	await delay(50);
	assert.deepEqual(resultPayloads, [{ childSessionId: "child-session", text: "final result", sessionFile }]);
	assert.equal(shutdownCount, 1);
	handlers.get("agent_settled")?.({}, lifecycleContext);
	await delay(10);
	assert.equal(resultPayloads.length, 1);
	assert.equal(shutdownCount, 1);

	await handlers.get("session_shutdown")?.({}, {});
	await delay(10);
	handlers.clear();
	subagentChildExtension(fakePi as never);
	await handlers.get("session_start")?.({}, { sessionManager: { getSessionFile: () => undefined } });
	assert.deepEqual(helloPayloads[1], { pid: process.pid });
	const noSessionLifecycleContext = { sessionManager: { getSessionFile: () => undefined }, shutdown: () => { shutdownCount += 1; } };
	handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "no session file" }] }] }, noSessionLifecycleContext);
	handlers.get("agent_settled")?.({}, noSessionLifecycleContext);
	await delay(50);
	assert.deepEqual(resultPayloads[1], { childSessionId: "child-session", text: "no session file" });
	console.log("subagent child tests passed");
} finally {
	await handlers.get("session_shutdown")?.({}, {});
	await server.close();
	for (const [key, value] of Object.entries(previous)) {
		const envKey = key === "socket" ? "PI_SUBAGENT_SOCKET" : key === "token" ? "PI_SUBAGENT_TOKEN" : key === "owner" ? "PI_SUBAGENT_OWNER" : key === "child" ? "PI_SUBAGENT_CHILD_SESSION_ID" : "PI_SUBAGENT_LOADOUT";
		if (value === undefined) delete process.env[envKey];
		else process.env[envKey] = value;
	}
	fs.rmSync(tempDir, { recursive: true, force: true });
}
