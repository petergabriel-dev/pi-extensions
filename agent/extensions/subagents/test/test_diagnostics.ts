import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createSubagentDiagnostics,
	MAX_SUBAGENT_LOG_BYTES,
	MAX_SUBAGENT_TAIL_BYTES,
	resolveSubagentDiagnosticsPath,
	SUBAGENT_LOG_MODE,
	SUBAGENT_RUNTIME_DIR_MODE,
} from "../diagnostics.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-diagnostics-"));
const token = "0123456789abcdef0123456789abcdef";
const logPath = resolveSubagentDiagnosticsPath("parent-session", "worker-one", tempDir);

try {
	const diagnostics = createSubagentDiagnostics({ parentSessionId: "parent-session", owner: "worker-one", token, agentDir: tempDir });
	assert.equal(diagnostics.logPath, logPath);
	assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, SUBAGENT_RUNTIME_DIR_MODE);
	assert.equal(fs.statSync(logPath).mode & 0o777, SUBAGENT_LOG_MODE);

	diagnostics.append("stderr", `prefix ${token.slice(0, 12)}`);
	diagnostics.append("stderr", `${token.slice(12)} suffix\n`);
	diagnostics.append("stdout", "x".repeat(MAX_SUBAGENT_LOG_BYTES * 2));
	diagnostics.close();

	const content = fs.readFileSync(logPath, "utf8");
	assert.equal(content.includes(token), false);
	assert.ok(Buffer.byteLength(content, "utf8") <= MAX_SUBAGENT_LOG_BYTES);
	assert.ok(Buffer.byteLength(diagnostics.tail(), "utf8") <= MAX_SUBAGENT_TAIL_BYTES);
	assert.match(diagnostics.tail(), /suffix|x/);
	console.log("subagent diagnostics tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
