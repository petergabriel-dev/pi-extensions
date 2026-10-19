#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const bridgeClient = require("../claude-bridge-client/pi-bridge-mcp.js");
const readonlyHook = require("../claude-bridge-client/pi-readonly-hook.js");

const OPENCODE = { harness: "opencode", id: "opencode-session-1" };
const pluginUrl = pathToFileURL(path.join(__dirname, "pi-opencode-plugin.js")).href;
let plugin;

function makeProject({ pi = true, lease = false, leaseIdentity = OPENCODE } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-opencode-plugin-"));
	if (pi) {
		fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
		if (lease) {
			const paths = bridgeClient.bridgePaths(root, "pi-opencode-session");
			const dirs = [path.join(root, ".pi", "memory"), paths.root, paths.sessions, paths.namespace, paths.requests, paths.responses, paths.processed];
			for (const dir of dirs) {
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fs.chmodSync(dir, 0o700);
			}
			const now = new Date().toISOString();
			fs.writeFileSync(paths.presence, JSON.stringify({
				schemaVersion: 2,
				piSessionId: "pi-opencode-session",
				name: "OpenCode plugin test",
				mode: "plan",
				pid: process.pid,
				startedAt: now,
				heartbeatAt: now,
				peers: [{ ...leaseIdentity, pendingCount: 0, inboundPendingCount: 0 }],
				buildLease: { ...leaseIdentity, planId: "plan-1", grantedAt: Date.now() },
			}), { mode: 0o600 });
			fs.chmodSync(paths.presence, 0o600);
		}
	}
	return root;
}

function setup(root) {
	let hookName;
	let handler;
	plugin.setup({
		location: { directory: root },
		tool: {
			hook(name, callback) {
				hookName = name;
				handler = callback;
			},
		},
	});
	return { hookName, handler };
}

async function withProject(options, fn) {
	const root = makeProject(options);
	try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}: ${error.stack || error.message}`);
		process.exitCode = 1;
	}
}

async function main() {
	plugin = (await import(pluginUrl)).default;
	assert.equal(plugin.id, "pi-opencode-build-lease");

	await test("non-Pi project registers no hook", async () => {
		await withProject({ pi: false }, (root) => {
			let registrations = 0;
			plugin.setup({ location: { directory: root }, tool: { hook() { registrations++; } } });
			assert.equal(registrations, 0);
		});
	});

	await test("bridge identity comes from OpenCode sessionID", async () => {
		await withProject({}, async (root) => {
			const { hookName, handler } = setup(root);
			assert.equal(hookName, "execute.before");
			const input = { sessionId: "model-forged", claudeSessionId: "model-alias", harness: "claude", cwd: root };
			await handler({ tool: "pi-claude-bridge_list_sessions", sessionID: OPENCODE.id, input });
			assert.deepEqual(input, { sessionId: OPENCODE.id, harness: "opencode", cwd: root });
		});
	});

	await test("invalid host identity blocks bridge call", async () => {
		await withProject({}, async (root) => {
			const { handler } = setup(root);
			await assert.rejects(
				handler({ tool: "pi-claude-bridge_list_sessions", sessionID: "../invalid", input: {} }),
				/session identity is missing or invalid/,
			);
		});
	});

	await test("live lease holder bypasses mutation guard", async () => {
		await withProject({ lease: true }, async (root) => {
			const { handler } = setup(root);
			await handler({ tool: "edit", sessionID: OPENCODE.id, input: { filePath: "note.txt" } });
		});
	});

	await test("lease holder shell command remains unsandboxed", async () => {
		const original = readonlyHook.wrapBashForSandbox;
		readonlyHook.wrapBashForSandbox = () => { throw new Error("holder shell must not be sandboxed"); };
		try {
			await withProject({ lease: true }, async (root) => {
				const { handler } = setup(root);
				const input = { command: "echo build write" };
				await handler({ tool: "shell", sessionID: OPENCODE.id, input });
				assert.equal(input.command, "echo build write");
			});
		} finally {
			readonlyHook.wrapBashForSandbox = original;
		}
	});

	await test("non-holder mutators throw, Code Mode dispatcher stays available", async () => {
		await withProject({}, async (root) => {
			const { handler } = setup(root);
			for (const tool of ["edit", "write", "opencode_worktree_create", "opencode_worktree_remove"]) {
				await assert.rejects(
					handler({ tool, sessionID: OPENCODE.id, input: {} }),
					/No live build lease.*Run \/build/,
				);
			}
			await handler({ tool: "execute", sessionID: OPENCODE.id, input: { code: "return 1" } });
		});
	});

	await test("foreign lease holder is named in mutation refusal", async () => {
		await withProject({ lease: true, leaseIdentity: { harness: "claude", id: "claude-holder" } }, async (root) => {
			const { handler } = setup(root);
			await assert.rejects(
				handler({ tool: "edit", sessionID: OPENCODE.id, input: {} }),
				/Live build lease held by claude:claude-holder;.*\/build-lease release/,
			);
		});
	});

	await test("non-holder shell command is sandbox-wrapped", async () => {
		const original = readonlyHook.wrapBashForSandbox;
		let wrappedInput;
		readonlyHook.wrapBashForSandbox = (command, projectRoot) => {
			wrappedInput = { command, projectRoot };
			return `sandboxed:${command}`;
		};
		try {
			await withProject({}, async (root) => {
				const { handler } = setup(root);
				const input = { command: "echo read-only", timeout: 1000 };
				await handler({ tool: "shell", sessionID: OPENCODE.id, input });
				assert.deepEqual(wrappedInput, { command: "echo read-only", projectRoot: fs.realpathSync(root) });
				assert.equal(input.command, "sandboxed:echo read-only");
				assert.equal(input.timeout, 1000);
			});
		} finally {
			readonlyHook.wrapBashForSandbox = original;
		}
	});

	await test("unavailable shell sandbox throws", async () => {
		const original = readonlyHook.wrapBashForSandbox;
		readonlyHook.wrapBashForSandbox = () => null;
		try {
			await withProject({}, async (root) => {
				const { handler } = setup(root);
				await assert.rejects(
					handler({ tool: "shell", sessionID: OPENCODE.id, input: { command: "echo unsafe" } }),
					/Seatbelt sandbox is unavailable/,
				);
			});
		} finally {
			readonlyHook.wrapBashForSandbox = original;
		}
	});

	await test("internal lease error throws", async () => {
		const original = bridgeClient.holdsBuildLease;
		bridgeClient.holdsBuildLease = () => { throw new Error("lease probe failed"); };
		try {
			await withProject({}, async (root) => {
				const { handler } = setup(root);
				await assert.rejects(
					handler({ tool: "edit", sessionID: OPENCODE.id, input: {} }),
					/lease probe failed/,
				);
			});
		} finally {
			bridgeClient.holdsBuildLease = original;
		}
	});
}

main().catch((error) => {
	console.error(error.stack || error.message);
	process.exitCode = 1;
});
