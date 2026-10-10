import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeOpenAIServer } from "./fake-openai-server.mjs";

const MAX_RPC_RECORD_BYTES = 32 * 1024 * 1024;
const SMOKE_TIMEOUT_MS = 120_000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../../../../..");

class SmokeFailure extends Error {
	constructor(kind, message) {
		super(message);
		this.name = "SmokeFailure";
		this.kind = kind;
	}
}

function fail(kind, message) {
	throw new SmokeFailure(kind, message);
}

async function installedPiCliPath() {
	let globalRoot;
	try {
		globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch (error) {
		fail("launch", `Could not resolve global npm root: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packageDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
	let metadata;
	try {
		metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
	} catch {
		fail("launch", `Installed Pi package not found under global npm root ${globalRoot}.`);
	}
	const cliPath = path.resolve(packageDir, metadata.bin?.pi ?? "");
	try {
		await access(cliPath);
	} catch {
		fail("launch", `Installed Pi CLI bundle is missing: ${cliPath}`);
	}
	return { cliPath, version: metadata.version ?? "unknown" };
}

async function chromiumInstalled() {
	const { chromium } = await import("playwright-core");
	const executable = chromium.executablePath();
	try {
		await access(executable);
		return { available: true, executable };
	} catch {
		return { available: false, executable };
	}
}

async function startTestPage() {
	let hits = 0;
	const server = createServer((request, response) => {
		if (request.url !== "/smoke") {
			response.writeHead(404).end("not found");
			return;
		}
		hits += 1;
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end("<!doctype html><html><head><title>Pi RPC smoke page</title></head><body>RPC browser check</body></html>");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") fail("launch", "Local smoke page did not bind a TCP port.");
	return {
		url: `http://127.0.0.1:${address.port}/smoke`,
		get hits() { return hits; },
		close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function readAssistantText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

function createRpcDriver(child) {
	let pendingBytes = Buffer.alloc(0);
	let nextId = 1;
	let closed = false;
	let stderrTail = Buffer.alloc(0);
	let ignoredStdoutLines = 0;
	const pending = new Map();
	const listeners = new Set();
	const events = [];

	const notify = (record) => {
		events.push(record);
		for (const listener of listeners) listener(record);
	};
	const parseChunk = (chunk) => {
		pendingBytes = Buffer.concat([pendingBytes, chunk]);
		if (pendingBytes.byteLength > MAX_RPC_RECORD_BYTES && pendingBytes.indexOf(0x0a) < 0) {
			fail("protocol", `Pi RPC stdout record exceeded ${MAX_RPC_RECORD_BYTES} bytes.`);
		}
		let start = 0;
		for (let index = 0; index < pendingBytes.byteLength; index += 1) {
			if (pendingBytes[index] !== 0x0a) continue;
			let line = pendingBytes.subarray(start, index);
			if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
			start = index + 1;
			if (line.byteLength > MAX_RPC_RECORD_BYTES) fail("protocol", "Pi RPC stdout record exceeded size limit.");
			if (!line.length) continue;
			let record;
			try {
				record = JSON.parse(line.toString("utf8"));
			} catch {
				// Some extensions still log human-readable status to stdout in RPC mode.
				ignoredStdoutLines += 1;
				continue;
			}
			if (!record || typeof record !== "object" || typeof record.type !== "string") {
				ignoredStdoutLines += 1;
				continue;
			}
			if (record.type === "response" && typeof record.id === "string") {
				const waiter = pending.get(record.id);
				if (waiter) {
					pending.delete(record.id);
					waiter.resolve(record);
				}
				notify({ type: "smoke_response", command: record.command, success: record.success === true });
			} else {
				notify(record);
			}
		}
		pendingBytes = pendingBytes.subarray(start);
	};

	child.stdout.on("data", parseChunk);
	child.stdout.on("error", (error) => notify({ type: "smoke_process_error", error }));
	child.stderr.on("data", (chunk) => {
		stderrTail = Buffer.concat([stderrTail, chunk]);
		if (stderrTail.byteLength > 64 * 1024) stderrTail = stderrTail.subarray(-64 * 1024);
	});
	child.once("close", (code, signal) => {
		closed = true;
		for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited (${code ?? signal ?? "unknown"}).`));
		pending.clear();
		notify({ type: "smoke_process_exit", code, signal });
	});

	return {
		events,
		get stderr() { return stderrTail.toString("utf8"); },
		get ignoredStdoutLines() { return ignoredStdoutLines; },
		listen(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		respondUi(id, value) {
			if (closed || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("Pi RPC process is closed.");
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, value })}\n`);
		},
		command(type, fields = {}) {
			if (closed || child.stdin.destroyed || child.stdin.writableEnded) return Promise.reject(new Error("Pi RPC process is closed."));
			const id = `smoke-${nextId++}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new SmokeFailure("timeout", `Timed out waiting for RPC ${type} response.`));
				}, 15_000);
				pending.set(id, {
					resolve: (record) => {
						clearTimeout(timer);
						if (record.success !== true) reject(new SmokeFailure("protocol", `RPC ${type} failed: ${JSON.stringify(record.error ?? record.data ?? {})}`));
						else resolve(record.data);
					},
					reject: (error) => { clearTimeout(timer); reject(error); },
				});
				child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
					if (!error) return;
					const waiter = pending.get(id);
					pending.delete(id);
					waiter?.reject(error);
				});
			});
		},
		endInput() { child.stdin.end(); },
	};
}

function descendantPids(rootPid) {
	const output = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
	const children = new Map();
	for (const line of output.split("\n")) {
		const [pidText, parentText] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		const parent = Number(parentText);
		if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
		const list = children.get(parent) ?? [];
		list.push(pid);
		children.set(parent, list);
	}
	const found = new Set();
	const queue = [rootPid];
	while (queue.length) {
		for (const pid of children.get(queue.shift()) ?? []) {
			if (found.has(pid)) continue;
			found.add(pid);
			queue.push(pid);
		}
	}
	return found;
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

async function waitFor(predicate, { timeoutMs, child, fixture, label }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fixture?.state.errors.length) fail("protocol", `Fake endpoint failed: ${fixture.state.errors.join("; ")}`);
		if (predicate()) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			fail("process", `Pi exited before ${label} (code ${child.exitCode ?? "none"}, signal ${child.signalCode ?? "none"}).`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	fail("timeout", `Timed out waiting for ${label}.`);
}

async function stopPi(child, driver) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	driver?.endInput();
	const waitForClose = (ms) => new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
		const timer = setTimeout(() => resolve(false), ms);
		child.once("close", () => { clearTimeout(timer); resolve(true); });
	});
	if (await waitForClose(8_000)) return;
	child.kill("SIGTERM");
	if (await waitForClose(1_000)) return;
	child.kill("SIGKILL");
	await waitForClose(2_000);
}

async function main() {
	const breakFinal = process.argv.includes("--break-final");
	const { cliPath, version } = await installedPiCliPath();
	const chromium = await chromiumInstalled();
	const page = await startTestPage();
	// Keep macOS Unix-socket paths short; system temp dirs live under deep /var/folders paths.
	const tempRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
	const tempDir = await mkdtemp(path.join(tempRoot, "pi-subagents-smoke-"));
	await chmod(tempDir, 0o700);
	const agentDir = tempDir;
	const browserProfile = path.join(tempDir, "browser-profile");
	let fake;
	let child;
	let driver;
	let trackedPids = new Set();
	let parentFinalSeen = false;
	let finalSettled = false;
	let brokenFinalSettled = false;
	let exitCode = 0;
	let failure;
	let browserSummary = "";

	try {
		const models = {
			providers: {
				"openai-codex": {
					name: "Pi RPC smoke fake",
					api: "openai-completions",
					baseUrl: "PLACEHOLDER",
					apiKey: "smoke-key",
					compat: { supportsStore: false, supportsUsageInStreaming: false, supportsFinishReason: true },
					models: ["gpt-5.5", "gpt-5.4-mini"].map((id) => ({
						id,
						name: `Smoke ${id}`,
						input: ["text"],
						reasoning: false,
						contextWindow: 32_768,
						maxTokens: 4_096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		};
		fake = await startFakeOpenAIServer({
			browserAvailable: chromium.available,
			browserUrl: page.url,
			breakFinal,
			onRequest: () => {
				if (child?.pid) {
					try { for (const pid of descendantPids(child.pid)) trackedPids.add(pid); } catch { /* Final process check remains authoritative. */ }
				}
			},
		});
		models.providers["openai-codex"].baseUrl = fake.baseUrl;
		await writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
		await chmod(agentDir, 0o700);

		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_") || /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN)$/iu.test(key)) delete env[key];
		}
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agentDir,
			PI_BROWSER_PROFILE: browserProfile,
			PI_BROWSER_HEADFUL: "0",
		});

		child = spawn(process.execPath, [
			cliPath,
			"--mode", "rpc",
			"--no-session",
			"--no-extensions",
			"-e", repositoryRoot,
			"--model", "openai-codex/gpt-5.5",
		], { cwd: repositoryRoot, env, stdio: ["pipe", "pipe", "pipe"] });
		driver = createRpcDriver(child);
		driver.listen((event) => {
			if (event.type === "extension_ui_request" && event.method === "select" && typeof event.title === "string" && event.title.includes("Choose a color for the RPC smoke test.")) {
				if (fake.state.questionDialogAnswered) {
					fake.state.errors.push("Question select dialog opened more than once.");
					return;
				}
				if (event.title !== "explorer subagent-1 asks: Choose a color for the RPC smoke test." || !Array.isArray(event.options) || !event.options.includes("green")) {
					fake.state.errors.push(`Unexpected relayed question dialog: ${JSON.stringify(event)}`);
					return;
				}
				try {
					driver.respondUi(event.id, "green");
					fake.state.questionDialogAnswered = true;
					fake.state.trace.push("driver:answer-question-dialog");
				} catch (error) {
					fake.state.errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			if (event.type === "agent_settled") {
				if (parentFinalSeen) finalSettled = true;
				if (fake.state.brokenFinalSent) brokenFinalSettled = true;
			}
			if (event.type === "message_end" && event.message?.role === "assistant" && readAssistantText(event.message).includes("RPC_SMOKE_FINAL:")) {
				parentFinalSeen = true;
			}
		});

		for (const command of ["/mode build", "/browser on"]) {
			const result = await driver.command("prompt", { message: command });
			if (result?.disposition !== "handled") fail("protocol", `${command} was not handled as an extension command.`);
		}
		const prompt = await driver.command("prompt", { message: "SMOKE_PARENT_START: Run the scripted RPC subagent integration flow." });
		if (prompt?.disposition !== "started") fail("protocol", `Main prompt did not start: ${JSON.stringify(prompt)}`);

		await waitFor(
			() => parentFinalSeen || (breakFinal && brokenFinalSettled),
			{ timeoutMs: SMOKE_TIMEOUT_MS, child, fixture: fake, label: "final parent response" },
		);
		if (breakFinal) fail("protocol", "Fake endpoint intentionally omitted required final text.");

		await waitFor(
			() => finalSettled,
			{ timeoutMs: 5_000, child, fixture: fake, label: "final parent agent_settled" },
		);
		const final = await driver.command("get_last_assistant_text");
		assert.match(final?.text ?? "", /RPC_SMOKE_FINAL:/u, "parent RPC transcript must contain final smoke text");
		assert.equal(fake.state.parentExplorerStarted, true, "parent must spawn explorer");
		assert.equal(fake.state.questionAsked, true, "explorer must ask parent a question");
		assert.equal(fake.state.questionDialogAnswered, true, "smoke driver must answer relayed extension UI select");
		assert.equal(fake.state.questionAnswered, true, "child must receive selected answer through RPC UI");
		assert.equal(fake.state.parentQuestionNoteSeen, true, "main agent must receive quiet nextTurn note");
		assert.equal(driver.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent_message").length, 0, "parent model must not call subagent_message to answer question");
		assert.equal(fake.state.workerStarted, true, "parent must spawn worker");
		assert.equal(fake.state.nestedExplorerStarted, true, "worker must spawn allowlisted nested explorer");
		if (chromium.available) {
			assert.equal(fake.state.browserCallIssued, true, "nested explorer must call browser_goto");
			assert.equal(fake.state.browserNavigationReturned, true, "nested browser result must return over IPC");
			assert.ok(page.hits > 0, "browser must reach the local smoke page");
			browserSummary = "Browser smoke: PASS";
		} else {
			assert.equal(fake.state.browserSkipped, true, "missing Chromium must produce explicit browser SKIP path");
			browserSummary = `Browser smoke: SKIP (Chromium missing at ${chromium.executable}; install with npx playwright install chromium)`;
		}
		if (fake.state.errors.length) fail("protocol", `Fake endpoint errors: ${fake.state.errors.join("; ")}`);
	} catch (error) {
		failure = error instanceof SmokeFailure ? error : new SmokeFailure("process", error instanceof Error ? error.message : String(error));
		exitCode = 1;
	} finally {
		if (child) {
			try { for (const pid of descendantPids(child.pid)) trackedPids.add(pid); } catch { /* Request-time snapshots remain available. */ }
			await stopPi(child, driver);
			const leaked = [...trackedPids].filter(isAlive);
			if (leaked.length) {
				for (const pid of leaked) {
					try { process.kill(pid, "SIGTERM"); } catch { /* best effort cleanup */ }
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
				for (const pid of leaked.filter(isAlive)) {
					try { process.kill(pid, "SIGKILL"); } catch { /* best effort cleanup */ }
				}
				failure ??= new SmokeFailure("lifecycle", `Child process leak after Pi shutdown: ${leaked.join(", ")}`);
				exitCode = 1;
			}
			if (child.exitCode !== 0 && !failure) {
				failure = new SmokeFailure("process", `Pi exited with code ${child.exitCode ?? "unknown"}.`);
				exitCode = 1;
			}
		}
		await fake?.close().catch(() => undefined);
		await page.close().catch(() => undefined);
		await rm(tempDir, { recursive: true, force: true });
	}

	if (failure) {
		console.error(`Subagent RPC smoke failed [${failure.kind}]: ${failure.message}`);
		if (fake?.state.trace.length) console.error(`Fake endpoint trace: ${fake.state.trace.join(" -> ")}`);
		if (fake?.state.errors.length) console.error(`Fake endpoint error: ${fake.state.errors.join("; ")}`);
		if (driver?.events.length) {
			const summary = driver.events.slice(-40).map((event) => {
				if (event.type === "smoke_response") return `${event.type}:${event.command}:${event.success}`;
				if (event.type === "tool_execution_end") return `${event.type}:${event.toolName}:${JSON.stringify(event.result ?? event).slice(0, 700)}`;
				if (event.type === "message_end") return `${event.type}:${event.message?.role}:${readAssistantText(event.message).slice(0, 300)}`;
				if (event.type === "extension_ui_request") return `${event.type}:${event.method}`;
				return event.type;
			});
			console.error(`Pi RPC events: ${summary.join(" | ")}`);
		}
		if (child?.pid) {
			try { console.error(`Live descendants: ${[...descendantPids(child.pid)].join(", ") || "none"}`); } catch { /* diagnostics only */ }
		}
		if (driver?.stderr) console.error(`Pi stderr tail:\n${driver.stderr}`);
		process.exitCode = exitCode;
	} else {
		console.log(browserSummary);
		console.log(`Subagent RPC smoke passed against installed Pi ${version}.`);
		if (driver.ignoredStdoutLines) console.log(`Ignored ${driver.ignoredStdoutLines} non-RPC stdout line(s) from extensions.`);
	}
}

await main().catch((error) => {
	const failure = error instanceof SmokeFailure ? error : new SmokeFailure("launch", error instanceof Error ? error.message : String(error));
	console.error(`Subagent RPC smoke failed [${failure.kind}]: ${failure.message}`);
	process.exitCode = 1;
});
