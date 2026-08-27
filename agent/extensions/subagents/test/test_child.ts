import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import subagentChildExtension from "../child.ts";
import { resolveSubagentSocketPath, SubagentIpcServer } from "../ipc.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-child-"));
const socketPath = resolveSubagentSocketPath("child-test", tempDir);
const previous = {
	socket: process.env.PI_SUBAGENT_SOCKET,
	token: process.env.PI_SUBAGENT_TOKEN,
	owner: process.env.PI_SUBAGENT_OWNER,
	child: process.env.PI_SUBAGENT_CHILD_SESSION_ID,
};
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
const sentMessages: string[] = [];

const server = new SubagentIpcServer({
	socketPath,
	token: "child-test-token",
	onRequest: (request) => request.type === "question" ? { answer: "yes" } : undefined,
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

try {
	await server.listen();
	subagentChildExtension(fakePi as never);
	assert.ok(tools.has("ask_question"));
	await handlers.get("session_start")?.({}, {});
	const questionResult = await tools.get("ask_question")!.execute("question-call", { question: "Continue?", options: ["yes", "no"] }, new AbortController().signal, undefined, {});
	assert.deepEqual((questionResult as { content: Array<{ text: string }> }).content[0], { type: "text", text: "yes" });
	const connection = server.getConnection("child-owner");
	assert.ok(connection);
	assert.deepEqual(await connection.request("message", { text: "parent says hello" }), { accepted: true });
	assert.deepEqual(sentMessages, ["parent says hello"]);
	console.log("subagent child tests passed");
} finally {
	await handlers.get("session_shutdown")?.({}, {});
	await server.close();
	for (const [key, value] of Object.entries(previous)) {
		const envKey = key === "socket" ? "PI_SUBAGENT_SOCKET" : key === "token" ? "PI_SUBAGENT_TOKEN" : key === "owner" ? "PI_SUBAGENT_OWNER" : "PI_SUBAGENT_CHILD_SESSION_ID";
		if (value === undefined) delete process.env[envKey];
		else process.env[envKey] = value;
	}
	fs.rmSync(tempDir, { recursive: true, force: true });
}
