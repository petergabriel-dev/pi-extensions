import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { buildProjectNotesPromotionPrompt, dispatchCurationPrompt, formatDiscussionNotesPage, MAX_LESSON_LIST_PAGE } from "./personal-memory/curation.js";

export const EXTENSION_ID = "discussion-notes";
export const TOOL_NAME = "discussion_notes";
const MAX_NOTE_LENGTH = 480;
const MAX_ACTIVE_NOTES = 200;
const COMPACT_NOTE_COUNT = 3;

export const NOTE_TYPES = [
	"requirement",
	"decision",
	"constraint",
	"action",
	"question",
	"preference",
	"implementation",
	"lesson",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteSource = "auto" | "manual" | "claude-code";

export interface Note {
	id: number;
	type: NoteType;
	text: string;
	createdAt: number;
	source: NoteSource;
}

export interface SkippedNote {
	type: NoteType;
	text: string;
	reason: "duplicate";
}

export interface NotesSnapshotV1 {
	schemaVersion: 1;
	event: "add" | "clear";
	notes: Note[];
	nextId: number;
	added?: Note[];
	skipped?: SkippedNote[];
}

export interface AddResult {
	added: Note[];
	skipped: SkippedNote[];
	snapshot?: NotesSnapshotV1;
}

const TYPE_LABELS: Record<NoteType, string> = {
	requirement: "Requirement",
	decision: "Decision",
	constraint: "Constraint",
	action: "Action",
	question: "Question",
	preference: "Preference",
	implementation: "Implementation",
	lesson: "Lesson",
};

const DiscussionNotesParams = Type.Object({
	action: StringEnum(["add", "list"] as const),
	notes: Type.Optional(
		Type.Array(
			Type.Object({
				type: StringEnum(NOTE_TYPES),
				text: Type.String(),
			}),
			{ minItems: 1, maxItems: 10 },
		),
	),
	type: Type.Optional(StringEnum(NOTE_TYPES)),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_ACTIVE_NOTES })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LESSON_LIST_PAGE })),
});

type DiscussionNotesParams = Static<typeof DiscussionNotesParams>;

let notes: Note[] = [];
let nextId = 1;
let overlayStatus: string | undefined;
let latestContext: ExtensionContext | null = null;

function isNoteType(value: unknown): value is NoteType {
	return typeof value === "string" && (NOTE_TYPES as readonly string[]).includes(value);
}

function isNoteSource(value: unknown): value is NoteSource {
	return value === "auto" || value === "manual" || value === "claude-code";
}

function cleanText(input: string): string {
	return input
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^['](.+)[']$/, "$1")
		.replace(/^[\"](.+)[\"]$/, "$1")
		.trim();
}

function normalizeForDedupe(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:]+$/g, "").trim();
}

function dedupeKey(type: NoteType, text: string): string {
	return `${type}\u0000${normalizeForDedupe(text)}`;
}

function validateNote(value: unknown): Note | undefined {
	if (!value || typeof value !== "object") return undefined;
	const note = value as Record<string, unknown>;
	if (typeof note.id !== "number" || !Number.isFinite(note.id)) return undefined;
	if (!isNoteType(note.type)) return undefined;
	if (typeof note.text !== "string" || note.text.length === 0 || note.text.length > MAX_NOTE_LENGTH) return undefined;
	if (typeof note.createdAt !== "number" || !Number.isFinite(note.createdAt)) return undefined;
	if (!isNoteSource(note.source)) return undefined;
	return {
		id: note.id,
		type: note.type,
		text: note.text,
		createdAt: note.createdAt,
		source: note.source,
	};
}

function validateSnapshot(value: unknown): NotesSnapshotV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const snapshot = value as Record<string, unknown>;
	if (snapshot.schemaVersion !== 1) return undefined;
	if (snapshot.event !== "add" && snapshot.event !== "clear") return undefined;
	if (!Array.isArray(snapshot.notes)) return undefined;
	if (typeof snapshot.nextId !== "number" || !Number.isFinite(snapshot.nextId)) return undefined;

	const validNotes: Note[] = [];
	for (const rawNote of snapshot.notes) {
		const note = validateNote(rawNote);
		if (!note) return undefined;
		validNotes.push(note);
	}

	const out: NotesSnapshotV1 = {
		schemaVersion: 1,
		event: snapshot.event,
		notes: validNotes,
		nextId: snapshot.nextId,
	};

	if (Array.isArray(snapshot.added)) {
		const added: Note[] = [];
		for (const raw of snapshot.added) {
			const note = validateNote(raw);
			if (!note) return undefined;
			added.push(note);
		}
		out.added = added;
	}

	if (Array.isArray(snapshot.skipped)) {
		const skipped: SkippedNote[] = [];
		for (const raw of snapshot.skipped) {
			if (!raw || typeof raw !== "object") return undefined;
			const item = raw as Record<string, unknown>;
			if (!isNoteType(item.type) || typeof item.text !== "string" || item.reason !== "duplicate") return undefined;
			skipped.push({ type: item.type, text: item.text, reason: "duplicate" });
		}
		out.skipped = skipped;
	}

	return out;
}

function extractValidSnapshot(entry: any): NotesSnapshotV1 | undefined {
	if (entry?.type === "message") {
		const msg = entry.message;
		if (msg?.role === "toolResult" && msg.toolName === TOOL_NAME) {
			return validateSnapshot(msg.details);
		}
	}
	if (entry?.type === "custom" && entry.customType === EXTENSION_ID) {
		return validateSnapshot(entry.data);
	}
	return undefined;
}

function applySnapshot(snapshot: NotesSnapshotV1): void {
	// Defensive repair for old bridge bug: partial imported-module snapshots could be appended
	// after real notes and shrink the visible widget. Treat shrinking add snapshots as deltas.
	if (snapshot.event === "add" && snapshot.notes.length < notes.length && snapshot.added && snapshot.added.length > 0) {
		const existingKeys = new Set(notes.map((note) => dedupeKey(note.type, note.text)));
		const existingIds = new Set(notes.map((note) => note.id));
		for (const raw of snapshot.added) {
			const key = dedupeKey(raw.type, raw.text);
			if (existingKeys.has(key)) continue;
			const note = { ...raw };
			if (existingIds.has(note.id) || note.id < nextId) note.id = nextId++;
			notes.push(note);
			existingKeys.add(key);
			existingIds.add(note.id);
		}
		nextId = Math.max(nextId, snapshot.nextId, ...notes.map((note) => note.id + 1));
		return;
	}
	notes = snapshot.notes.map((note) => ({ ...note }));
	nextId = snapshot.nextId;
}

function reconstructFromCurrentBranch(ctx: ExtensionContext): void {
	notes = [];
	nextId = 1;

	for (const entry of ctx.sessionManager.getBranch()) {
		const snapshot = extractValidSnapshot(entry);
		if (!snapshot) continue;
		applySnapshot(snapshot);
	}

	renderPersistentUI(ctx);
}

function createSnapshot(event: "add" | "clear", added?: Note[], skipped?: SkippedNote[]): NotesSnapshotV1 {
	return {
		schemaVersion: 1,
		event,
		notes: notes.map((note) => ({ ...note })),
		nextId,
		...(added && added.length > 0 ? { added: added.map((note) => ({ ...note })) } : {}),
		...(skipped && skipped.length > 0 ? { skipped: skipped.map((item) => ({ ...item })) } : {}),
	};
}

export type DiscussionNotesPersistMode = "tool-result" | "custom-entry";
export type DiscussionNotesPersistSnapshot = (
	snapshot: NotesSnapshotV1,
	ctx: ExtensionContext,
	mode: DiscussionNotesPersistMode,
) => Promise<void>;

let persistSnapshot: DiscussionNotesPersistSnapshot = async (
	_snapshot: NotesSnapshotV1,
	_ctx: ExtensionContext,
	mode: DiscussionNotesPersistMode,
): Promise<void> => {
	if (mode === "tool-result") return;
	throw new Error("Could not save note.");
};

function validateCandidate(type: NoteType, text: string): void {
	if (!isNoteType(type)) {
		throw new Error(`Invalid note type: ${String(type)}.\nValid types: ${NOTE_TYPES.join(", ")}.`);
	}
	if (text.length === 0) throw new Error("Note text is required.");
	if (text.length > MAX_NOTE_LENGTH) throw new Error(`Note is too long. Max ${MAX_NOTE_LENGTH} characters.`);
}

export async function addNotes(
	rawNotes: Array<{ type: NoteType; text: string }>,
	source: NoteSource,
	ctx: ExtensionContext,
	persistMode: DiscussionNotesPersistMode,
	persist: DiscussionNotesPersistSnapshot = persistSnapshot,
): Promise<AddResult> {
	const previousNotes = notes.map((note) => ({ ...note }));
	const previousNextId = nextId;

	const existingKeys = new Set(notes.map((note) => dedupeKey(note.type, note.text)));
	const batchKeys = new Set<string>();
	const candidates: Array<{ type: NoteType; text: string }> = [];
	const skipped: SkippedNote[] = [];

	for (const raw of rawNotes) {
		const text = cleanText(raw.text);
		if (!isNoteType(raw.type)) {
			throw new Error(`Invalid note type: ${String(raw.type)}.\nValid types: ${NOTE_TYPES.join(", ")}.`);
		}
		const key = dedupeKey(raw.type, text);
		if (existingKeys.has(key) || batchKeys.has(key)) {
			skipped.push({ type: raw.type, text, reason: "duplicate" });
			continue;
		}
		validateCandidate(raw.type, text);
		batchKeys.add(key);
		candidates.push({ type: raw.type, text });
	}

	if (candidates.length === 0) {
		return { added: [], skipped };
	}

	if (notes.length + candidates.length > MAX_ACTIVE_NOTES) {
		throw new Error("Note limit reached for this branch. Clear notes or start a new branch/session.");
	}

	const createdAt = Date.now();
	const added = candidates.map((candidate) => ({
		id: nextId++,
		type: candidate.type,
		text: candidate.text,
		createdAt,
		source,
	} satisfies Note));

	notes = [...notes, ...added];
	const snapshot = createSnapshot("add", added, skipped);

	try {
		await persist(snapshot, ctx, persistMode);
		renderPersistentUI(ctx);
		return { added, skipped, snapshot };
	} catch (_error) {
		notes = previousNotes;
		nextId = previousNextId;
		renderPersistentUI(ctx);
		throw new Error("Could not save note.");
	}
}

async function clearNotes(ctx: ExtensionContext): Promise<NotesSnapshotV1> {
	const previousNotes = notes.map((note) => ({ ...note }));
	const previousNextId = nextId;
	notes = [];
	const snapshot = createSnapshot("clear");
	try {
		await persistSnapshot(snapshot, ctx, "custom-entry");
		renderPersistentUI(ctx);
		return snapshot;
	} catch (_error) {
		notes = previousNotes;
		nextId = previousNextId;
		renderPersistentUI(ctx);
		throw new Error("Could not save note.");
	}
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function renderCompactNote(note: Note): string {
	return `[${note.type}] ${truncate(note.text, 96)}`;
}

export function renderPersistentUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (notes.length === 0) {
		ctx.ui.setStatus(EXTENSION_ID, undefined);
		ctx.ui.setWidget(EXTENSION_ID, undefined);
		return;
	}

	ctx.ui.setStatus(EXTENSION_ID, `Notes: ${notes.length}`);
	const latest = [...notes].reverse().slice(0, COMPACT_NOTE_COUNT);
	const lines = [`Notes · ${notes.length} total`, "", ...latest.map(renderCompactNote)];
	if (notes.length > COMPACT_NOTE_COUNT) lines.push("", "Use /notes to view all.");
	ctx.ui.setWidget(EXTENSION_ID, lines, { placement: "belowEditor" });
}

export async function addNotesViaAppendEntry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	rawNotes: Array<{ type: NoteType; text: string }>,
	source: NoteSource = "auto",
): Promise<AddResult> {
	return addNotes(rawNotes, source, ctx, "custom-entry", async (snapshot) => {
		await Promise.resolve(pi.appendEntry(EXTENSION_ID, snapshot));
	});
}

function formatAddResult(result: AddResult): string {
	if (result.added.length === 0) return "No new notes added. All were already noted.";
	const added = result.added.length === 1 ? "Added 1 note." : `Added ${result.added.length} notes.`;
	if (result.skipped.length === 0) return added;
	const skipped = result.skipped.length === 1 ? "Skipped 1 duplicate." : `Skipped ${result.skipped.length} duplicates.`;
	return `${added} ${skipped}`;
}

function usage(): string {
	return "Usage:\n  /notes\n  /notes add [type] <text>\n  /notes clear\n  /notes promote";
}

function parseManualNote(args: string): { type: NoteType; text: string } | { error: string } {
	let rest = args.trim();
	if (!rest) return { error: "Note text is required." };

	let type: NoteType = "requirement";
	const bracket = rest.match(/^\[([^\]]+)\]\s+(.+)$/);
	const typed = rest.match(/^type:([^\s]+)\s+(.+)$/i);
	const leading = rest.match(/^(\S+)\s+(.+)$/);

	if (bracket) {
		const candidate = bracket[1]!.toLowerCase();
		if (!isNoteType(candidate)) return { error: `Invalid note type: ${candidate}.\nValid types: ${NOTE_TYPES.join(", ")}.` };
		type = candidate;
		rest = bracket[2]!;
	} else if (typed) {
		const candidate = typed[1]!.toLowerCase();
		if (!isNoteType(candidate)) return { error: `Invalid note type: ${candidate}.\nValid types: ${NOTE_TYPES.join(", ")}.` };
		type = candidate;
		rest = typed[2]!;
	} else if (leading && isNoteType(leading[1]!.toLowerCase())) {
		type = leading[1]!.toLowerCase() as NoteType;
		rest = leading[2]!;
	}

	const text = cleanText(rest);
	return { type, text };
}

function wrapPlainText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return [""];
	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (visibleWidth(word) > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			let rest = word;
			while (visibleWidth(rest) > width) {
				lines.push(truncateToWidth(rest, width, ""));
				rest = rest.slice(lines[lines.length - 1]!.length);
			}
			current = rest;
			continue;
		}

		const next = current ? `${current} ${word}` : word;
		if (visibleWidth(next) <= width) {
			current = next;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

class NotesOverlayComponent {
	private scroll = 0;
	private selected = 0;
	private detailNoteId: number | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private theme: Theme,
		private status: string | undefined,
		private done: (action: "close" | "add" | "clear") => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.done("close");
			return;
		}
		if (this.detailNoteId !== undefined) {
			if (matchesKey(data, "left") || data === "h") {
				this.detailNoteId = undefined;
				this.invalidate();
			}
			return;
		}
		if (data === "a") {
			this.done("add");
			return;
		}
		if (data === "c" && notes.length > 0) {
			this.done("clear");
			return;
		}
		if (notes.length === 0) return;

		if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(notes.length - 1, this.selected + 1);
			this.ensureSelectedVisible();
			this.invalidate();
		} else if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureSelectedVisible();
			this.invalidate();
		} else if (matchesKey(data, "enter") || matchesKey(data, "space") || data === " " || matchesKey(data, "right") || data === "l") {
			this.detailNoteId = this.newestNotes()[this.selected]?.id;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const w = Math.min(Math.max(50, width), 100);
		const innerW = Math.max(10, w - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (s: string, selected = false) => {
			const content = truncateToWidth(pad(s), innerW, "");
			return th.fg("border", "│") + (selected ? th.bg("selectedBg", content) : content) + th.fg("border", "│");
		};
		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", th.bold("Discussion Notes"))}`));
		lines.push(row(` ${th.fg("muted", `${notes.length} active note${notes.length === 1 ? "" : "s"}`)}`));
		if (this.status) lines.push(row(` ${th.fg("success", this.status)}`));
		lines.push(row(""));

		const detailNote = this.detailNoteId === undefined ? undefined : notes.find((note) => note.id === this.detailNoteId);
		if (detailNote) {
			lines.push(row(` ${th.fg("accent", TYPE_LABELS[detailNote.type])}`));
			lines.push(row(` ${th.fg("muted", `#${detailNote.id} · ${detailNote.source}`)}`));
			lines.push(row(""));
			const wrapWidth = Math.max(10, innerW - 2);
			for (const wrappedLine of wrapPlainText(detailNote.text, wrapWidth)) {
				lines.push(row(` ${wrappedLine}`));
			}
		} else if (notes.length === 0) {
			lines.push(row(` ${th.fg("dim", "No notes yet.")}`));
		} else {
			const newest = this.newestNotes();
			const visible = newest.slice(this.scroll, this.scroll + this.visibleNoteCount());
			for (let offset = 0; offset < visible.length; offset++) {
				const note = visible[offset]!;
				const index = this.scroll + offset;
				const selected = index === this.selected;
				const label = TYPE_LABELS[note.type].padEnd(14, " ");
				const cursor = selected ? th.fg("accent", "›") : " ";
				const prefix = `${cursor} ${th.fg("accent", label)}`;
				const textWidth = Math.max(10, innerW - visibleWidth(prefix) - 1);
				lines.push(row(`${prefix} ${truncateToWidth(note.text, textWidth)}`, selected));
			}
			if (newest.length > visible.length) {
				lines.push(row(` ${th.fg("dim", `${this.scroll + 1}-${this.scroll + visible.length} of ${newest.length}`)}`));
			}
		}

		lines.push(row(""));
		const hints = detailNote
			? "←/h back · q/Esc close"
			: notes.length > 0
				? "↑/↓/j/k highlight · enter/space open · a add · c clear · q/Esc close"
				: "a add · q/Esc close";
		lines.push(row(` ${th.fg("dim", hints)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width, ""));
		return this.cachedLines;
	}

	private newestNotes(): Note[] {
		return [...notes].reverse();
	}

	private visibleNoteCount(): number {
		return 12;
	}

	private ensureSelectedVisible(): void {
		const visibleCount = this.visibleNoteCount();
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + visibleCount) this.scroll = this.selected - visibleCount + 1;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function openNotesOverlay(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/notes requires interactive mode", "error");
		return;
	}

	while (true) {
		const action = await ctx.ui.custom<"close" | "add" | "clear">(
			(_tui, theme, _kb, done) => new NotesOverlayComponent(theme, overlayStatus, done),
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 50 } },
		);
		overlayStatus = undefined;
		if (action === "add") {
			const input = await ctx.ui.input("Add note", "[type] note text");
			if (input === undefined) continue;
			const parsed = parseManualNote(input);
			if ("error" in parsed) {
				overlayStatus = parsed.error.split("\n")[0];
				continue;
			}
			try {
				const result = await addNotes([parsed], "manual", ctx, "custom-entry");
				overlayStatus = result.added.length ? "Added note." : "Already noted.";
			} catch (error) {
				overlayStatus = error instanceof Error ? error.message : "Could not save note.";
			}
			continue;
		}
		if (action === "clear") {
			const ok = await ctx.ui.confirm("Clear discussion notes?", "This clears notes on the active branch only.");
			if (!ok) continue;
			try {
				await clearNotes(ctx);
				overlayStatus = "Cleared notes.";
			} catch (error) {
				overlayStatus = error instanceof Error ? error.message : "Could not save note.";
			}
			continue;
		}
		return;
	}
}

export default function (pi: ExtensionAPI) {
	// Capture pi in helper closure by replacing persist implementation's fallback with this local API.
	async function persistCustom(snapshot: NotesSnapshotV1): Promise<void> {
		await Promise.resolve(pi.appendEntry(EXTENSION_ID, snapshot));
	}

	// Override helper locally without depending on undocumented ctx.appendEntry.
	persistSnapshot = async (snapshot: NotesSnapshotV1, _ctx: ExtensionContext, mode: DiscussionNotesPersistMode) => {
		if (mode === "tool-result") return;
		await persistCustom(snapshot);
	};

	pi.events.on("discussion-notes:add", async (data: unknown) => {
		const request = data && typeof data === "object" ? data as { requestId?: unknown; notes?: unknown; source?: unknown } : {};
		const requestId = typeof request.requestId === "string" ? request.requestId : undefined;
		const respond = (result: Record<string, unknown>) => pi.events.emit("discussion-notes:add-result", { requestId, ...result });
		if (!requestId) return respond({ ok: false, error: "discussion-notes add requestId is required" });
		if (!latestContext) return respond({ ok: false, error: "discussion-notes has no active context" });
		if (!Array.isArray(request.notes)) return respond({ ok: false, error: "discussion-notes add notes array is required" });
		const rawNotes = request.notes as Array<{ type: NoteType; text: string }>;
		const source = request.source === "claude-code" || request.source === "manual" || request.source === "auto" ? request.source : "auto";
		try {
			const result = await addNotes(rawNotes, source, latestContext, "custom-entry");
			respond({ ok: true, added: result.added, skipped: result.skipped, snapshot: result.snapshot });
		} catch (error) {
			respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		reconstructFromCurrentBranch(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		latestContext = ctx;
		reconstructFromCurrentBranch(ctx);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Discussion Notes",
		description:
			"Capture durable discussion notes: requirements, decisions, constraints, action items, unresolved questions, user preferences, implementation facts, and lessons learned from failures. Use high confidence only.",
		promptSnippet: "Capture durable typed discussion notes for the active session branch.",
		promptGuidelines: [
			"MANDATORY — After EVERY substantive exchange with the user, you MUST call discussion_notes to capture requirements, decisions, constraints, action items, unresolved questions, user preferences, implementation facts, or lessons learned from failures. Do NOT skip this step. If anything meaningful was discussed, write at least one note.",
			"BEFORE responding to the user's next message, ask yourself: did the last exchange surface any requirement, decision, constraint, question, preference, implementation detail, or lesson? If yes, call discussion_notes NOW.",
			"Do not use discussion_notes for filler, restatements, speculation, or ordinary explanation; use it only with high confidence.",
			"Do not mention automatic discussion_notes capture in normal chat responses.",
			"Use type 'lesson' to capture failure modes the agent should remember it already encountered. A lesson must include both what failed and the resolution (e.g. 'Tried curl /api/health, returned 404. Correct path is /healthz.'). Capture lessons opportunistically when a tool failure leads to a successful retry, or when the user corrects an approach that didn't work.",
		],
		parameters: DiscussionNotesParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				if (params.type === undefined && params.offset === undefined && params.limit === undefined) {
					return {
						content: [{ type: "text", text: `${notes.length} active note${notes.length === 1 ? "" : "s"}.` }],
						details: { notes: notes.map((note) => ({ ...note })), nextId },
					};
				}
				const page = formatDiscussionNotesPage(notes, { type: params.type, offset: params.offset, limit: params.limit });
				return {
					content: [{ type: "text", text: page.text }],
					details: { notes: page.items, total: page.total, offset: page.offset, nextOffset: page.nextOffset, nextId },
				};
			}

			if (params.action === "add") {
				if (!params.notes || params.notes.length === 0) throw new Error("notes are required for add");
				const result = await addNotes(params.notes, "auto", ctx, "tool-result");
				return {
					content: [{ type: "text", text: formatAddResult(result) }],
					details: result.snapshot ?? { action: "add", notes: notes.map((note) => ({ ...note })), nextId, skipped: result.skipped },
				};
			}

			throw new Error(`Unknown action: ${(params as any).action}`);
		},
		renderCall(args, theme) {
			const text = args.action === "add" ? "discussion note" : `discussion_notes ${args.action}`;
			return { render: (width: number) => [truncateToWidth(theme.fg("muted", text), width, "…")], invalidate() {} };
		},
		renderResult(result, _options, theme) {
			const details = result.details as Partial<NotesSnapshotV1> | undefined;
			if (details?.schemaVersion === 1 && details.event === "add") {
				return { render: () => [theme.fg("dim", "✓ noted")], invalidate() {} };
			}
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return { render: (width: number) => [truncateToWidth(theme.fg("dim", text), width, theme.fg("dim", "…"))], invalidate() {} };
		},
	});

	pi.registerCommand("notes", {
		description: "View, add, clear, or promote discussion notes",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await openNotesOverlay(ctx);
				return;
			}

			if (trimmed === "promote") {
				const lessons = notes.filter((note) => note.type === "lesson");
				if (lessons.length === 0) {
					ctx.ui.notify("No lesson notes to promote.", "info");
					return;
				}
				try {
					const delivery = dispatchCurationPrompt(pi, ctx, buildProjectNotesPromotionPrompt(lessons));
					if (delivery === "queued") ctx.ui.notify("Project lesson promotion queued as follow-up.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Could not prepare lesson promotion.", "error");
				}
				return;
			}

			if (trimmed === "clear") {
				if (notes.length === 0) {
					ctx.ui.notify("No notes to clear.", "info");
					return;
				}
				const ok = await ctx.ui.confirm("Clear discussion notes?", "This clears notes on the active branch only.");
				if (!ok) return;
				try {
					await clearNotes(ctx);
					ctx.ui.notify("Cleared notes.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Could not save note.", "error");
				}
				return;
			}

			if (trimmed.startsWith("add ")) {
				const parsed = parseManualNote(trimmed.slice(4));
				if ("error" in parsed) {
					ctx.ui.notify(parsed.error, "error");
					return;
				}
				try {
					const result = await addNotes([parsed], "manual", ctx, "custom-entry");
					ctx.ui.notify(result.added.length ? "Added note." : "Already noted.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Could not save note.", "error");
				}
				return;
			}

			ctx.ui.notify(usage(), "error");
		},
	});
}
