#!/usr/bin/env node
/* Claude Code peer mailbox hook. Zero Pi imports; bridge requests use live client helpers. */

const client = require("./pi-bridge-mcp.js");

const PEER_HOOK_BUDGET_CHARS = 9_000;
const MAX_HOOK_INPUT_CHARS = 1_048_576;

async function readHookInput() {
	process.stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > MAX_HOOK_INPUT_CHARS) throw new Error("Hook input too large.");
	}
	return JSON.parse(input);
}

function hookIdentity(input) {
	if (!input || typeof input !== "object" || Array.isArray(input) || !client.isSafeId(input.session_id)) return null;
	return { harness: "claude", id: input.session_id };
}

function projectRootForInput(input) {
	return client.resolveProjectRoot(input.cwd || input.working_directory || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function writeHookOutput(output, payload) {
	return new Promise((resolve, reject) => {
		output.write(`${JSON.stringify(payload)}\n`, (error) => error ? reject(error) : resolve());
	});
}

function formatPeerEcho(messages, includedIds) {
	const byId = new Map(messages.map((message) => [message.id, message]));
	const selected = includedIds.map((id) => {
		const message = byId.get(id);
		if (!message || !client.isSafeId(message.from?.id) || typeof message.text !== "string") {
			throw new Error("Invalid included peer message.");
		}
		return message;
	});
	const lines = selected.slice(0, 3).map((message) => {
		let text = message.text
			.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		if (text.length > 200) {
			let truncated = "";
			for (const char of text) {
				if (truncated.length + char.length > 199) break;
				truncated += char;
			}
			text = `${truncated}…`;
		}
		return `Pi ${message.from.id.slice(0, 8)} (untrusted peer): ${text}`;
	});
	if (selected.length > 3) lines.push(`(+${selected.length - 3} more)`);
	return lines.join("\n");
}

async function handleHookInput(input, output = process.stdout) {
	const identity = hookIdentity(input);
	if (!identity) return;

	if (input.hook_event_name === "SessionEnd") {
		try {
			const projectRoot = projectRootForInput(input);
			const paired = client.findPairedLiveSessions(projectRoot, identity);
			await Promise.all(paired.map(async (session) => {
				try { await client.sendRequestToSession(projectRoot, session, "unpair", {}, identity); }
				catch { /* SessionEnd cleanup is best-effort. */ }
			}));
		} catch { /* Fail open; lifecycle cleanup must not affect Claude. */ }
		return;
	}

	if (input.hook_event_name !== "UserPromptSubmit") return;

	let projectRoot;
	let session;
	try {
		projectRoot = projectRootForInput(input);
		const paired = client.findPairedLiveSessions(projectRoot, identity);
		if (paired.length !== 1) return;
		session = paired[0];
		const peer = session.presence.peers.find((candidate) => candidate.harness === identity.harness && candidate.id === identity.id);
		if (!peer || peer.pendingCount <= 0) return;
	} catch {
		return;
	}

	let formatted;
	try {
		const response = await client.sendRequestToSession(projectRoot, session, "read_messages", {}, identity);
		const messages = response.result && response.result.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;
		formatted = client.formatPeerBlock(messages, PEER_HOOK_BUDGET_CHARS);
		if (!formatted.text || formatted.includedIds.length === 0) return;
		const payload = {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: formatted.text,
			},
		};
		try { payload.systemMessage = formatPeerEcho(messages, formatted.includedIds); }
		catch { /* Echo is advisory; preserve JSON context and acknowledgement path. */ }
		await writeHookOutput(output, payload);
	} catch {
		return;
	}

	// Output is flushed before ack. Failed ack leaves same ids pending for at-least-once delivery.
	try {
		await client.sendRequestToSession(projectRoot, session, "ack_messages", { ids: formatted.includedIds }, identity);
	} catch { /* Keep already-emitted context; unacked ids may redeliver unchanged. */ }
}

async function main() {
	let input;
	try { input = await readHookInput(); }
	catch { return; }
	try { await handleHookInput(input); }
	catch { /* Hooks fail open without stderr or output. */ }
}

module.exports = { formatPeerEcho, handleHookInput, hookIdentity };

if (require.main === module) void main();
