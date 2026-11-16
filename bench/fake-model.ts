// Scripted OpenAI-compatible endpoint for review fixtures: replays fixed tool calls so a
// real Pi Build produces repeatable evidence. Adapted from
// agent/extensions/subagents/test/smoke/fake-openai-server.mjs. Loopback only.
import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const SCRIPT_MARKER = "Implement the next task in the saved plan.";

export interface ScriptStep {
	call?: { name: string; args: Record<string, unknown> | ((lastToolResult: string) => Record<string, unknown>) };
	text?: string;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
}

export async function startFakeModel(script: ScriptStep[], apiKey: string) {
	const state = { requests: 0, steps: 0, done: false, errors: [] as string[] };
	let callId = 0;
	const server = createServer((request, response) => {
		void (async () => {
			const fail = (status: number, message: string) => {
				state.errors.push(message);
				response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
			};
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") return fail(404, "expected POST /v1/chat/completions");
			if (request.headers.authorization !== `Bearer ${apiKey}`) return fail(401, "unexpected credential");
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				bytes += (chunk as Buffer).byteLength;
				if (bytes > MAX_REQUEST_BYTES) return fail(413, "request too large");
				chunks.push(chunk as Buffer);
			}
			let body: { model?: string; messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] };
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(400, "malformed JSON"); }
			state.requests += 1;
			const messages = Array.isArray(body.messages) ? body.messages : [];
			let start = -1;
			messages.forEach((message, index) => { if (message.role === "user" && textOf(message.content).includes(SCRIPT_MARKER)) start = index; });
			// Any request outside the scripted turn (or without tools) gets a plain answer.
			let step: ScriptStep = { text: "OK" };
			if (start >= 0 && Array.isArray(body.tools)) {
				const after = messages.slice(start + 1);
				const index = after.filter((message) => message.role === "tool").length;
				const lastTool = [...after].reverse().find((message) => message.role === "tool");
				if (index < script.length) {
					const entry = script[index];
					step = entry.call ? { call: { name: entry.call.name, args: typeof entry.call.args === "function" ? entry.call.args(textOf(lastTool?.content)) : entry.call.args } } : entry;
					state.steps = Math.max(state.steps, index + 1);
				} else {
					step = { text: "Done." };
				}
				if (index >= script.length - 1 && !step.call) state.done = true;
			}
			const id = `bench-call-${++callId}`;
			const args = step.call && typeof step.call.args === "object" ? step.call.args : {};
			const delta = step.call
				? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: step.call.name, arguments: JSON.stringify(args) } }] }
				: { role: "assistant", content: step.text ?? "" };
			const chunk = { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created: 0, model: body.model ?? "fake", choices: [{ index: 0, delta, finish_reason: step.call ? "tool_calls" : "stop" }] };
			response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		})().catch((error) => {
			state.errors.push(error instanceof Error ? error.message : String(error));
			if (!response.headersSent) response.writeHead(500).end();
			else response.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake model did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		state,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
