import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

import type { SubagentItem } from "./launch.ts";

export interface SubagentOverlayRecord {
	owner: string;
	agentName: string;
	status: "running" | "waiting" | "done" | "failed";
	depth: number;
	parentOwner?: string;
	startedAt: number;
	finishedAt?: number;
	effort?: string;
	sessionFile?: string;
	question?: { questionId: string; question: string; options?: string[] };
}

export interface SubagentOverlaySource {
	getRecord(): SubagentOverlayRecord | undefined;
	getQuestionNotice?(): string | undefined;
	readItems(): readonly SubagentItem[];
	subscribeItems(listener: (items: readonly SubagentItem[]) => void): () => void;
	redactText(text: string): string;
	answerQuestion(questionId: string, answer: string): boolean;
	steer(message: string): Promise<void>;
}

export function orderSubagentTree<T extends SubagentOverlayRecord>(records: readonly T[]): T[] {
	const byOwner = new Map(records.map((record) => [record.owner, record]));
	const children = new Map<string, T[]>();
	const roots: T[] = [];
	for (const record of records) {
		if (!record.parentOwner || !byOwner.has(record.parentOwner)) {
			roots.push(record);
			continue;
		}
		const siblings = children.get(record.parentOwner) ?? [];
		siblings.push(record);
		children.set(record.parentOwner, siblings);
	}
	const sort = (left: T, right: T) => left.startedAt - right.startedAt;
	roots.sort(sort);
	for (const siblings of children.values()) siblings.sort(sort);

	const ordered: T[] = [];
	const visited = new Set<string>();
	const visit = (record: T) => {
		if (visited.has(record.owner)) return;
		visited.add(record.owner);
		ordered.push(record);
		for (const child of children.get(record.owner) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	for (const record of [...records].sort(sort)) visit(record);
	return ordered;
}

export function formatSubagentItemLines(items: readonly SubagentItem[], width: number): string[] {
	const boundedWidth = Math.max(1, Math.floor(width));
	// ponytail: Keep each event to one display row for the 10/s redraw budget; add viewport-aware expansion if long-event drilldown is needed.
	return items.map((item) => truncateToWidth(`[${item.kind}] ${item.text.replace(/\r\n?/g, "\n").replace(/\n/g, " ↩ ")}`, boundedWidth, "…"));
}

function createEditorTheme(theme: Theme): EditorTheme {
	const dim = (text: string) => theme.fg("dim", text);
	return {
		borderColor: (text) => theme.fg("border", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: dim,
			scrollInfo: dim,
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function elapsedLabel(startedAt: number, finishedAt?: number): string {
	const seconds = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export class SubagentOverlayComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly initialRecord: SubagentOverlayRecord;
	private readonly source: SubagentOverlaySource;
	private readonly done: () => void;
	private readonly editor: Editor;
	private items: readonly SubagentItem[];
	private unsubscribe: () => void = () => undefined;
	private disposed = false;
	private busy = false;
	private notice = "";
	private followTail = true;
	private scrollOffset = 0;
	private formattedItems?: { items: readonly SubagentItem[]; width: number; lines: string[] };
	private redrawTimer?: ReturnType<typeof setTimeout>;
	private lastRenderAt = 0;
	private _focused = false;
	private bodyCapacity = 1;
	private lastWidth = 80;

	constructor(tui: TUI, theme: Theme, record: SubagentOverlayRecord, source: SubagentOverlaySource, done: () => void) {
		this.tui = tui;
		this.initialRecord = record;
		this.source = source;
		this.done = done;
		this.editor = new Editor(tui, createEditorTheme(theme), { paddingX: 1 });
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onChange = () => this.invalidate();
		this.items = source.readItems();
		this.lastRenderAt = Date.now() - 100;
		this.unsubscribe = source.subscribeItems((items) => this.updateItems(items));
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(1, Math.floor(width));
		this.lastWidth = boundedWidth;
		const record = this.source.getRecord() ?? this.initialRecord;
		const heading = [
			`${record.owner} · ${record.agentName}${record.question ? " · ? question" : ""}`,
			`Status: ${record.status} · Elapsed: ${elapsedLabel(record.startedAt, record.finishedAt)} · Effort: ${record.effort ?? "inherit"}`,
			`Transcript: ${record.sessionFile ?? "not available"}`,
			...(record.question ? [
				`Question: ${record.question.question}`,
				...(record.question.options?.length ? [`Options: ${record.question.options.join(" | ")}`] : []),
			] : []),
		].flatMap((line) => wrapTextWithAnsi(this.source.redactText(line), boundedWidth));
		const body = this.getFormattedItems(boundedWidth).map((line) => this.source.redactText(line));
		const editorLines = this.editor.render(boundedWidth).map((line) => this.source.redactText(line));
		const questionNotice = this.source.getQuestionNotice?.();
		const questionNoticeLines = questionNotice
			? wrapTextWithAnsi(this.source.redactText(questionNotice), boundedWidth)
			: [];
		const footerLines = [
			...questionNoticeLines,
			...(this.notice ? [this.source.redactText(this.notice)] : []),
			this.source.redactText(record.question
				? "Enter answer · Esc closes /agents only; question stays pending"
				: "↑↓ / PgUp / PgDn scroll · Enter send or answer · Esc close"),
		];
		const maxHeight = Math.max(8, Math.floor((this.tui.terminal.rows || 24) * 0.8));
		this.bodyCapacity = Math.max(1, maxHeight - heading.length - editorLines.length - footerLines.length - 1);
		const maxOffset = Math.max(0, body.length - this.bodyCapacity);
		if (this.followTail) this.scrollOffset = maxOffset;
		else this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + this.bodyCapacity);
		return [
			...heading.map((line) => truncateToWidth(this.source.redactText(line), boundedWidth)),
			...visibleBody.map((line) => truncateToWidth(this.source.redactText(line), boundedWidth)),
			...footerLines.map((line) => truncateToWidth(this.source.redactText(line), boundedWidth)),
			...editorLines,
		];
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scroll(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scroll(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll(-this.bodyPageSize());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll(this.bodyPageSize());
			return;
		}
		if (!this.busy) this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	refresh(): void {
		this.invalidate();
		this.requestThrottledRender();
	}

	dispose(): void {
		this.close(false);
	}

	cancel(): void {
		this.close();
	}

	private getFormattedItems(width: number): string[] {
		if (this.formattedItems?.items === this.items && this.formattedItems.width === width) return this.formattedItems.lines;
		const lines = formatSubagentItemLines(this.items, width);
		this.formattedItems = { items: this.items, width, lines };
		return lines;
	}

	private updateItems(items: readonly SubagentItem[]): void {
		if (this.disposed) return;
		this.items = items;
		this.formattedItems = undefined;
		this.invalidate();
		this.requestThrottledRender();
	}

	private requestThrottledRender(): void {
		if (this.disposed) return;
		const elapsed = Date.now() - this.lastRenderAt;
		const delay = Math.max(0, 100 - elapsed);
		if (delay === 0) {
			this.lastRenderAt = Date.now();
			this.requestRender();
			return;
		}
		if (this.redrawTimer) return;
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = undefined;
			if (this.disposed) return;
			this.lastRenderAt = Date.now();
			this.requestRender();
		}, delay);
	}

	private requestRender(): void {
		if (this.disposed) return;
		try {
			this.tui.requestRender();
		} catch {
			this.close(false);
		}
	}

	private bodyPageSize(): number {
		return Math.max(1, this.bodyCapacity);
	}

	private scroll(delta: number): void {
		const body = this.getFormattedItems(this.lastWidth);
		const maxOffset = Math.max(0, body.length - this.bodyCapacity);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
		this.followTail = this.scrollOffset >= maxOffset;
		this.requestRender();
	}

	private async submit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.busy || this.disposed) return;
		this.busy = true;
		this.editor.disableSubmit = true;
		this.notice = "Sending…";
		this.requestRender();
		let clearInput = false;
		try {
			const record = this.source.getRecord();
			if (!record) throw new Error("Session changed; reopen /agents.");
			if (record.question) {
				if (!this.source.answerQuestion(record.question.questionId, text)) throw new Error("Question is no longer pending.");
				this.notice = `Answer sent to ${record.owner}.`;
				clearInput = true;
			} else if (record.status === "running") {
				await this.source.steer(text);
				this.notice = `Steer sent to ${record.owner}; delivered at next tool call.`;
				clearInput = true;
			} else if (record.status === "waiting") {
				throw new Error("Child is waiting, but no pending question is available.");
			} else {
				this.notice = "Finished child is read-only.";
				clearInput = true;
			}
		} catch (error) {
			this.notice = `Send failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (this.disposed) return;
			this.busy = false;
			this.editor.disableSubmit = false;
			if (clearInput) this.editor.setText("");
			else if (text) this.editor.setText(text);
			this.invalidate();
			this.requestRender();
		}
	}

	private close(finish = true): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.redrawTimer) clearTimeout(this.redrawTimer);
		this.redrawTimer = undefined;
		try {
			this.unsubscribe();
		} catch {
			// Tolerate a host that already released its listener set.
		}
		this.unsubscribe = () => undefined;
		if (finish) {
			try { this.done(); }
			catch { /* The owning UI may already be disposed. */ }
		}
	}
}
