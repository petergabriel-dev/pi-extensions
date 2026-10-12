#!/usr/bin/env node
/* Claude Code statusline peer badge. Presence-only; never creates bridge requests. */

const client = require("./pi-bridge-mcp.js");

const MAX_HOOK_INPUT_CHARS = 1_048_576;

async function readStatusInput() {
	process.stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > MAX_HOOK_INPUT_CHARS) throw new Error("Status input too large.");
	}
	return JSON.parse(input);
}

function statusBadge(input) {
	if (!input || typeof input !== "object" || Array.isArray(input) || !client.isSafeId(input.session_id)) return "";
	const identity = { harness: "claude", id: input.session_id };
	try {
		const projectRoot = client.resolveProjectRoot(input.cwd || input.working_directory || process.env.CLAUDE_PROJECT_DIR || process.cwd());
		const paired = client.findPairedLiveSessions(projectRoot, identity);
		if (paired.length !== 1) return "";
		const peer = paired[0].presence.peers.find((candidate) => candidate.harness === identity.harness && candidate.id === identity.id);
		return peer && peer.pendingCount > 0 ? `Pi ✉${peer.pendingCount}` : "";
	} catch {
		return "";
	}
}

async function main() {
	try {
		const badge = statusBadge(await readStatusInput());
		if (badge) process.stdout.write(`${badge}\n`);
	} catch { /* Statusline fails open without stderr or output. */ }
}

module.exports = { statusBadge };

if (require.main === module) void main();
