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
const childSessionId = "981c0ccb-cae3-4951-b99d-3bee7b32117a";
const logPath = resolveSubagentDiagnosticsPath("parent-session", "worker-one", tempDir);

try {
	const diagnostics = createSubagentDiagnostics({ parentSessionId: "parent-session", childSessionId, owner: "worker-one", token, agentDir: tempDir });
	assert.equal(diagnostics.logPath, logPath);
	assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, SUBAGENT_RUNTIME_DIR_MODE);
	assert.equal(fs.statSync(logPath).mode & 0o777, SUBAGENT_LOG_MODE);

	diagnostics.append("stderr", `prefix ${token.slice(0, 12)}`);
	diagnostics.append("stderr", `${token.slice(12)} suffix\n`);
	assert.equal(diagnostics.tail().includes(token), false);

	const uuidLine = `child session ${childSessionId}`;
	const uuidSplit = uuidLine.indexOf(childSessionId) + Math.floor(childSessionId.length / 2);
	diagnostics.append("stderr", uuidLine.slice(0, uuidSplit));
	diagnostics.append("stderr", `${uuidLine.slice(uuidSplit)}\n`);

	const warning = (id: string) => `Warning: No project session found with id '${id}'; creating a new session with that id.`;
	const childWarning = warning(childSessionId);
	const warningSplit = childWarning.indexOf(childSessionId) + Math.floor(childSessionId.length / 2);
	diagnostics.append("stderr", childWarning.slice(0, warningSplit));
	diagnostics.append("stderr", `${childWarning.slice(warningSplit)}\n`);
	diagnostics.append("stderr", `${warning("other-child-session")}\n`);
	diagnostics.append("stdout", `${childWarning}\n`);

	diagnostics.append("stderr", `${"y".repeat(64 * 1024 - 31)}${token}`);
	assert.equal(diagnostics.tail().includes(token), false);
	diagnostics.append("stderr", "\n");
	diagnostics.append("stdout", "x".repeat(MAX_SUBAGENT_LOG_BYTES * 2));
	diagnostics.close();

	const content = fs.readFileSync(logPath, "utf8");
	assert.equal(content.includes(token), false);
	assert.equal(content.includes(`[stderr] ${childWarning}`), false);
	assert.ok(content.includes(`[stderr] ${warning("other-child-session")}\n`));
	assert.ok(content.includes(`[stdout] ${childWarning}\n`));
	assert.ok(content.includes(`[stderr] ${uuidLine}\n`));
	assert.equal(content.match(/^\[stderr\] /gm)?.length, 4);
	assert.equal(content.match(/^\[stdout\] /gm)?.length, 2);
	assert.ok(Buffer.byteLength(content, "utf8") <= MAX_SUBAGENT_LOG_BYTES);
	assert.ok(Buffer.byteLength(diagnostics.tail(), "utf8") <= MAX_SUBAGENT_TAIL_BYTES);
	assert.equal(diagnostics.tail().includes(token), false);
	assert.match(diagnostics.tail(), /suffix|x/);

	const partialDiagnostics = createSubagentDiagnostics({ parentSessionId: "parent-session", childSessionId, owner: "partial-flush", token, agentDir: tempDir });
	partialDiagnostics.append("stderr", "partial line flushed on close");
	partialDiagnostics.close();
	assert.equal(fs.readFileSync(partialDiagnostics.logPath, "utf8"), "[stderr] partial line flushed on close");
	console.log("subagent diagnostics tests passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
