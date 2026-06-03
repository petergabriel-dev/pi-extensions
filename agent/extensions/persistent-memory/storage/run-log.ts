import * as fs from "node:fs";
import * as path from "node:path";
import type { ReconciliationRunCounts } from "../consolidation/reconcile.js";
import type { MemoryPaths } from "./paths.js";

export type ReconcileRunSource = "manual" | "background";
export type ReconcileRunStatus = "completed" | "skipped" | "failed" | "rejected";

export interface ReconcileRunRecord {
	id?: string;
	source: ReconcileRunSource;
	status: ReconcileRunStatus;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	model?: string | null;
	reason?: string | null;
	message?: string | null;
	counts?: ReconciliationRunCounts;
	llmCalled?: boolean;
	indexRebuilt?: boolean;
}

export interface StoredReconcileRunRecord extends ReconcileRunRecord {
	id: string;
}

export const DEFAULT_RECONCILE_RUN_LOG_LIMIT = 50;
const RUN_LOG_FILE = "reconcile-runs.jsonl";

export function reconcileRunLogPath(paths: MemoryPaths): string | null {
	if (!paths.projectMemoryDir) return null;
	return path.join(paths.projectMemoryDir, RUN_LOG_FILE);
}

export function recordReconcileRun(
	paths: MemoryPaths,
	record: ReconcileRunRecord,
	limit = DEFAULT_RECONCILE_RUN_LOG_LIMIT,
): StoredReconcileRunRecord | null {
	const filePath = reconcileRunLogPath(paths);
	if (!filePath) return null;

	const stored: StoredReconcileRunRecord = {
		...record,
		id: record.id ?? createRunId(record),
	};

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(stored)}\n`, "utf8");
	rotateReconcileRunLog(filePath, limit);
	return stored;
}

export function readRecentReconcileRuns(paths: MemoryPaths, limit = DEFAULT_RECONCILE_RUN_LOG_LIMIT): StoredReconcileRunRecord[] {
	const filePath = reconcileRunLogPath(paths);
	if (!filePath || !fs.existsSync(filePath)) return [];
	const normalizedLimit = normalizeLimit(limit);
	const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
	const recent = lines.slice(-normalizedLimit);
	const records: StoredReconcileRunRecord[] = [];
	for (const line of recent) {
		try {
			const parsed = JSON.parse(line) as StoredReconcileRunRecord;
			if (parsed && typeof parsed.id === "string") records.push(parsed);
		} catch {
			// Ignore malformed log lines; the log is diagnostic only.
		}
	}
	return records;
}

function rotateReconcileRunLog(filePath: string, limit: number): void {
	const normalizedLimit = normalizeLimit(limit);
	const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length <= normalizedLimit) return;
	fs.writeFileSync(filePath, `${lines.slice(-normalizedLimit).join("\n")}\n`, "utf8");
}

function normalizeLimit(limit: number): number {
	return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_RECONCILE_RUN_LOG_LIMIT;
}

function createRunId(record: ReconcileRunRecord): string {
	return `${record.startedAt}-${record.source}-${Math.random().toString(36).slice(2, 8)}`;
}
