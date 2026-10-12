import * as fs from "node:fs";
import * as path from "node:path";
import type { FSWatcher } from "node:fs";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeWorkflowPrompt, PLAN_TEMPLATE_PATH } from "../workflow-modes/index.js";
import { validatePlanDocsTags } from "../engineering-docs/filesystem.js";
import { formatMemoryIndexBlock, migrateFlatFile, readMemoryEntry, readMemoryIndex, resolveMemoryDir, writeMemoryFact } from "../personal-memory/store.js";
import { formatPeerBlock, isHarnessKind, MAX_MESSAGE_CHARS, MAX_PEERS, MAX_PENDING_PER_PEER, PeerMailbox, type HarnessKind, type PeerIdentity } from "./mailbox.js";
import { LIVE_TTL_MS, restorablePeers, stoppedHeartbeatAt } from "./presence.js";

const EXTENSION_ID = "claude-bridge";
const REQUEST_TYPES = new Set(["recall", "recall_entry", "save_memory", "capture", "validate_tags", "save_plan", "read_plan_tasks", "tick_plan_task", "pair", "unpair", "send_message", "read_messages", "ack_messages"]);
const PEER_BLOCK_BUDGET_CHARS = 16_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEARTBEAT_MS = 2_000;
const NAMESPACE_GC_TTL_MS = 10 * 60_000;

interface BridgePaths {
	projectRoot: string;
	root: string;
	sessions: string;
	namespace: string;
	requests: string;
	responses: string;
	processed: string;
	presence: string;
}

interface HarnessPeer {
	harness: HarnessKind;
	id: string;
}

interface PresencePeer extends HarnessPeer {
	pendingCount: number;
	inboundPendingCount: number;
}

interface BridgePresence {
	schemaVersion: 2;
	piSessionId: string;
	name: string;
	mode: string | null;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	peers: PresencePeer[];
}

interface BridgeRequest {
	id: string;
	type: string;
	payload: Record<string, unknown>;
	ts: number;
	peer?: HarnessPeer;
}

interface BridgeResponse {
	id: string;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: {
		code: string;
		message: string;
	};
}

interface RecallPayload {
	query?: string;
	mode?: "discuss" | "plan" | "build" | "design";
}

type CaptureNoteType = "requirement" | "decision" | "constraint" | "action" | "question" | "preference" | "implementation" | "lesson";

interface CapturedNote {
	id: number;
	type: CaptureNoteType;
	text: string;
	createdAt: number;
	source: string;
}

interface AddResult {
	added: CapturedNote[];
	skipped: Array<{ type: CaptureNoteType; text: string; reason: "duplicate" }>;
}

interface CaptureNoteInput {
	type: CaptureNoteType;
	text: string;
}

interface CapturePayload {
	notes: CaptureNoteInput[];
	sessionId?: string;
	claudeSessionId?: string;
	context?: string;
}

interface ValidateTagsPayload {
	planText: string;
}

interface SavePlanPayload {
	planText: string;
	planId?: string;
	confirmed?: boolean;
}

interface ReadPlanTasksPayload {
	planId?: string;
}

type TickPlanTaskPayload =
	| { taskId: string; planId?: string }
	| { title: string; planId?: string };

interface RecallEntryPayload {
	slug: string;
}

interface SaveMemoryPayload {
	name?: string;
	description?: string;
	type?: string;
	body: string;
}

interface SendMessagePayload {
	text: string;
}

interface AckMessagesPayload {
	ids: string[];
}

interface PendingEventResult {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

let startedAt = new Date().toISOString();
let activePaths: BridgePaths | null = null;
let activeProjectRoot: string | null = null;
let activePiSessionId: string | null = null;
let activeSessionName = "";
let cachedMode: string | null = null;
let pairedPeers = new Map<string, HarnessPeer>();
let mailbox: PeerMailbox | null = null;
let watcher: FSWatcher | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let passiveReason: string | null = null;
const pendingSavePlans = new Map<string, PendingEventResult>();
const pendingPlanTaskReads = new Map<string, PendingEventResult>();
const pendingPlanTaskTicks = new Map<string, PendingEventResult>();
const pendingDiscussionNotes = new Map<string, PendingEventResult>();

const SCAN_COALESCE_MS = 50; // coalesce rapid watcher events into one scan per window.
let scanScheduled = false;
let lastScanAt = 0;

function ensureDirectory(dir: string, privateMode: boolean): void {
	try { fs.mkdirSync(dir, { mode: privateMode ? 0o700 : 0o777 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Bridge path is not a real directory: ${dir}`);
	if (privateMode) fs.chmodSync(dir, 0o700);
}

function ensurePrivateDir(dir: string): void {
	ensureDirectory(dir, true);
}

function ensureBridgeParents(paths: BridgePaths): void {
	ensureDirectory(path.join(paths.projectRoot, ".pi"), false);
	ensureDirectory(path.join(paths.projectRoot, ".pi", "memory"), false);
	ensurePrivateDir(paths.root);
	ensurePrivateDir(paths.sessions);
}

function isRealDirectory(dir: string, mode?: number): boolean {
	try {
		const stat = fs.lstatSync(dir);
		return stat.isDirectory() && !stat.isSymbolicLink() && (mode === undefined || (stat.mode & 0o777) === mode);
	} catch { return false; }
}

function namespaceDirsArePrivate(paths: BridgePaths): boolean {
	return isRealDirectory(path.join(paths.projectRoot, ".pi"))
		&& isRealDirectory(path.join(paths.projectRoot, ".pi", "memory"))
		&& [paths.root, paths.sessions, paths.namespace, paths.requests, paths.responses, paths.processed].every((dir) => isRealDirectory(dir, 0o700));
}

// Rename keeps presence and response files atomic; every bridge file stays private.
function writeJsonFast(filePath: string, value: unknown): void {
	const dir = path.dirname(filePath);
	ensurePrivateDir(dir);
	const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, filePath);
		fs.chmodSync(filePath, 0o600);
	} catch (error) {
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

function safeUnlink(filePath: string): void {
	try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function readTextIfExists(filePath: string): string | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function readJson(filePath: string): unknown | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function parseTime(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function isSafeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID_RE.test(value);
}

function isHarnessName(value: unknown): value is HarnessKind {
	return isHarnessKind(value);
}

function peerKey(peer: HarnessPeer): string {
	return `${peer.harness}\0${peer.id}`;
}

function normalizePeer(value: unknown): HarnessPeer | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isHarnessName(record.harness) || !isSafeId(record.id)) return null;
	return { harness: record.harness, id: record.id };
}

function sessionIdFromContext(ctx: ExtensionContext): string | null {
	try {
		const sessionId = (ctx.sessionManager as { getSessionId?: () => string | null | undefined })?.getSessionId?.();
		return isSafeId(sessionId) ? sessionId : null;
	} catch {
		return null;
	}
}

function bridgePaths(projectRoot: string, piSessionId: string): BridgePaths {
	if (!isSafeId(piSessionId)) throw new Error("Invalid Pi session id for bridge namespace.");
	const resolvedProjectRoot = fs.realpathSync(projectRoot);
	const root = path.join(resolvedProjectRoot, ".pi", "memory", "bridge");
	const sessions = path.join(root, "sessions");
	const namespace = path.join(sessions, piSessionId);
	return {
		projectRoot: resolvedProjectRoot,
		root,
		sessions,
		namespace,
		requests: path.join(namespace, "requests"),
		responses: path.join(namespace, "responses"),
		processed: path.join(namespace, "processed"),
		presence: path.join(namespace, "presence.json"),
	};
}

function parsePresence(value: unknown, expectedSessionId?: string): BridgePresence | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 2 || !isSafeId(record.piSessionId) || (expectedSessionId && record.piSessionId !== expectedSessionId)) return null;
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || typeof record.startedAt !== "string" || typeof record.heartbeatAt !== "string") return null;
	if (typeof record.name !== "string" || !(typeof record.mode === "string" || record.mode === null)) return null;
	if (!Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.heartbeatAt))) return null;
	if (!Array.isArray(record.peers) || record.peers.length > MAX_PEERS) return null;
	const peers: PresencePeer[] = [];
	for (const rawPeer of record.peers) {
		const peer = normalizePeer(rawPeer);
		if (!peer) return null;
		const rawPresencePeer = rawPeer as Record<string, unknown>;
		const rawPendingCount = rawPresencePeer.pendingCount;
		const pendingCount = typeof rawPendingCount === "number" && Number.isFinite(rawPendingCount)
			? Math.max(0, Math.floor(rawPendingCount)) : 0;
		const rawInboundPendingCount = rawPresencePeer.inboundPendingCount;
		const inboundPendingCount = typeof rawInboundPendingCount === "number" && Number.isFinite(rawInboundPendingCount)
			? Math.max(0, Math.floor(rawInboundPendingCount)) : 0;
		peers.push({ ...peer, pendingCount, inboundPendingCount });
	}
	return {
		schemaVersion: 2,
		piSessionId: record.piSessionId,
		name: record.name,
		mode: record.mode,
		pid: record.pid,
		startedAt: record.startedAt,
		heartbeatAt: record.heartbeatAt,
		peers,
	};
}

function readPresence(filePath: string, expectedSessionId?: string): BridgePresence | null {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return null;
	} catch { return null; }
	return parsePresence(readJson(filePath), expectedSessionId);
}

function ensureBridgeDirs(paths: BridgePaths): void {
	ensureBridgeParents(paths);
	for (const dir of [paths.namespace, paths.requests, paths.responses, paths.processed]) ensurePrivateDir(dir);
}

function gcStaleNamespaces(sessionsDir: string, now = Date.now()): void {
	let entries: string[];
	try { entries = fs.readdirSync(sessionsDir); } catch { return; }
	for (const id of entries) {
		if (!isSafeId(id)) continue;
		const namespace = path.join(sessionsDir, id);
		try {
			const stat = fs.lstatSync(namespace);
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		} catch { continue; }
		const presence = readPresence(path.join(namespace, "presence.json"), id);
		const heartbeat = parseTime(presence?.heartbeatAt);
		if (heartbeat > 0 && now - heartbeat > NAMESPACE_GC_TTL_MS) {
			try { fs.rmSync(namespace, { recursive: true, force: true }); } catch { /* best-effort stale namespace GC */ }
		}
	}
}

function claimSessionNamespace(paths: BridgePaths, piSessionId: string): { active: true } | { active: false; reason: string } {
	ensureBridgeParents(paths);
	gcStaleNamespaces(paths.sessions);
	let namespaceExists = false;
	try {
		const stat = fs.lstatSync(paths.namespace);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { active: false, reason: `Pi session ${piSessionId} namespace is not a real directory.` };
		namespaceExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { active: false, reason: `Pi session ${piSessionId} namespace cannot be inspected.` };
	}
	let existing = namespaceExists ? readPresence(paths.presence, piSessionId) : null;
	const now = Date.now();
	const heartbeat = parseTime(existing?.heartbeatAt);
	const fresh = heartbeat > 0 && heartbeat <= now + LIVE_TTL_MS && now - heartbeat <= LIVE_TTL_MS;
	if (existing && fresh && existing.pid !== process.pid) {
		return { active: false, reason: `Pi session ${piSessionId} already has live bridge owner pid ${existing.pid}.` };
	}
	if (namespaceExists && !existing) {
		return { active: false, reason: `Pi session ${piSessionId} bridge namespace is initializing or invalid; retry session start.` };
	}
	if (existing && Date.now() - parseTime(existing.heartbeatAt) > NAMESPACE_GC_TTL_MS) {
		try { fs.rmSync(paths.namespace, { recursive: true, force: true }); } catch { /* retry claim will fail closed */ }
		existing = null;
	}
	if (!fs.existsSync(paths.namespace)) {
		try { fs.mkdirSync(paths.namespace, { mode: 0o700 }); }
		catch {
			const raced = readPresence(paths.presence, piSessionId);
			return { active: false, reason: raced ? `Pi session ${piSessionId} already has bridge owner pid ${raced.pid}.` : `Pi session ${piSessionId} bridge namespace is initializing; retry session start.` };
		}
	}
	if (existing) {
		startedAt = existing.startedAt;
		pairedPeers = new Map(existing.peers.map(({ harness, id }) => {
			const peer = { harness, id };
			return [peerKey(peer), peer] as const;
		}));
	} else {
		startedAt = new Date().toISOString();
		pairedPeers = new Map();
	}
	ensureBridgeDirs(paths);
	return { active: true };
}

function writePresence(paths: BridgePaths, heartbeatAt = new Date().toISOString()): void {
	if (!activePiSessionId || activePaths !== paths || !namespaceDirsArePrivate(paths)) return;
	const peers = Array.from(pairedPeers.values()).map((peer) => {
		const identity: PeerIdentity = { kind: peer.harness, id: peer.id };
		return {
			...peer,
			pendingCount: mailbox?.pendingOutboundCount(identity) ?? 0,
			inboundPendingCount: mailbox?.pendingInboundCount(identity) ?? 0,
		};
	});
	writeJsonFast(paths.presence, {
		schemaVersion: 2,
		piSessionId: activePiSessionId,
		name: activeSessionName,
		mode: cachedMode,
		pid: process.pid,
		startedAt,
		heartbeatAt,
		peers,
	} satisfies BridgePresence);
}

function listLiveNamespaces(projectRoot: string, now = Date.now()): Array<{ id: string; presence: BridgePresence }> {
	let resolvedProjectRoot: string;
	try { resolvedProjectRoot = fs.realpathSync(projectRoot); } catch { return []; }
	const piDir = path.join(resolvedProjectRoot, ".pi");
	const memoryDir = path.join(piDir, "memory");
	const rootDir = path.join(memoryDir, "bridge");
	const sessionsDir = path.join(rootDir, "sessions");
	if (!isRealDirectory(piDir) || !isRealDirectory(memoryDir) || !isRealDirectory(rootDir, 0o700) || !isRealDirectory(sessionsDir, 0o700)) return [];
	let ids: string[];
	try { ids = fs.readdirSync(sessionsDir); } catch { return []; }
	const live: Array<{ id: string; presence: BridgePresence }> = [];
	for (const id of ids) {
		if (!isSafeId(id)) continue;
		const namespace = path.join(sessionsDir, id);
		try {
			const stat = fs.lstatSync(namespace);
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		} catch { continue; }
		const presence = readPresence(path.join(namespace, "presence.json"), id);
		const heartbeat = parseTime(presence?.heartbeatAt);
		if (presence && heartbeat > 0 && now - heartbeat <= LIVE_TTL_MS && heartbeat <= now + LIVE_TTL_MS) live.push({ id, presence });
	}
	return live;
}

function sessionName(pi: ExtensionAPI): string {
	try { return pi.getSessionName() ?? ""; }
	catch { return ""; }
}

function formatAge(startedAt: string, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - parseTime(startedAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

function responsePath(paths: BridgePaths, id: string): string {
	return path.join(paths.responses, `${id}.json`);
}

function processedPath(paths: BridgePaths, id: string): string {
	return path.join(paths.processed, `${id}.json`);
}

function requestPath(paths: BridgePaths, fileName: string): string {
	return path.join(paths.requests, fileName);
}

function errorResponse(id: string, code: string, message: string): BridgeResponse {
	return { id, ok: false, error: { code, message } };
}

function validateRequest(fileId: string, raw: unknown): BridgeRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Request must be a JSON object.");
	}
	const record = raw as Record<string, unknown>;
	if (record.id !== fileId) throw new Error("Request id must match request filename.");
	if (typeof record.id !== "string" || !UUID_RE.test(record.id)) throw new Error("Request id must be a UUID.");
	if (typeof record.type !== "string" || !REQUEST_TYPES.has(record.type)) {
		throw new Error(`Request type must be one of: ${Array.from(REQUEST_TYPES).join(", ")}.`);
	}
	if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) throw new Error("Request ts must be a finite number.");
	if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("Request payload must be an object.");
	const peer = record.peer === undefined ? undefined : normalizePeer(record.peer);
	if (record.peer !== undefined && !peer) throw new Error("Request peer must contain valid harness and id.");
	if (["pair", "unpair", "send_message", "read_messages", "ack_messages"].includes(record.type as string) && !peer) throw new Error(`${record.type} request requires peer identity.`);
	return {
		id: record.id,
		type: record.type,
		payload: record.payload as Record<string, unknown>,
		ts: record.ts,
		...(peer ? { peer } : {}),
	};
}

function existsSync(filePath: string): boolean {
	try { fs.accessSync(filePath); return true; } catch { return false; }
}

function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(dir, ".pi"))) {
			try { return fs.realpathSync(dir); } catch { return null; }
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readEngineeringDocs(projectRoot: string): Array<{ path: string; text: string }> {
	const docsRoot = path.join(projectRoot, "docs", "engineering");
	const docs: Array<{ path: string; text: string }> = [];
	for (const fileName of ["README.md", "architecture.md", "dev-workflow.md", "conventions.md", "invariants.md", "traps.md"]) {
		const filePath = path.join(docsRoot, fileName);
		const text = readTextIfExists(filePath);
		if (text && text.trim()) docs.push({ path: path.relative(projectRoot, filePath), text });
	}
	const decisionsDir = path.join(docsRoot, "decisions");
	try {
		for (const fileName of fs.readdirSync(decisionsDir).sort()) {
			if (!fileName.endsWith(".md") || fileName === "ADR-template.md") continue;
			const filePath = path.join(decisionsDir, fileName);
			const text = readTextIfExists(filePath);
			if (text && text.trim()) docs.push({ path: path.relative(projectRoot, filePath), text });
		}
	} catch {
		// No decisions dir.
	}
	return docs;
}

export function promptContextForMode(mode: RecallPayload["mode"], cavemanEnabled: boolean, cwd: string): Record<string, unknown> {
	return {
		mode: mode ?? "plan",
		cavemanEnabled,
		discussPrompt: composeWorkflowPrompt("discuss", cavemanEnabled),
		planPrompt: composeWorkflowPrompt("plan", cavemanEnabled),
		buildPrompt: composeWorkflowPrompt("build", cavemanEnabled, undefined, cwd),
		designPrompt: composeWorkflowPrompt("design", cavemanEnabled),
		reviewPrompt: composeWorkflowPrompt("review", cavemanEnabled),
		planTemplatePath: PLAN_TEMPLATE_PATH,
		planTemplate: readTextIfExists(PLAN_TEMPLATE_PATH),
	};
}

function normalizeRecallPayload(payload: Record<string, unknown>): RecallPayload {
	const query = typeof payload.query === "string" ? payload.query : "";
	const mode = payload.mode === "discuss" || payload.mode === "plan" || payload.mode === "build" || payload.mode === "design" ? payload.mode : "plan";
	return { query, mode };
}

function isNoteType(value: unknown): value is CaptureNoteType {
	return typeof value === "string" && ["requirement", "decision", "constraint", "action", "question", "preference", "implementation", "lesson"].includes(value);
}

function normalizeCapturePayload(payload: Record<string, unknown>): CapturePayload {
	const rawNotes = Array.isArray(payload.notes) ? payload.notes : [];
	const notes = rawNotes.map((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each capture note must be an object.");
		const record = raw as Record<string, unknown>;
		if (!isNoteType(record.type)) throw new Error("Capture note type is invalid.");
		if (typeof record.text !== "string" || record.text.trim().length === 0) throw new Error("Capture note text is required.");
		return { type: record.type, text: record.text };
	});
	if (notes.length === 0) throw new Error("Capture request requires at least one note.");
	if (notes.length > 10) throw new Error("Capture request supports at most 10 notes.");
	const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim()
		? payload.sessionId.trim()
		: typeof payload.claudeSessionId === "string" && payload.claudeSessionId.trim()
			? payload.claudeSessionId.trim()
			: undefined;
	return {
		notes,
		...(sessionId ? { sessionId, claudeSessionId: sessionId } : {}),
		...(typeof payload.context === "string" && payload.context.trim() ? { context: payload.context.trim() } : {}),
	};
}

function normalizeValidateTagsPayload(payload: Record<string, unknown>): ValidateTagsPayload {
	if (typeof payload.planText !== "string") throw new Error("validate_tags requires planText string.");
	return { planText: payload.planText };
}

function normalizeSavePlanPayload(payload: Record<string, unknown>): SavePlanPayload {
	if (typeof payload.planText !== "string" || payload.planText.trim().length === 0) throw new Error("save_plan requires non-empty planText string.");
	if (payload.confirmed !== true) throw new Error("save_plan requires confirmed:true.");
	return {
		planText: payload.planText,
		...(typeof payload.planId === "string" && payload.planId.trim() ? { planId: payload.planId.trim() } : {}),
		confirmed: true,
	};
}

function normalizeReadPlanTasksPayload(payload: Record<string, unknown>): ReadPlanTasksPayload {
	if (payload.planId !== undefined && (typeof payload.planId !== "string" || payload.planId.trim().length === 0)) throw new Error("read_plan_tasks planId must be a non-empty string when provided.");
	return typeof payload.planId === "string" ? { planId: payload.planId.trim() } : {};
}

function normalizeTickPlanTaskPayload(payload: Record<string, unknown>): TickPlanTaskPayload {
	if (Object.keys(payload).some((key) => !["taskId", "title", "planId"].includes(key))) throw new Error("tick_plan_task accepts only taskId, title, and planId.");
	const hasTaskId = Object.prototype.hasOwnProperty.call(payload, "taskId");
	const hasTitle = Object.prototype.hasOwnProperty.call(payload, "title");
	if (hasTaskId === hasTitle) throw new Error("tick_plan_task requires exactly one of taskId or title.");
	if (payload.planId !== undefined && (typeof payload.planId !== "string" || payload.planId.trim().length === 0)) throw new Error("tick_plan_task planId must be a non-empty string when provided.");
	const planId = typeof payload.planId === "string" ? payload.planId.trim() : undefined;
	if (hasTaskId) {
		if (typeof payload.taskId !== "string" || payload.taskId.trim().length === 0 || payload.taskId.length > 128) throw new Error("tick_plan_task requires taskId string of at most 128 characters.");
		return { taskId: payload.taskId.trim(), ...(planId ? { planId } : {}) };
	}
	if (typeof payload.title !== "string" || payload.title.trim().length === 0 || payload.title.length > 512) throw new Error("tick_plan_task requires title string of at most 512 characters.");
	return { title: payload.title, ...(planId ? { planId } : {}) };
}

function normalizeRecallEntryPayload(payload: Record<string, unknown>): RecallEntryPayload {
	if (typeof payload.slug !== "string" || payload.slug.trim().length === 0) throw new Error("recall_entry requires slug string.");
	return { slug: payload.slug.trim() };
}

function normalizeSaveMemoryPayload(payload: Record<string, unknown>): SaveMemoryPayload {
	if (typeof payload.body !== "string" || payload.body.trim().length === 0) throw new Error("save_memory requires non-empty body string.");
	return {
		...(typeof payload.name === "string" && payload.name.trim() ? { name: payload.name.trim() } : {}),
		...(typeof payload.description === "string" && payload.description.trim() ? { description: payload.description.trim() } : {}),
		...(typeof payload.type === "string" && payload.type.trim() ? { type: payload.type.trim() } : {}),
		body: payload.body,
	};
}

function normalizeSendMessagePayload(payload: Record<string, unknown>): SendMessagePayload {
	if (Object.keys(payload).some((key) => key !== "text")) throw new Error("send_message accepts only text.");
	if (typeof payload.text !== "string" || payload.text.length < 1 || payload.text.length > MAX_MESSAGE_CHARS) {
		throw new Error(`send_message text must contain 1-${MAX_MESSAGE_CHARS} characters.`);
	}
	return { text: payload.text };
}

function normalizeReadMessagesPayload(payload: Record<string, unknown>): void {
	if (Object.keys(payload).length > 0) throw new Error("read_messages accepts an empty payload.");
}

function normalizeAckMessagesPayload(payload: Record<string, unknown>): AckMessagesPayload {
	if (Object.keys(payload).some((key) => key !== "ids")) throw new Error("ack_messages accepts only ids.");
	if (!Array.isArray(payload.ids) || payload.ids.length > MAX_PENDING_PER_PEER) throw new Error(`ack_messages requires an ids array of at most ${MAX_PENDING_PER_PEER} entries.`);
	if (payload.ids.some((id) => !isSafeId(id))) throw new Error("ack_messages ids must be path-safe message ids.");
	return { ids: payload.ids as string[] };
}

function handleValidateTags(request: BridgeRequest): BridgeResponse {
	try {
		const payload = normalizeValidateTagsPayload(request.payload);
		const validations = validatePlanDocsTags(payload.planText);
		const invalid = validations.filter((item) => !item.valid);
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				valid: invalid.length === 0,
				validations,
				invalid,
			},
		};
	} catch (error) {
		return errorResponse(request.id, "validate_tags_failed", error instanceof Error ? error.message : String(error));
	}
}

function requestWorkflowSavePlan(pi: ExtensionAPI, requestId: string, payload: SavePlanPayload): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSavePlans.delete(requestId);
			reject(new Error("workflow-modes save-plan event timed out."));
		}, 1_500);
		timer.unref?.();
		pendingSavePlans.set(requestId, { resolve, reject, timer });
		pi.events.emit("workflow-modes:save-plan", {
			requestId,
			planId: payload.planId ?? requestId,
			plan: payload.planText,
		});
	});
}

function requestWorkflowPlanTasks(pi: ExtensionAPI, requestId: string, payload: ReadPlanTasksPayload): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingPlanTaskReads.delete(requestId);
			reject(new Error("workflow-modes task read event timed out."));
		}, 1_500);
		timer.unref?.();
		pendingPlanTaskReads.set(requestId, { resolve, reject, timer });
		pi.events.emit("workflow-modes:get-plan-tasks", { requestId, ...payload });
	});
}

function requestWorkflowPlanTaskTick(pi: ExtensionAPI, requestId: string, payload: TickPlanTaskPayload): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingPlanTaskTicks.delete(requestId);
			reject(new Error("workflow-modes task tick event timed out."));
		}, 1_500);
		timer.unref?.();
		pendingPlanTaskTicks.set(requestId, { resolve, reject, timer });
		pi.events.emit("workflow-modes:tick-plan-task", { requestId, ...payload });
	});
}

async function handleSavePlan(pi: ExtensionAPI, _ctx: ExtensionContext, request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeSavePlanPayload(request.payload);
		const result = await requestWorkflowSavePlan(pi, request.id, payload);
		if (result.ok !== true) {
			return errorResponse(request.id, "save_plan_failed", typeof result.error === "string" ? result.error : "workflow-modes save-plan failed.");
		}
		const planId = typeof result.planId === "string" ? result.planId : payload.planId ?? request.id;
		const savedAt = typeof result.savedAt === "string" ? result.savedAt : new Date().toISOString();
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				planId,
				path: typeof result.path === "string" ? result.path : null,
				savedAt,
				taskCount: typeof result.taskCount === "number" ? result.taskCount : 0,
				chars: typeof result.chars === "number" ? result.chars : payload.planText.length,
			},
		};
	} catch (error) {
		return errorResponse(request.id, "save_plan_failed", error instanceof Error ? error.message : String(error));
	}
}

function requestWorkflowState(pi: ExtensionAPI): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pi.events.off?.("workflow-modes:state", onState);
			resolve(null);
		}, 300);
		timer.unref?.();
		const onState = (data: unknown) => {
			clearTimeout(timer);
			pi.events.off?.("workflow-modes:state", onState);
			resolve(data && typeof data === "object" ? data as Record<string, unknown> : null);
		};
		pi.events.on("workflow-modes:state", onState);
		pi.events.emit("workflow-modes:get");
	});
}

async function handleReadPlanTasks(pi: ExtensionAPI, request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeReadPlanTasksPayload(request.payload);
		const result = await requestWorkflowPlanTasks(pi, request.id, payload);
		if (result.ok !== true) return errorResponse(request.id, "read_plan_tasks_failed", typeof result.error === "string" ? result.error : "workflow-modes task read failed.");
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				planId: result.planId ?? null,
				tasks: Array.isArray(result.tasks) ? result.tasks : [],
				completedTaskIds: Array.isArray(result.completedTaskIds) ? result.completedTaskIds : [],
				progress: result.progress ?? { done: 0, total: 0 },
				...(result.nextTask ? { nextTask: result.nextTask } : {}),
			},
		};
	} catch (error) {
		return errorResponse(request.id, "read_plan_tasks_failed", error instanceof Error ? error.message : String(error));
	}
}

async function handleTickPlanTask(pi: ExtensionAPI, request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeTickPlanTaskPayload(request.payload);
		const result = await requestWorkflowPlanTaskTick(pi, request.id, payload);
		if (result.ok !== true) return errorResponse(request.id, "tick_plan_task_failed", typeof result.error === "string" ? result.error : "workflow-modes task tick failed.");
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				planId: result.planId ?? null,
				taskId: result.taskId ?? ("taskId" in payload ? payload.taskId : null),
				progress: result.progress ?? { done: 0, total: 0 },
				...(result.nextTask ? { nextTask: result.nextTask } : {}),
				idempotent: result.idempotent === true,
				outOfOrder: result.outOfOrder === true,
			},
		};
	} catch (error) {
		return errorResponse(request.id, "tick_plan_task_failed", error instanceof Error ? error.message : String(error));
	}
}

async function handleRecall(pi: ExtensionAPI, request: BridgeRequest): Promise<BridgeResponse> {
	const payload = normalizeRecallPayload(request.payload);
	const cwd = activeProjectRoot ?? process.cwd();
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot) {
		return errorResponse(request.id, "not_pi_project", "Pi bridge recall requires an existing Pi project with a .pi directory.");
	}

	const workflowState = await requestWorkflowState(pi);
	if (!workflowState) {
		return errorResponse(request.id, "workflow_state_unavailable", "Pi bridge recall requires live workflow-modes state.");
	}
	const cavemanEnabled = workflowState.cavemanEnabled !== false;
	const workflowPlan = typeof workflowState.plan === "string" ? workflowState.plan : undefined;
	const workflowPlanId = typeof workflowState.planId === "string" ? workflowState.planId : undefined;
	const progress = workflowState.progress && typeof workflowState.progress === "object" ? workflowState.progress : { done: 0, total: 0 };
	const savedPlan = workflowPlanId || workflowPlan
		? {
			planId: workflowPlanId ?? null,
			path: typeof workflowState.path === "string" ? workflowState.path : null,
			planText: workflowPlan ?? null,
			savedAt: typeof workflowState.savedAt === "string" ? workflowState.savedAt : null,
			progress,
			...(workflowState.nextTask ? { nextTask: workflowState.nextTask } : {}),
		}
		: null;
	const memoryDir = resolveMemoryDir(getAgentDir());
	await migrateFlatFile(memoryDir);
	const personalIndex = await readMemoryIndex(memoryDir);
	const personalBlock = formatMemoryIndexBlock(personalIndex) ?? "";
	const memoryBlocks = personalBlock ? [personalBlock] : [];
	return {
		id: request.id,
		ok: true,
		result: {
			requestId: request.id,
			projectRoot,
			query: payload.query ?? "",
			memory: {
				personal: {
					path: path.join(memoryDir, "MEMORY.md"),
					loaded: Boolean(personalIndex),
					block: personalBlock,
				},
				blocks: memoryBlocks,
			},
			docs: readEngineeringDocs(projectRoot),
			prompts: promptContextForMode(payload.mode, cavemanEnabled, projectRoot),
			savedPlan,
		},
	};
}

async function handleRecallEntry(request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeRecallEntryPayload(request.payload);
		const memoryDir = resolveMemoryDir(getAgentDir());
		await migrateFlatFile(memoryDir);
		const entry = await readMemoryEntry(memoryDir, payload.slug);
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				slug: payload.slug,
				path: path.join(memoryDir, `${payload.slug}.md`),
				loaded: Boolean(entry),
				entry: entry ?? null,
			},
		};
	} catch (error) {
		return errorResponse(request.id, "recall_entry_failed", error instanceof Error ? error.message : String(error));
	}
}

async function handleSaveMemory(request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeSaveMemoryPayload(request.payload);
		const memoryDir = resolveMemoryDir(getAgentDir());
		await migrateFlatFile(memoryDir);
		const result = await writeMemoryFact(payload, memoryDir);
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				slug: result.slug,
				path: result.path,
				indexPath: path.join(memoryDir, "MEMORY.md"),
			},
		};
	} catch (error) {
		return errorResponse(request.id, "save_memory_failed", error instanceof Error ? error.message : String(error));
	}
}

function requireActiveMailbox(): { paths: BridgePaths; mailbox: PeerMailbox; local: PeerIdentity } {
	if (!activePaths || !activePiSessionId || !mailbox || !namespaceDirsArePrivate(activePaths)) {
		throw new Error("Pi bridge is not active for this session.");
	}
	return { paths: activePaths, mailbox, local: { kind: "pi", id: activePiSessionId } };
}

function notifyBestEffort(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning"): void {
	try { ctx?.ui.notify(message, level); } catch { /* UI notification must not change mailbox delivery outcome. */ }
}

function updateInboundStatus(ctx: ExtensionContext): number {
	const count = mailbox?.pendingInbound().length ?? 0;
	try { ctx.ui.setStatus(EXTENSION_ID, count > 0 ? `Claude bridge: ${count} inbound pending` : "Claude bridge: active"); }
	catch { /* Status refresh is best-effort; heartbeat still updates presence. */ }
	return count;
}

function refreshPresenceBestEffort(ctx: ExtensionContext): void {
	if (!activePaths) return;
	try { writePresence(activePaths); }
	catch (error) { notifyBestEffort(ctx, `Claude bridge pending count refresh failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
}

async function handleSendMessage(ctx: ExtensionContext, request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeSendMessagePayload(request.payload);
		const active = requireActiveMailbox();
		const peer = request.peer!;
		const envelope = {
			id: request.id,
			from: { kind: peer.harness, id: peer.id },
			to: active.local,
			text: payload.text,
			sentAt: new Date().toISOString(),
		};
		const received = active.mailbox.receive(envelope);
		if (received) {
			const pending = updateInboundStatus(ctx);
			notifyBestEffort(ctx, `Peer message received from ${peer.harness}:${peer.id} (${pending} pending).`, "info");
		}
		return { id: request.id, ok: true, result: { requestId: request.id, messageId: request.id, received } };
	} catch (error) {
		return errorResponse(request.id, "send_message_failed", error instanceof Error ? error.message : String(error));
	}
}

function handleReadMessages(request: BridgeRequest): BridgeResponse {
	try {
		normalizeReadMessagesPayload(request.payload);
		const active = requireActiveMailbox();
		const peer = request.peer!;
		const messages = active.mailbox.pendingFor({ kind: peer.harness, id: peer.id });
		return { id: request.id, ok: true, result: { requestId: request.id, messages } };
	} catch (error) {
		return errorResponse(request.id, "read_messages_failed", error instanceof Error ? error.message : String(error));
	}
}

function handleAckMessages(request: BridgeRequest): BridgeResponse {
	try {
		const payload = normalizeAckMessagesPayload(request.payload);
		const active = requireActiveMailbox();
		const peer = request.peer!;
		const acknowledged = active.mailbox.ack({ kind: peer.harness, id: peer.id }, payload.ids);
		return { id: request.id, ok: true, result: { requestId: request.id, acknowledged } };
	} catch (error) {
		return errorResponse(request.id, "ack_messages_failed", error instanceof Error ? error.message : String(error));
	}
}

function requestDiscussionNotesAdd(pi: ExtensionAPI, requestId: string, payload: CapturePayload): Promise<AddResult> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingDiscussionNotes.delete(requestId);
			reject(new Error("discussion-notes add event timed out."));
		}, 1_500);
		timer.unref?.();
		pendingDiscussionNotes.set(requestId, {
			resolve: (result) => {
				if (result.ok !== true) {
					reject(new Error(typeof result.error === "string" ? result.error : "discussion-notes add failed."));
					return;
				}
				resolve({
					added: Array.isArray(result.added) ? result.added as CapturedNote[] : [],
					skipped: Array.isArray(result.skipped) ? result.skipped as AddResult["skipped"] : [],
				});
			},
			reject,
			timer,
		});
		pi.events.emit("discussion-notes:add", {
			requestId,
			notes: payload.notes,
			source: "claude-code",
		});
	});
}

async function handleCapture(pi: ExtensionAPI, ctx: ExtensionContext, request: BridgeRequest): Promise<BridgeResponse> {
	let payload: CapturePayload;
	try {
		payload = normalizeCapturePayload(request.payload);
	} catch (error) {
		return errorResponse(request.id, "invalid_capture", error instanceof Error ? error.message : String(error));
	}
	const projectRoot = findProjectRoot(activeProjectRoot ?? ctx.cwd ?? process.cwd());
	if (!projectRoot) {
		return errorResponse(request.id, "not_pi_project", "Pi bridge capture requires an existing Pi project with a .pi directory.");
	}
	try {
		const addResult = await requestDiscussionNotesAdd(pi, request.id, payload);
		const sessionId = payload.sessionId ?? payload.claudeSessionId;
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				noteIds: addResult.added.map((note) => note.id),
				noteId: addResult.added[0]?.id ?? null,
				added: addResult.added.length,
				skipped: addResult.skipped,
				widgetUpdated: true,
				source: "claude-code",
				projectRoot,
				...(sessionId ? { sessionId, claudeSessionId: sessionId } : {}),
			},
		};
	} catch (error) {
		return errorResponse(request.id, "capture_failed", error instanceof Error ? error.message : String(error));
	}
}

async function handleRequest(pi: ExtensionAPI, ctx: ExtensionContext, request: BridgeRequest): Promise<BridgeResponse> {
	if (request.type === "recall") return handleRecall(pi, request);
	if (request.type === "recall_entry") return handleRecallEntry(request);
	if (request.type === "save_memory") return handleSaveMemory(request);
	if (request.type === "capture") return handleCapture(pi, ctx, request);
	if (request.type === "validate_tags") return handleValidateTags(request);
	if (request.type === "save_plan") return handleSavePlan(pi, ctx, request);
	if (request.type === "read_plan_tasks") return handleReadPlanTasks(pi, request);
	if (request.type === "tick_plan_task") return handleTickPlanTask(pi, request);
	if (request.type === "send_message") return handleSendMessage(ctx, request);
	if (request.type === "read_messages") return handleReadMessages(request);
	if (request.type === "ack_messages") return handleAckMessages(request);
	return errorResponse(request.id, "not_implemented", `Bridge handler not implemented for request type: ${request.type}.`);
}

function writeResponse(paths: BridgePaths, response: BridgeResponse): void {
	if (!namespaceDirsArePrivate(paths)) return;
	// Write processed/ first (source of truth for idempotency), then responses/.
	// Both use writeJsonFast — no fsync, rename-only. Safe since we unlink the
	// request file immediately after, so no concurrent reader can see a
	// partial-in-progress response before both files are stable.
	writeJsonFast(processedPath(paths, response.id), response);
	writeJsonFast(responsePath(paths, response.id), response);
}

function replayProcessedResponse(paths: BridgePaths, id: string): boolean {
	// Fast path: if response already exists, nothing to do (no read of processed/).
	if (existsSync(responsePath(paths, id))) return true;
	const processed = readJson(processedPath(paths, id));
	if (!processed) return false;
	writeJsonFast(responsePath(paths, id), processed);
	return true;
}

async function processRequestFile(pi: ExtensionAPI, ctx: ExtensionContext, paths: BridgePaths, fileName: string): Promise<void> {
	if (activePaths !== paths || !fileName.endsWith(".json")) return;
	const fileId = fileName.slice(0, -".json".length);
	if (!UUID_RE.test(fileId)) return;
	if (replayProcessedResponse(paths, fileId)) {
		safeUnlink(requestPath(paths, fileName));
		return;
	}

	const absolute = requestPath(paths, fileName);
	const resolved = path.resolve(absolute);
	const requestRoot = path.resolve(paths.requests) + path.sep;
	let requestStat: fs.Stats | null = null;
	try { requestStat = fs.lstatSync(resolved); } catch { return; }
	if (!resolved.startsWith(requestRoot)) {
		writeResponse(paths, errorResponse(fileId, "path_traversal", "Request path escaped bridge requests directory."));
		return;
	}
	if (!requestStat.isFile() || requestStat.isSymbolicLink() || (requestStat.mode & 0o777) !== 0o600) {
		safeUnlink(absolute);
		return;
	}

	let response: BridgeResponse;
	try {
		const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
		const request = validateRequest(fileId, raw);
		if (request.type === "pair" || request.type === "unpair") {
			const peer = request.peer!;
			const key = peerKey(peer);
			if (request.type === "pair" && !pairedPeers.has(key) && pairedPeers.size >= MAX_PEERS) {
				response = errorResponse(request.id, "peer_cap", `Cannot pair more than ${MAX_PEERS} peers.`);
			} else {
				if (request.type === "pair") {
					pairedPeers.set(key, peer);
					mailbox?.pair({ kind: peer.harness, id: peer.id });
				} else {
					pairedPeers.delete(key);
					mailbox?.unpair({ kind: peer.harness, id: peer.id });
				}
				writePresence(paths);
				response = { id: request.id, ok: true, result: { paired: request.type === "pair", peer } };
			}
		} else {
			response = await handleRequest(pi, ctx, request);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		response = errorResponse(fileId, "invalid_request", message);
	}
	writeResponse(paths, response);
	// Unlink request file so subsequent scans are O(in-flight), not O(history).
	safeUnlink(requestPath(paths, fileName));
	writePresence(paths);
}

async function scanRequests(pi: ExtensionAPI, ctx: ExtensionContext, paths: BridgePaths): Promise<void> {
	if (activePaths !== paths || !namespaceDirsArePrivate(paths)) return;
	let fileNames: string[] = [];
	try {
		fileNames = fs.readdirSync(paths.requests);
	} catch {
		return;
	}
	for (const fileName of fileNames) await processRequestFile(pi, ctx, paths, fileName);
}

function scheduleScan(pi: ExtensionAPI, ctx: ExtensionContext, paths: BridgePaths): void {
	const now = Date.now();
	if (scanScheduled) return;
	if (now - lastScanAt < SCAN_COALESCE_MS) return;
	scanScheduled = true;
	lastScanAt = now;
	setTimeout(() => {
		scanScheduled = false;
		void scanRequests(pi, ctx, paths);
	}, SCAN_COALESCE_MS).unref?.();
}

function startWatcher(pi: ExtensionAPI, paths: BridgePaths, ctx: ExtensionContext): void {
	watcher?.close();
	watcher = fs.watch(paths.requests, (_eventType, _fileName) => scheduleScan(pi, ctx, paths));
	watcher.on("error", (error) => {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`claude-bridge watcher failed: ${message}`, "error");
	});
	void scanRequests(pi, ctx, paths);
	// No backup poll — fs.watch is sufficient on modern macOS/Node with O(1) in-flight requests.
}

function dropPendingMessages(ctx: ExtensionContext | undefined, reason: string): number {
	const dropped = mailbox?.dropAll() ?? 0;
	mailbox = null;
	if (dropped > 0) notifyBestEffort(ctx, `claude-bridge dropped ${dropped} pending peer message(s) on ${reason}.`, "warning");
	return dropped;
}

function stopActiveBridge(ctx?: ExtensionContext, reason = "shutdown"): void {
	watcher?.close();
	watcher = null;
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
	dropPendingMessages(ctx, reason);
	if (activePaths && activePiSessionId && namespaceDirsArePrivate(activePaths)) {
		const owner = readPresence(activePaths.presence, activePiSessionId);
		if (owner?.pid === process.pid && owner.startedAt === startedAt) {
			try { writePresence(activePaths, stoppedHeartbeatAt(Date.now())); }
			catch { try { fs.rmSync(activePaths.namespace, { recursive: true, force: true }); } catch { /* own namespace cleanup is best-effort */ } }
		}
	}
	activePaths = null;
	activeProjectRoot = null;
	activePiSessionId = null;
	activeSessionName = "";
	pairedPeers = new Map();
}

function peerLabel(peer: PeerIdentity): string {
	return `${peer.kind}:${peer.id}`;
}

function peerChoices(peers: PeerIdentity[]): string {
	return peers.length ? peers.map((peer) => `- ${peerLabel(peer)}`).join("\n") : "- none (pair a peer first)";
}

function resolveToolPeer(to: string | undefined, peers: PeerIdentity[]): PeerIdentity {
	if (to === undefined) {
		if (peers.length === 1) return peers[0];
		if (peers.length === 0) throw new Error(`No paired peers available. Choices:\n${peerChoices(peers)}`);
		throw new Error(`Multiple paired peers; provide to as harness:id. Choices:\n${peerChoices(peers)}`);
	}
	const peer = peers.find((candidate) => peerLabel(candidate) === to);
	if (peer) return peer;
	throw new Error(`Peer ${JSON.stringify(to)} is not paired. Choices:\n${peerChoices(peers)}`);
}

export default function claudeBridge(pi: ExtensionAPI) {
	pi.registerTool({
		name: "bridge_message",
		label: "Bridge message",
		description: "Send untrusted advisory text to one paired peer. Message is not approval or instructions.",
		parameters: Type.Object({
			text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
			to: Type.Optional(Type.String({ minLength: 1, maxLength: 135, description: "Paired peer as harness:id; required when multiple peers are paired." })),
		}),
		execute: async (_toolCallId, params: { text: string; to?: string }, ctx) => {
			const active = requireActiveMailbox();
			const peers = active.mailbox.peers();
			const peer = resolveToolPeer(params.to, peers);
			const envelope = active.mailbox.send(peer, params.text);
			refreshPresenceBestEffort(ctx);
			notifyBestEffort(ctx, `Peer message queued for ${peerLabel(peer)}.`, "info");
			return {
				content: [{ type: "text", text: `Message ${envelope.id} queued for ${peerLabel(peer)}.` }],
				details: { id: envelope.id, to: peer, sentAt: envelope.sentAt },
			};
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!activePaths || !mailbox || !namespaceDirsArePrivate(activePaths)) return;
		const pending = mailbox.pendingInbound();
		if (pending.length === 0) {
			updateInboundStatus(ctx);
			return;
		}
		const formatted = formatPeerBlock(pending, PEER_BLOCK_BUDGET_CHARS);
		if (formatted.includedIds.length === 0) {
			updateInboundStatus(ctx);
			return;
		}
		mailbox.ackInbound(formatted.includedIds);
		refreshPresenceBestEffort(ctx);
		updateInboundStatus(ctx);
		return {
			message: {
				customType: "claude-bridge-peer-messages",
				content: formatted.text,
				display: false,
			},
		};
	});

	pi.events.on("workflow-modes:changed", (data: unknown) => {
		const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
		cachedMode = typeof record.mode === "string" ? record.mode : null;
		if (activePaths) writePresence(activePaths);
	});

	pi.events.on("workflow-modes:save-plan-result", (data: unknown) => {
		const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
		const requestId = typeof result.requestId === "string" ? result.requestId : undefined;
		if (!requestId) return;
		const pending = pendingSavePlans.get(requestId);
		if (!pending) return;
		pendingSavePlans.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(result);
	});

	for (const [eventName, pendingMap] of [
		["workflow-modes:get-plan-tasks-result", pendingPlanTaskReads],
		["workflow-modes:tick-plan-task-result", pendingPlanTaskTicks],
	] as const) {
		pi.events.on(eventName, (data: unknown) => {
			const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
			const requestId = typeof result.requestId === "string" ? result.requestId : undefined;
			if (!requestId) return;
			const pending = pendingMap.get(requestId);
			if (!pending) return;
			pendingMap.delete(requestId);
			clearTimeout(pending.timer);
			pending.resolve(result);
		});
	}

	pi.events.on("discussion-notes:add-result", (data: unknown) => {
		const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
		const requestId = typeof result.requestId === "string" ? result.requestId : undefined;
		if (!requestId) return;
		const pending = pendingDiscussionNotes.get(requestId);
		if (!pending) return;
		pendingDiscussionNotes.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(result);
	});

	pi.on("session_start", async (_event, ctx) => {
		stopActiveBridge(ctx, "session switch");
		passiveReason = null;
		cachedMode = null;
		const projectRoot = findProjectRoot(ctx.cwd ?? process.cwd());
		if (!projectRoot) {
			ctx.ui.setStatus(EXTENSION_ID, undefined);
			return;
		}
		const piSessionId = sessionIdFromContext(ctx);
		if (!piSessionId) {
			passiveReason = "Pi session id is missing or invalid; bridge namespace cannot be created.";
			ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: passive");
			ctx.ui.notify(`claude-bridge passive: ${passiveReason}`, "warning");
			return;
		}

		const paths = bridgePaths(projectRoot, piSessionId);
		const claim = claimSessionNamespace(paths, piSessionId);
		if (!claim.active) {
			passiveReason = claim.reason;
			ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: passive");
			ctx.ui.notify(`claude-bridge passive: ${claim.reason}`, "warning");
			return;
		}

		const restored = restorablePeers(
			Array.from(pairedPeers.values()),
			listLiveNamespaces(projectRoot).filter(({ id }) => id !== piSessionId).map(({ presence }) => presence),
		);
		const restoredCount = restored.length;
		pairedPeers = new Map(restored.map((peer) => [peerKey(peer), peer] as const));
		activePaths = paths;
		activeProjectRoot = projectRoot;
		activePiSessionId = piSessionId;
		activeSessionName = sessionName(pi);
		mailbox = new PeerMailbox({ kind: "pi", id: piSessionId });
		for (const peer of pairedPeers.values()) mailbox.pair({ kind: peer.harness, id: peer.id });
		writePresence(paths);
		startWatcher(pi, paths, ctx);
		heartbeatTimer = setInterval(() => {
			if (!activePaths || !activePiSessionId) return;
			const current = readPresence(activePaths.presence, activePiSessionId);
			if (!current || current.pid !== process.pid || current.startedAt !== startedAt) {
				passiveReason = `Pi session ${activePiSessionId} bridge ownership changed.`;
				watcher?.close();
				watcher = null;
				clearInterval(heartbeatTimer!);
				heartbeatTimer = null;
				dropPendingMessages(ctx, "bridge ownership change");
				activePaths = null;
				activeProjectRoot = null;
				activePiSessionId = null;
				pairedPeers = new Map();
				ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: passive");
				ctx.ui.notify(`claude-bridge passive: ${passiveReason}`, "warning");
				return;
			}
			writePresence(activePaths);
		}, HEARTBEAT_MS);
		heartbeatTimer.unref?.();
		ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: active");
		const restoredNotice = restoredCount > 0 ? ` (restored ${restoredCount} ${restoredCount === 1 ? "peer" : "peers"})` : "";
		ctx.ui.notify(`claude-bridge active: ${paths.namespace}${restoredNotice}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopActiveBridge(ctx, "shutdown");
	});

	pi.registerCommand("claude-bridge", {
		description: "List live Claude bridge sessions and paired peers",
		handler: async (_args, ctx) => {
			const projectRoot = findProjectRoot(ctx.cwd ?? process.cwd());
			const sessions = projectRoot ? listLiveNamespaces(projectRoot) : [];
			if (sessions.length === 0) {
				ctx.ui.notify(`No live Claude bridge sessions.${passiveReason ? `\n${passiveReason}` : ""}`, passiveReason ? "warning" : "info");
				return;
			}
			const lines = sessions.map(({ id, presence }) => {
				const peers = presence.peers.length
					? presence.peers.map((peer) => `${peer.harness}:${peer.id} (${peer.pendingCount} outbound / ${peer.inboundPendingCount} inbound pending)`).join(", ")
					: "none";
				return `- ${id.slice(0, 8)} (${id})${presence.name ? ` — ${presence.name}` : ""} [${presence.mode ?? "unknown"}] age ${formatAge(presence.startedAt)}; peers: ${peers}`;
			});
			ctx.ui.notify(`Claude bridge live sessions\n${lines.join("\n")}`, "info");
		},
	});
}
