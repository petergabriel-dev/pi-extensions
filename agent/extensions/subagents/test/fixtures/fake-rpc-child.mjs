import process from "node:process";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--fixture-mode");
const mode = modeIndex === -1 ? "roundtrip" : args[modeIndex + 1];
let input = "";
let outputQueue = Promise.resolve();
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
		commandResponse(command, mode === "missing-disposition" ? undefined : { disposition: "started" });
		if (mode === "missing-disposition") return;
		sendRecord({ type: "message_update", marker: "separator:\u2028\u2029" }, "\n", true);
		sendRecord({ type: "extension_ui_request", id: "ui-value-1", method: "input", title: "Answer?" });
		sendRecord({ type: "extension_ui_request", id: "ui-cancel-2", method: "select", options: ["A", "B"] });
		return;
	}
	if (command.type === "extension_ui_response") {
		uiResponses.push(command.cancelled ? "cancelled" : String(command.value));
		if (uiResponses.length === 2) {
			sendRecord({ type: "queue_update", steering: uiResponses.map((value) => `ui:${value}`), followUp: [] });
		}
		return;
	}
	if (command.type === "get_state") {
		commandResponse(command, { sessionFile: "/tmp/fake-child-session.jsonl" });
		return;
	}
	if (command.type === "get_last_assistant_text") {
		commandResponse(command, { text: "fake assistant result" });
		return;
	}
	commandResponse(command);
}

if (mode === "oversize") {
	process.stdout.write("x".repeat(32 * 1024 * 1024 + 1) + "\n");
}
if (mode === "stderr") {
	process.stderr.write("rpc-stderr-sentinel\n" + "s".repeat(1024 * 1024 + 128));
}
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
