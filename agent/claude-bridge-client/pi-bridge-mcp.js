#!/usr/bin/env node
/*
 * Claude Code MCP client for Pi bridge.
 * Zero Pi imports by design. Talks only to <project>/.pi/memory/bridge/*.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const BRIDGE_TIMEOUT_MS = 2_000;
const POLL_MS = 100;
const LOCK_TTL_MS = 5_000;
// Cache session heartbeat for DEBOUNCE_CACHE_MS to avoid hammering session.json
// on burst requests. Re-read on cache miss or when we expect a new heartbeat.
const DEBOUNCE_CACHE_MS = 1_000;
const SERVER_NAME = "pi-claude-bridge";
const SERVER_VERSION = "0.1.0";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
	return new Date().toISOString();
}

function isDir(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function findPiProjectRoot(start = process.cwd()) {
	let dir = path.resolve(start);
	while (true) {
		if (isDir(path.join(dir, ".pi"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function bridgePaths(projectRoot) {
	const root = path.join(projectRoot, ".pi", "memory", "bridge");
	return {
		root,
		requests: path.join(root, "requests"),
		responses: path.join(root, "responses"),
		processed: path.join(root, "processed"),
		policy: path.join(root, "policy.json"),
		session: path.join(root, "session.json"),
	};
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeFileAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `${path.basename(file)}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`);
	let fd;
	try {
		fs.writeFileSync(tmp, text, "utf8");
		fd = fs.openSync(tmp, "r+");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tmp, file);
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
		throw error;
	}
}

function writeJsonAtomic(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Module-level session cache: avoids re-reading session.json on burst requests.
// Invalidate the cache when we detect a stale bridge (Pi restart mid-burst).
let _cachedProjectRoot = null;
let _cachedPaths = null;
let _cachedSessionReadAt = 0; // ms epoch
let _cachedHeartbeat = 0;     // ms epoch from session heartbeatAt

function resolveBridge(cwd) {
	const projectRoot = findPiProjectRoot(cwd || process.cwd());
	if (!projectRoot) throw new Error("Not a Pi project; no .pi directory found in cwd or ancestors.");
	const paths = bridgePaths(projectRoot);
	if (!isDir(paths.root) || !isDir(paths.requests) || !isDir(paths.responses)) {
		throw new Error("Pi bridge not responding; start/focus Pi in this project.");
	}
	// Debounce: reuse cached session read within DEBOUNCE_CACHE_MS window.
	const now = Date.now();
	if (projectRoot === _cachedProjectRoot && now - _cachedSessionReadAt < DEBOUNCE_CACHE_MS) {
		// Still fresh enough.
		if (now - _cachedHeartbeat <= LOCK_TTL_MS) return { projectRoot, paths };
		// Cache was fresh but heartbeat may have expired — re-read to be sure.
	}
	const session = readJson(paths.session);
	const lock = session && (session.lock || session);
	const heartbeat = Date.parse(lock && lock.heartbeatAt || "");
	_cachedProjectRoot = projectRoot;
	_cachedPaths = paths;
	_cachedSessionReadAt = now;
	_cachedHeartbeat = Number.isFinite(heartbeat) ? heartbeat : 0;
	if (!lock || lock.status !== "active" || !Number.isFinite(heartbeat) || now - heartbeat > LOCK_TTL_MS) {
		throw new Error("Pi bridge not responding; start/focus Pi in this project.");
	}
	return { projectRoot, paths };
}

async function bridgeRequest(type, payload, options = {}) {
	const { projectRoot, paths } = resolveBridge(options.cwd);
	const id = options.requestId || crypto.randomUUID();
	const request = { id, type, payload: payload || {}, ts: Date.now(), source: "claude-code" };
	const responseFile = path.join(paths.responses, `${id}.json`);
	const requestFile = path.join(paths.requests, `${id}.json`);
	// Drop fsync on request write — we poll for response, rename is sufficient.
	fs.mkdirSync(path.dirname(requestFile), { recursive: true });
	const tmp = path.join(path.dirname(requestFile), `${path.basename(requestFile)}.tmp.${process.pid}.${Date.now()}.${crypto.randomUUID()}`);
	fs.writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`, "utf8");
	fs.closeSync(fs.openSync(tmp, "r+"));
	fs.renameSync(tmp, requestFile);
	const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const response = readJson(responseFile);
		if (response) {
			if (response.ok) return { projectRoot, requestId: id, result: response.result };
			throw new Error(response.error && response.error.message ? response.error.message : `Pi bridge ${type} failed.`);
		}
		await sleep(POLL_MS);
	}
	throw new Error("Pi bridge not responding; start/focus Pi in this project.");
}

function content(text, details) {
	return { content: [{ type: "text", text }], ...(details ? { structuredContent: details } : {}) };
}

function toolResult(name, data) {
	return content(JSON.stringify(data, null, 2), data);
}

const tools = [
	{
		name: "recall_memory",
		description: "Recall Pi persistent memory and engineering docs through the live Pi bridge. Fails loudly if Pi bridge is down.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				mode: { type: "string", enum: ["discuss", "plan", "build"] },
				cwd: { type: "string", description: "Optional cwd; defaults to MCP server cwd." }
			},
			required: ["query"]
		}
	},
	{
		name: "recall_memory_entry",
		description: "Fetch one user-global personal memory entry by slug through the live Pi bridge.",
		inputSchema: {
			type: "object",
			properties: {
				slug: { type: "string", description: "Memory slug, without .md." },
				cwd: { type: "string", description: "Optional cwd; defaults to MCP server cwd." }
			},
			required: ["slug"]
		}
	},
	{
		name: "save_memory",
		description: "Save user-global personal memory through the live Pi bridge.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				description: { type: "string" },
				type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
				body: { type: "string" },
				cwd: { type: "string", description: "Optional cwd; defaults to MCP server cwd." }
			},
			required: ["body"]
		}
	},
	{
		name: "capture_note",
		description: "Capture typed discussion notes into active Pi session Notes widget and staging through live Pi bridge.",
		inputSchema: {
			type: "object",
			properties: {
				notes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["requirement", "decision", "constraint", "action", "question", "preference", "implementation", "lesson"] },
							text: { type: "string" }
						},
						required: ["type", "text"]
					},
					minItems: 1,
					maxItems: 10
				},
				claudeSessionId: { type: "string" },
				context: { type: "string" },
				cwd: { type: "string" }
			},
			required: ["notes"]
		}
	},
	{
		name: "validate_docs_tags",
		description: "Validate [DOCS:*] and [ADR:*] tags via Pi engineering-docs validator through live Pi bridge.",
		inputSchema: { type: "object", properties: { planText: { type: "string" }, cwd: { type: "string" } }, required: ["planText"] }
	},
	{
		name: "save_plan",
		description: "Save confirmed plan into live Pi workflow-modes build handoff through Pi bridge.",
		inputSchema: {
			type: "object",
			properties: {
				planText: { type: "string" },
				planId: { type: "string" },
				confirmed: { type: "boolean", description: "Must be true after explicit user confirmation." },
				cwd: { type: "string" }
			},
			required: ["planText", "confirmed"]
		}
	}
];

async function callTool(name, args) {
	const cwd = args && args.cwd;
	if (name === "recall_memory") return toolResult(name, await bridgeRequest("recall", { query: args.query, mode: args.mode || "plan" }, { cwd }));
	if (name === "recall_memory_entry") return toolResult(name, await bridgeRequest("recall_entry", { slug: args.slug }, { cwd }));
	if (name === "save_memory") return toolResult(name, await bridgeRequest("save_memory", { name: args.name, description: args.description, type: args.type, body: args.body }, { cwd }));
	if (name === "capture_note") return toolResult(name, await bridgeRequest("capture", { notes: args.notes, claudeSessionId: args.claudeSessionId, context: args.context }, { cwd }));
	if (name === "validate_docs_tags") return toolResult(name, await bridgeRequest("validate_tags", { planText: args.planText }, { cwd }));
	if (name === "save_plan") return toolResult(name, await bridgeRequest("save_plan", { planText: args.planText, planId: args.planId, confirmed: args.confirmed === true }, { cwd }));
	throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(message) {
	if (message.method === "initialize") {
		return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
	}
	if (message.method === "tools/list") return { tools };
	if (message.method === "tools/call") {
		const params = message.params || {};
		return await callTool(params.name, params.arguments || {});
	}
	if (message.method === "ping") return {};
	throw new Error(`Unsupported MCP method: ${message.method}`);
}

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main() {
	if (process.argv[2] === "request") {
		const type = process.argv[3];
		const payload = JSON.parse(process.argv[4] || "{}");
		const out = await bridgeRequest(type, payload, { cwd: process.argv[5] || process.cwd() });
		console.log(JSON.stringify(out, null, 2));
		return;
	}
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id === undefined) continue; // Notification.
		try {
			const result = await handleRpc(message);
			send({ jsonrpc: "2.0", id: message.id, result });
		} catch (error) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
