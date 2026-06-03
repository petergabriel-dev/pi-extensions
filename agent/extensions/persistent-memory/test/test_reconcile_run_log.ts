import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordReconcileRun, readRecentReconcileRuns, reconcileRunLogPath } from "../storage/run-log.js";
import type { MemoryPaths } from "../storage/paths.js";

console.log("Running test_reconcile_run_log...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-run-log-"));
try {
	const paths: MemoryPaths = {
		projectRoot: root,
		projectMemoryDir: path.join(root, ".pi", "memory"),
		globalMemoryDir: path.join(root, "global-memory"),
	};

	for (let i = 1; i <= 7; i++) {
		recordReconcileRun(paths, {
			id: `run-${i}`,
			source: i % 2 === 0 ? "background" : "manual",
			status: i === 7 ? "failed" : "completed",
			startedAt: `2026-06-03T00:00:0${i}.000Z`,
			finishedAt: `2026-06-03T00:00:0${i}.100Z`,
			durationMs: 100,
			model: "test-model",
			reason: i === 7 ? "index_error" : null,
			indexRebuilt: i !== 7,
		}, 5);
	}

	const recent = readRecentReconcileRuns(paths, 5);
	assert.deepStrictEqual(recent.map((run) => run.id), ["run-3", "run-4", "run-5", "run-6", "run-7"]);
	assert.strictEqual(recent[0].source, "manual");
	assert.strictEqual(recent[4].status, "failed");
	assert.strictEqual(recent[4].reason, "index_error");

	const filePath = reconcileRunLogPath(paths);
	assert.ok(filePath);
	const persistedLines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
	assert.strictEqual(persistedLines.length, 5, "log file should be capped to last N records");

	const noProjectPaths: MemoryPaths = {
		projectRoot: null,
		projectMemoryDir: null,
		globalMemoryDir: path.join(root, "global-only"),
	};
	assert.strictEqual(recordReconcileRun(noProjectPaths, recent[0]), null);
	assert.deepStrictEqual(readRecentReconcileRuns(noProjectPaths), []);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("test_reconcile_run_log passed!");
