import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--fixture-mode");
const mode = modeIndex === -1 ? "roundtrip" : args[modeIndex + 1];
let input = "";
let outputQueue = Promise.resolve();
let lastAssistantText = process.env.FAKE_RESULT ?? "fake assistant result";
const uiResponses = [];

function enqueueBytes(bytes, cuts = []) {
	outputQueue = outputQueue.then(async () => {
		const boundaries = [...new Set([0, ...cuts.filter((cut) => cut > 0 && cut < bytes.length), bytes.length])].sort((a, b) => a - b);
		for (let index = 0; index < boundaries.length - 1; index += 1) {
			process.stdout.write(bytes.subarray(boundaries[index], boundaries[index + 1]));
			if (index < boundaries.length - 2) await new Promise((resolve) => setTimeout(resolve, 1));
		}
	}).catch(() => undefined);
}

function sendRecord(record, ending = "\n", splitUnicode = false) {
	const bytes = Buffer.from(`${JSON.stringify(record)}${ending}`, "utf8");
	const cuts = [Math.floor(bytes.length / 2)];
	if (splitUnicode) {
		for (const separator of ["\u2028", "\u2029"]) {
			const offset = bytes.indexOf(Buffer.from(separator));
			if (offset >= 0) cuts.push(offset + 1, offset + 2);
		}
	}
	enqueueBytes(bytes, cuts);
}

function commandResponse(command, data) {
	sendRecord({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) }, command.type === "prompt" ? "\r\n" : "\n", command.type === "prompt");
}

function finishRun() {
	sendRecord({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lastAssistantText }] } });
	sendRecord({ type: "agent_settled" });
}

function sendIpcFrame(socket, record) {
	const body = Buffer.from(JSON.stringify(record));
	const frame = Buffer.alloc(4 + body.length);
	frame.writeUInt32BE(body.length, 0);
	body.copy(frame, 4);
	socket.write(frame);
}

function startBrowserRequest() {
	const socket = net.createConnection(process.env.PI_SUBAGENT_SOCKET);
	let ipcBuffer = Buffer.alloc(0);
	socket.on("error", () => undefined);
	socket.on("connect", () => sendIpcFrame(socket, {
		kind: "request",
		token: process.env.PI_SUBAGENT_TOKEN,
		requestId: "hello",
		owner: process.env.PI_SUBAGENT_OWNER,
		type: "hello",
		payload: { pid: process.pid },
	}));
	socket.on("data", (chunk) => {
		ipcBuffer = Buffer.concat([ipcBuffer, chunk]);
		while (ipcBuffer.length >= 4) {
			const length = ipcBuffer.readUInt32BE(0);
			if (ipcBuffer.length < length + 4) return;
			const response = JSON.parse(ipcBuffer.subarray(4, length + 4).toString("utf8"));
			ipcBuffer = ipcBuffer.subarray(length + 4);
			if (response.kind !== "response") continue;
			if (response.requestId === "hello") {
				sendIpcFrame(socket, {
					kind: "request",
					token: process.env.PI_SUBAGENT_TOKEN,
					requestId: "browser",
					owner: process.env.PI_SUBAGENT_OWNER,
					type: "browser",
					payload: { tool: "browser_console", params: { clear: false } },
				});
			} else if (response.requestId === "browser") {
				socket.end();
				finishRun();
			}
		}
	});
}

function handleCommand(command) {
	if (mode === "correlation") {
		if (command.type === "follow_up") {
			setTimeout(() => sendRecord({ id: command.id, type: "response", command: command.type, success: false, error: "expected follow_up failure" }), 25);
			return;
		}
		if (command.type === "steer") {
			commandResponse(command);
			return;
		}
	}
	if (mode === "exit") {
		setTimeout(() => process.exit(23), 10);
		return;
	}
	if (mode === "hang" || mode === "ignore-term") return;
	if (command.type === "prompt") {
		if (mode === "ready-hang") return;
		const disposition = mode === "handled" ? "handled" : mode === "missing-disposition" ? undefined : "started";
		commandResponse(command, disposition === undefined ? undefined : { disposition });
		if (mode === "handled" || mode === "missing-disposition" || mode === "follow-up" || mode === "wait" || mode === "abort" || mode === "ready-hang") return;
		if (mode === "roundtrip" || mode === "stderr") {
			sendRecord({ type: "message_update", marker: "separator:\u2028\u2029" }, "\n", true);
			sendRecord({ type: "extension_ui_request", id: "ui-value-1", method: "input", title: "Answer?" });
			sendRecord({ type: "extension_ui_request", id: "ui-cancel-2", method: "select", options: ["A", "B"] });
			return;
		}
		if (mode === "question" || mode === "question-input") {
			sendRecord({
				type: "extension_ui_request",
				id: "question-ui-1",
				method: mode === "question" ? "select" : "input",
				title: "Which answer?",
				...(mode === "question" ? { options: ["yes", "no"] } : {}),
			});
			return;
		}
		if (mode === "browser") {
			startBrowserRequest();
			return;
		}
		if (mode === "exit-before-settle") {
			process.stderr.write(`sentinel stderr ${process.env.PI_SUBAGENT_TOKEN}\n`);
			setTimeout(() => process.exit(23), 25);
			return;
		}
		if (mode === "tail") {
			const token = process.env.PI_SUBAGENT_TOKEN;
			sendRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `tail sentinel ${token.slice(0, 32)}` } });
			sendRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: token.slice(32) } });
			return;
		}
		if (mode === "launch") {
			sendRecord({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" });
			sendRecord({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read" });
			finishRun();
			return;
		}
		if (mode === "result") {
			finishRun();
			return;
		}
		return;
	}
	if (command.type === "extension_ui_response") {
		uiResponses.push(command.cancelled ? "cancelled" : String(command.value));
		if (mode === "question" || mode === "question-input") {
			lastAssistantText = `answer used: ${uiResponses.at(-1)}`;
			finishRun();
			return;
		}
		if (uiResponses.length === 2) {
			sendRecord({ type: "queue_update", steering: uiResponses.map((value) => `ui:${value}`), followUp: [] });
		}
		return;
	}
	if (command.type === "follow_up") {
		if (mode === "follow-up") {
			lastAssistantText = `follow-up: ${command.message}`;
			commandResponse(command);
			finishRun();
			return;
		}
		if (mode === "wait") {
			commandResponse(command);
			lastAssistantText = `follow-up: ${command.message}`;
			finishRun();
			return;
		}
	}
	if (command.type === "abort") {
		commandResponse(command);
		return;
	}
	if (command.type === "get_state") {
		commandResponse(command, { sessionFile: "/tmp/fake-child-session.jsonl" });
		return;
	}
	if (command.type === "get_last_assistant_text") {
		commandResponse(command, { text: lastAssistantText });
		return;
	}
	commandResponse(command);
}

if (mode === "oversize") process.stdout.write("x".repeat(32 * 1024 * 1024 + 1) + "\n");
if (mode === "stderr") process.stderr.write("rpc-stderr-sentinel\n" + "s".repeat(1024 * 1024 + 128));
if (mode === "roundtrip" || mode === "stderr") {
	enqueueBytes(Buffer.from("not-json\n", "utf8"));
	sendRecord({ type: "future_rpc_event", ignored: true });
}
if (mode === "ignore-term") {
	process.on("SIGTERM", () => undefined);
	process.stdin.on("end", () => undefined);
	setInterval(() => undefined, 1_000);
}

process.stdin.on("data", (chunk) => {
	input += chunk.toString("utf8");
	let newline;
	while ((newline = input.indexOf("\n")) !== -1) {
		const line = input.slice(0, newline).replace(/\r$/, "");
		input = input.slice(newline + 1);
		try { handleCommand(JSON.parse(line)); }
		catch { process.stderr.write("fake child received malformed command\n"); }
	}
});

process.stdin.on("end", () => {
	if (mode !== "ignore-term") outputQueue.finally(() => process.exit(0));
});
