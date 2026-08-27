import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "./agents.ts";

const WIDGET_KEY = "subagents-progress";
const REDRAW_INTERVAL_MS = 250;

export type SubagentProgressStatus = "running" | "waiting" | "done" | "failed";

export interface ProgressHandle {
	id: string;
	setActivity(activity: string): void;
	setStatus(status: SubagentProgressStatus): void;
	incrementToolCount(): void;
	finish(status?: "done" | "failed"): void;
}

export interface ProgressRun {
	id: string;
	role: AgentRole;
	name: string;
	status: SubagentProgressStatus;
	activity: string;
	toolCount: number;
	startedAt: number;
	depth: number;
	parentId?: string;
}

const runs = new Map<string, ProgressRun>();
let nextRunId = 0;
let lastRenderAt = 0;
let scheduled: ReturnType<typeof setTimeout> | undefined;
let clearScheduled: ReturnType<typeof setTimeout> | undefined;
let currentCtx: ExtensionContext | undefined;

function elapsed(startedAt: number): string {
	const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderLines(): string[] | undefined {
	if (runs.size === 0) return undefined;
	const ordered = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	return [
		`Subagents: ${ordered.length}`,
		...ordered.map((run) => {
			const indent = "  ".repeat(run.depth);
			return `${indent}- ${run.name} [${run.status}]: ${run.activity}; tools ${run.toolCount}; ${elapsed(run.startedAt)}`;
		}),
	];
}

function flush(): void {
	scheduled = undefined;
	lastRenderAt = Date.now();
	try {
		currentCtx?.ui.setWidget(WIDGET_KEY, renderLines(), { placement: "aboveEditor" });
	} catch {
		currentCtx = undefined;
	}
}

function requestRender(): void {
	if (!currentCtx) return;
	const waitMs = REDRAW_INTERVAL_MS - (Date.now() - lastRenderAt);
	if (waitMs <= 0) return flush();
	if (!scheduled) scheduled = setTimeout(flush, waitMs);
}

export function setSubagentProgressContext(ctx: ExtensionContext | undefined): void {
	currentCtx = ctx;
	if (ctx) requestRender();
}

export function clearSubagentProgress(): void {
	if (scheduled) clearTimeout(scheduled);
	if (clearScheduled) clearTimeout(clearScheduled);
	scheduled = undefined;
	clearScheduled = undefined;
	runs.clear();
	flush();
}

export function startSubagentProgress(
	role: AgentRole,
	options: { depth?: number; parentId?: string; name?: string } = {},
): ProgressHandle {
	if (clearScheduled) {
		clearTimeout(clearScheduled);
		clearScheduled = undefined;
	}
	const id = `${role}-${++nextRunId}`;
	runs.set(id, {
		id,
		role,
		name: options.name ?? id,
		status: "running",
		activity: "starting",
		toolCount: 0,
		startedAt: Date.now(),
		depth: options.depth ?? 0,
		parentId: options.parentId,
	});
	requestRender();
	return {
		id,
		setActivity(activity: string) {
			const run = runs.get(id);
			if (!run) return;
			run.activity = activity;
			requestRender();
		},
		setStatus(status: SubagentProgressStatus) {
			const run = runs.get(id);
			if (!run) return;
			run.status = status;
			requestRender();
		},
		incrementToolCount() {
			const run = runs.get(id);
			if (!run) return;
			run.toolCount += 1;
			requestRender();
		},
		finish(status = "done") {
			const run = runs.get(id);
			if (!run) return;
			run.status = status;
			run.activity = status === "done" ? "finished" : "failed";
			requestRender();
			if ([...runs.values()].every((item) => item.status === "done" || item.status === "failed")) {
				clearScheduled = setTimeout(() => {
					clearScheduled = undefined;
					runs.clear();
					flush();
				}, REDRAW_INTERVAL_MS);
			}
		},
	};
}

export function getProgressSnapshot(): { running: ProgressRun[]; redrawIntervalMs: number } {
	return { running: [...runs.values()], redrawIntervalMs: REDRAW_INTERVAL_MS };
}
