import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function textOf(value) {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n");
}

function toolName(call) {
	return typeof call?.function?.name === "string" ? call.function.name : undefined;
}

function completionResponse(response, model, state, text, call) {
	const callId = `smoke-call-${++state.callId}`;
	const delta = call
		? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
		: { role: "assistant", content: text };
	const chunk = {
		id: `chatcmpl-smoke-${state.callId}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
	};
	response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
	response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function errorResponse(response, status, message) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message, type: "smoke_fixture_error" } }));
}

export async function startFakeOpenAIServer({ browserAvailable, browserUrl, breakFinal = false, onRequest } = {}) {
	const state = {
		callId: 0,
		trace: [],
		errors: [],
		parentExplorerStarted: false,
		questionAsked: false,
		questionAnswered: false,
		parentAnsweredQuestion: false,
		workerStarted: false,
		nestedExplorerStarted: false,
		browserCallIssued: false,
		browserSkipped: false,
		browserNavigationReturned: false,
		finalResponseSent: false,
		brokenFinalSent: false,
	};

	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				return errorResponse(response, 404, "Expected POST /v1/chat/completions.");
			}
			if (request.headers.authorization !== "Bearer smoke-key") return errorResponse(response, 401, "Unexpected smoke endpoint credential.");

			const chunks = [];
			let bytes = 0;
			for await (const chunk of request) {
				bytes += chunk.byteLength;
				if (bytes > MAX_REQUEST_BYTES) return errorResponse(response, 413, "Smoke request exceeded size limit.");
				chunks.push(chunk);
			}

			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return errorResponse(response, 400, "Malformed smoke request JSON.");
			}
			if (typeof body.model !== "string" || !Array.isArray(body.messages) || !Array.isArray(body.tools)) {
				return errorResponse(response, 400, "Smoke request is missing model, messages, or tools.");
			}
			onRequest?.();

			const messages = body.messages;
			const allText = messages.map((message) => textOf(message.content)).join("\n");
			const lastUserText = textOf([...messages].reverse().find((message) => message.role === "user")?.content);
			const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
			const lastCallName = lastAssistant?.tool_calls?.map(toolName).find(Boolean);
			const lastToolResult = textOf([...messages].reverse().find((message) => message.role === "tool")?.content);
			const tools = new Set(body.tools.map(toolName).filter(Boolean));
			const isParent = tools.has("subagent_message");
			state.trace.push(`request:${body.model}:${lastUserText.slice(0, 80).replaceAll("\n", " ")}`);
			let answer;

			try {
				const waitingIndex = allText.lastIndexOf("is waiting for an answer.");
				const firstResultIndex = allText.lastIndexOf("Subagent subagent-1 finished.");
				const workerResultIndex = allText.lastIndexOf("Subagent subagent-2 finished.");

				if (isParent && workerResultIndex > firstResultIndex && workerResultIndex > waitingIndex) {
					state.finalResponseSent = true;
					state.trace.push("parent:final");
					if (breakFinal) {
						state.brokenFinalSent = true;
						answer = { text: "" };
					} else {
						answer = { text: `RPC_SMOKE_FINAL: question=green; browser=${browserAvailable ? "PASS" : "SKIPPED"}` };
					}
				} else if (isParent && waitingIndex > firstResultIndex) {
					if (lastCallName === "subagent_message") {
						answer = { text: "QUESTION_ANSWER_SENT" };
					} else {
						const owner = allText.match(/Subagent\s+(subagent-\d+)\s+is waiting/)?.[1];
						const questionId = allText.match(/Question ID:\s*([^\s]+)/)?.[1];
						if (!owner || !questionId) throw new Error("Parent question follow-up lacked owner or question ID.");
						state.parentAnsweredQuestion = true;
						state.trace.push("parent:answer-question");
						answer = { call: { name: "subagent_message", args: { owner, questionId, message: "green" } } };
					}
				} else if (isParent && firstResultIndex >= 0) {
					if (!state.workerStarted) {
						state.workerStarted = true;
						state.trace.push("parent:spawn-worker");
						answer = { call: { name: "subagent", args: { agent: "worker", task: "SMOKE_WORKER_NEST: Start an allowlisted explorer for the browser check." } } };
					} else {
						answer = { text: "WORKER_STARTED" };
					}
				} else if (isParent && allText.includes("SMOKE_PARENT_START")) {
					if (!state.parentExplorerStarted) {
						state.parentExplorerStarted = true;
						state.trace.push("parent:spawn-explorer");
						answer = { call: { name: "subagent", args: { agent: "explorer", task: "SMOKE_EXPLORER_ASK: Ask parent which color to use, then report the selected answer." } } };
					} else {
						answer = { text: "FIRST_EXPLORER_STARTED" };
					}
				} else if (!isParent && allText.includes("SMOKE_EXPLORER_ASK")) {
					if (lastCallName === "ask_question") {
						if (!lastToolResult.includes("green")) throw new Error("ask_question result did not contain selected option green.");
						state.questionAnswered = true;
						state.trace.push("explorer:question-answered");
						answer = { text: "EXPLORER_ANSWER=green" };
					} else {
						if (!tools.has("ask_question")) throw new Error("Explorer loadout omitted ask_question.");
						state.questionAsked = true;
						state.trace.push("explorer:ask-question");
						answer = { call: { name: "ask_question", args: { question: "Choose a color for the RPC smoke test.", options: ["green", "blue"] } } };
					}
				} else if (!isParent && allText.includes("SMOKE_WORKER_NEST")) {
					if (lastCallName === "subagent") {
						answer = { text: "WORKER_NESTED_EXPLORER_FINISHED" };
					} else {
						if (!tools.has("subagent")) throw new Error("Worker loadout omitted nested subagent tool.");
						state.nestedExplorerStarted = true;
						state.trace.push("worker:spawn-explorer");
						answer = { call: { name: "subagent", args: { agent: "explorer", task: `SMOKE_NESTED_EXPLORER_BROWSER: Navigate to ${browserUrl} and report the result.` } } };
					}
				} else if (!isParent && allText.includes("SMOKE_NESTED_EXPLORER_BROWSER")) {
					if (!browserAvailable) {
						state.browserSkipped = true;
						state.trace.push("nested-explorer:browser-skipped");
						answer = { text: "BROWSER_STEP_SKIPPED_CHROMIUM_MISSING" };
					} else if (lastCallName === "browser_goto") {
						const navigation = JSON.parse(lastToolResult);
						if (navigation.status !== 200 || navigation.finalUrl !== browserUrl) throw new Error(`browser_goto returned unexpected result: ${lastToolResult.slice(0, 300)}`);
						state.browserNavigationReturned = true;
						state.trace.push("nested-explorer:browser-returned");
						answer = { text: "BROWSER_NAVIGATION_COMPLETE" };
					} else {
						if (!tools.has("browser_goto")) throw new Error("Nested explorer loadout omitted browser_goto in Build mode.");
						state.browserCallIssued = true;
						state.trace.push("nested-explorer:browser-goto");
						answer = { call: { name: "browser_goto", args: { url: browserUrl, timeout: 10_000 } } };
					}
				} else {
					throw new Error(`Unexpected fake-model stage (model=${body.model}, lastUser=${lastUserText.slice(0, 180)}).`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				state.errors.push(message);
				return errorResponse(response, 500, message);
			}

			completionResponse(response, body.model, state, answer.text ?? "", answer.call);
		})().catch((error) => {
			state.errors.push(error instanceof Error ? error.message : String(error));
			if (!response.headersSent) errorResponse(response, 500, "Fake endpoint failed internally.");
			else response.destroy();
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fake endpoint did not bind a TCP port.");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		state,
		close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}
