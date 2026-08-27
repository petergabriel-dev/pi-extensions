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
	tools: ["read", "ask_question", "subagent"],
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
	onRequest: (request) => {
		if (request.type === "question") return { answer: "yes" };
		if (request.type === "spawn") return { owner: "nested-owner", childSessionId: "nested-child", text: "nested result" };
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
	await handlers.get("session_start")?.({}, {});
	const questionResult = await tools.get("ask_question")!.execute("question-call", { question: "Continue?", options: ["yes", "no"] }, new AbortController().signal, undefined, {});
	assert.deepEqual((questionResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "yes" });
	const nestedResult = await tools.get("subagent")!.execute("nested-call", { agent: "explorer", task: "inspect" }, new AbortController().signal, undefined, {});
	assert.deepEqual((nestedResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "nested result" });
	const refusedResult = await tools.get("subagent")!.execute("nested-refused", { agent: "worker", task: "inspect" }, new AbortController().signal, undefined, {});
	assert.match((refusedResult as { content: Array<{ text: string }> }).content[0]!.text, /allowed child agents/);
	const connection = server.getConnection("child-owner");
	assert.ok(connection);
	assert.deepEqual(await connection.request("message", { text: "parent says hello" }), { accepted: true });
	assert.deepEqual(sentMessages, ["parent says hello"]);
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
