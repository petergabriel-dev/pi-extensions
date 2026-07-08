import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BUILD_PROMPT, DISCUSS_PROMPT, getWorkflowPolicySnapshot, PLAN_PROMPT, PLAN_TEMPLATE_PATH } from "../workflow-modes/index.js";
import { validatePlanDocsTags } from "../engineering-docs/filesystem.js";
import { formatMemoryIndexBlock, migrateFlatFile, readMemoryEntry, readMemoryIndex, resolveMemoryDir, writeMemoryFact } from "../personal-memory/store.js";

const EXTENSION_ID = "claude-bridge";
const REQUEST_TYPES = new Set(["recall", "recall_entry", "save_memory", "capture", "validate_tags", "save_plan"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_TTL_MS = 5_000;
const HEARTBEAT_MS = 2_000; // 2s; Pi lock TTL is 5s, so 2s gives 2.5x headroom.
const POLICY_TTL_MS = 4_000;

interface BridgePaths {
	root: string;
	requests: string;
	responses: string;
	processed: string;
	policy: string;
	session: string;
}

interface BridgeSessionLock {
	schemaVersion: 1;
	status: "active";
	bridgeSessionId: string;
	piSessionId: string | null;
	pid: number;
	projectRoot: string;
	startedAt: string;
	heartbeatAt: string;
}

interface BridgeRequest {
	id: string;
	type: string;
	payload: Record<string, unknown>;
	ts: number;
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
	mode?: "discuss" | "plan" | "build";
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

interface RecallEntryPayload {
	slug: string;
}

interface SaveMemoryPayload {
	name?: string;
	description?: string;
	type?: string;
	body: string;
}

interface PendingEventResult {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

let bridgeSessionId = randomUUID();
let startedAt = new Date().toISOString();
let activePaths: BridgePaths | null = null;
let activeProjectRoot: string | null = null;
let watcher: FSWatcher | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let passiveReason: string | null = null;
const pendingSavePlans = new Map<string, PendingEventResult>();
const pendingDiscussionNotes = new Map<string, PendingEventResult>();
let latestSavedPlan: { planId: string; planText: string; savedAt: string } | null = null;

const SCAN_COALESCE_MS = 50; // coalesce rapid watcher events into one scan per window.
let scanScheduled = false;
let lastScanAt = 0;

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	ensureDir(dir);
	const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fs.writeFileSync(tmp, content, "utf-8");
		fd = fs.openSync(tmp, "r+");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tmp, filePath);
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

// Drop fsync for high-frequency writes — rename is sufficient safety.
function writeJsonFast(filePath: string, value: unknown): void {
	const dir = path.dirname(filePath);
	ensureDir(dir);
	const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
		// No fsync — rename is atomic enough for idempotent cache files.
		fs.closeSync(fs.openSync(tmp, "r+"));
		fd = undefined;
		fs.renameSync(tmp, filePath);
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function parseTime(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function sessionIdFromContext(ctx: ExtensionContext): string | null {
	try {
		const sessionId = (ctx.sessionManager as { getSessionId?: () => string | null | undefined })?.getSessionId?.();
		return sessionId ? String(sessionId) : null;
	} catch {
		return null;
	}
}

function bridgePaths(projectRoot: string): BridgePaths {
	const root = path.join(projectRoot, ".pi", "memory", "bridge");
	return {
		root,
		requests: path.join(root, "requests"),
		responses: path.join(root, "responses"),
		processed: path.join(root, "processed"),
		policy: path.join(root, "policy.json"),
		session: path.join(root, "session.json"),
	};
}

function ensureBridgeDirs(paths: BridgePaths): void {
	ensureDir(paths.requests);
	ensureDir(paths.responses);
	ensureDir(paths.processed);
}

function isStaleLock(lock: unknown, now = Date.now()): { stale: true; reason: string } | { stale: false } {
	if (!lock || typeof lock !== "object") return { stale: false }; // no/unreadable lock file → free to claim
	const record = lock as Partial<BridgeSessionLock>;
	if (record.status !== "active" || typeof record.bridgeSessionId !== "string") {
		return { stale: false }; // missing/unset is okay for us to claim
	}
	// Same bridge session: fine, we refresh it.
	if (record.bridgeSessionId === bridgeSessionId) return { stale: false };
	const heartbeat = parseTime(record.heartbeatAt);
	// Stale if: heartbeat is older than our lock TTL (another session's heartbeat expired).
	if (heartbeat > 0 && now - heartbeat <= LOCK_TTL_MS) {
		return { stale: true, reason: `Another active Pi bridge owns this project (${record.bridgeSessionId}).` };
	}
	// Heartbeat expired: treat it as our session (it was ours before Pi restart).
	return { stale: false };
}

function claimSessionLock(paths: BridgePaths, projectRoot: string, piSessionId: string | null): { active: true } | { active: false; reason: string } {
	const existing = readJson(paths.session);
	const stale = isStaleLock(existing);
	if (stale.stale) {
		return { active: false, reason: stale.reason };
	}
	const now = new Date().toISOString();
	const policy = getWorkflowPolicySnapshot();
	const batch = JSON.stringify({
		lock: {
			schemaVersion: 1,
			status: "active",
			bridgeSessionId,
			piSessionId,
			pid: process.pid,
			projectRoot,
			startedAt,
			heartbeatAt: now,
		},
		policy,
		writtenAt: now,
	}, null, 2);
	const tmp = path.join(paths.root, `policy.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fs.writeFileSync(tmp, batch, "utf-8");
		fs.closeSync(fs.openSync(tmp, "r+"));
		fs.renameSync(tmp, paths.session);
		writeJsonFast(paths.policy, { schemaVersion: 1, projectRoot, bridgeSessionId, pid: process.pid, writtenAt: now, expiresAt: new Date(Date.now() + POLICY_TTL_MS).toISOString(), policy });
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
	return { active: true };
}

function refreshSessionLock(paths: BridgePaths, projectRoot: string, piSessionId: string | null): boolean {
	const existing = readJson(paths.session);
	const stale = isStaleLock(existing);
	if (stale.stale) {
		passiveReason = stale.reason;
		return false;
	}
	const now = new Date().toISOString();
	const policy = getWorkflowPolicySnapshot();
	const batch = JSON.stringify({
		lock: {
			schemaVersion: 1,
			status: "active",
			bridgeSessionId,
			piSessionId,
			pid: process.pid,
			projectRoot,
			startedAt,
			heartbeatAt: now,
		},
		policy,
		writtenAt: now,
	}, null, 2);
	const tmp = path.join(paths.root, `policy.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fs.writeFileSync(tmp, batch, "utf-8");
		fs.closeSync(fs.openSync(tmp, "r+"));
		fs.renameSync(tmp, paths.session);
		writeJsonFast(paths.policy, { schemaVersion: 1, projectRoot, bridgeSessionId, pid: process.pid, writtenAt: now, expiresAt: new Date(Date.now() + POLICY_TTL_MS).toISOString(), policy });
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
		try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
	return true;
}

function cleanupAllBridgeFiles(paths: BridgePaths): void {
	const existing = readJson(paths.session);
	if (existing && typeof existing === "object" && (existing as { bridgeSessionId?: unknown }).bridgeSessionId !== bridgeSessionId) {
		return; // Not ours — leave it alone.
	}
	for (const dir of [paths.requests, paths.responses, paths.processed]) {
		try {
			for (const fileName of fs.readdirSync(dir)) {
				if (fileName.endsWith(".json")) {
					try { fs.unlinkSync(path.join(dir, fileName)); } catch { /* ignore */ }
				}
			}
		} catch { /* dir missing or empty */ }
	}
	try { fs.unlinkSync(paths.session); } catch { /* ignore */ }
	try { fs.unlinkSync(paths.policy); } catch { /* ignore */ }
}

function writePolicy(paths: BridgePaths, projectRoot: string): void {
	const now = Date.now();
	writeJsonAtomic(paths.policy, {
		schemaVersion: 1,
		projectRoot,
		bridgeSessionId,
		pid: process.pid,
		writtenAt: toIso(now),
		expiresAt: toIso(now + POLICY_TTL_MS),
		policy: getWorkflowPolicySnapshot(),
	});
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
	return {
		id: record.id,
		type: record.type,
		payload: record.payload as Record<string, unknown>,
		ts: record.ts,
	};
}

function existsSync(filePath: string): boolean {
	try { fs.accessSync(filePath); return true; } catch { return false; }
}

function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(dir, ".pi"))) return dir;
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

function promptContextForMode(mode: RecallPayload["mode"]): Record<string, unknown> {
	return {
		mode: mode ?? "plan",
		discussPrompt: DISCUSS_PROMPT,
		planPrompt: PLAN_PROMPT,
		buildPrompt: BUILD_PROMPT,
		planTemplatePath: PLAN_TEMPLATE_PATH,
		planTemplate: readTextIfExists(PLAN_TEMPLATE_PATH),
	};
}

function normalizeRecallPayload(payload: Record<string, unknown>): RecallPayload {
	const query = typeof payload.query === "string" ? payload.query : "";
	const mode = payload.mode === "discuss" || payload.mode === "plan" || payload.mode === "build" ? payload.mode : "plan";
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

async function handleSavePlan(pi: ExtensionAPI, _ctx: ExtensionContext, request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeSavePlanPayload(request.payload);
		const result = await requestWorkflowSavePlan(pi, request.id, payload);
		if (result.ok !== true) {
			return errorResponse(request.id, "save_plan_failed", typeof result.error === "string" ? result.error : "workflow-modes save-plan failed.");
		}
		const planId = typeof result.planId === "string" ? result.planId : payload.planId ?? request.id;
		const savedAt = typeof result.savedAt === "string" ? result.savedAt : new Date().toISOString();
		latestSavedPlan = { planId, planText: payload.planText, savedAt };
		return {
			id: request.id,
			ok: true,
			result: {
				requestId: request.id,
				planId,
				savedAt,
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

async function handleRecall(pi: ExtensionAPI, request: BridgeRequest): Promise<BridgeResponse> {
	const payload = normalizeRecallPayload(request.payload);
	const cwd = activeProjectRoot ?? process.cwd();
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot) {
		return errorResponse(request.id, "not_pi_project", "Pi bridge recall requires an existing Pi project with a .pi directory.");
	}

	const memoryDir = await resolveMemoryDir();
	await migrateFlatFile(memoryDir);
	const personalIndex = await readMemoryIndex(memoryDir);
	const personalBlock = formatMemoryIndexBlock(personalIndex) ?? "";
	const memoryBlocks = personalBlock ? [personalBlock] : [];
	const workflowState = await requestWorkflowState(pi);
	const workflowPlan = typeof workflowState?.plan === "string" ? workflowState.plan : undefined;
	const savedPlan = workflowPlan
		? {
			planId: latestSavedPlan?.planText === workflowPlan ? latestSavedPlan.planId : null,
			planText: workflowPlan,
			savedAt: latestSavedPlan?.planText === workflowPlan ? latestSavedPlan.savedAt : null,
		}
		: latestSavedPlan;
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
			prompts: promptContextForMode(payload.mode),
			savedPlan,
		},
	};
}

async function handleRecallEntry(request: BridgeRequest): Promise<BridgeResponse> {
	try {
		const payload = normalizeRecallEntryPayload(request.payload);
		const memoryDir = await resolveMemoryDir();
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
		const memoryDir = await resolveMemoryDir();
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
	return errorResponse(request.id, "not_implemented", `Bridge handler not implemented for request type: ${request.type}.`);
}

function writeResponse(paths: BridgePaths, response: BridgeResponse): void {
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
	if (!fileName.endsWith(".json")) return;
	const fileId = fileName.slice(0, -".json".length);
	if (!UUID_RE.test(fileId)) return;
	if (replayProcessedResponse(paths, fileId)) return;

	const absolute = requestPath(paths, fileName);
	const resolved = path.resolve(absolute);
	const requestRoot = path.resolve(paths.requests) + path.sep;
	if (!resolved.startsWith(requestRoot)) {
		writeResponse(paths, errorResponse(fileId, "path_traversal", "Request path escaped bridge requests directory."));
		return;
	}

	let response: BridgeResponse;
	try {
		const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
		const request = validateRequest(fileId, raw);
		response = await handleRequest(pi, ctx, request);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		response = errorResponse(fileId, "invalid_request", message);
	}
	writeResponse(paths, response);
	// Unlink request file so subsequent scans are O(in-flight), not O(history).
	safeUnlink(requestPath(paths, fileName));
}

async function scanRequests(pi: ExtensionAPI, ctx: ExtensionContext, paths: BridgePaths): Promise<void> {
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
	// No backup poll — fs.watch is sufficient on modern macOS/Node with O(1) in-flight requests.
}

function stopActiveBridge(reason?: string): void {
	watcher?.close();
	watcher = null;
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
	if (activePaths) {
		const paths = activePaths;
		if (reason) {
			// Graceful stop: write inactive marker so MCP clients can detect us stopping.
			writeJsonFast(paths.session, {
				schemaVersion: 1,
				status: "inactive",
				bridgeSessionId,
				stoppedAt: new Date().toISOString(),
				reason: reason ?? "shutdown",
			});
		}
		cleanupAllBridgeFiles(paths);
	}
	activePaths = null;
	activeProjectRoot = null;
}

export default function claudeBridge(pi: ExtensionAPI) {
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
		stopActiveBridge();
		passiveReason = null;
		const projectRoot = findProjectRoot(ctx.cwd ?? process.cwd());
		if (!projectRoot) {
			ctx.ui.setStatus(EXTENSION_ID, undefined);
			return;
		}

		const paths = bridgePaths(projectRoot);
		ensureBridgeDirs(paths);
		const piSessionId = sessionIdFromContext(ctx);
		const claim = claimSessionLock(paths, projectRoot, piSessionId);
		if (claim.active === false) {
			passiveReason = claim.reason;
			ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: passive");
			ctx.ui.notify(`claude-bridge passive: ${claim.reason}`, "warning");
			return;
		}

		activePaths = paths;
		activeProjectRoot = projectRoot;
		writePolicy(paths, projectRoot);
		startWatcher(pi, paths, ctx);
		heartbeatTimer = setInterval(() => {
			if (!activePaths || !activeProjectRoot) return;
			if (!refreshSessionLock(activePaths, activeProjectRoot, piSessionId)) {
				watcher?.close();
				watcher = null;
				ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: passive");
				ctx.ui.notify(`claude-bridge passive: ${passiveReason}`, "warning");
				return;
			}
		}, HEARTBEAT_MS);
		heartbeatTimer.unref?.();
		ctx.ui.setStatus(EXTENSION_ID, "Claude bridge: active");
		ctx.ui.notify(`claude-bridge active: ${paths.root}`, "info");
	});

	pi.on("session_shutdown", async () => {
		stopActiveBridge("session_shutdown");
	});

	pi.registerCommand("claude-bridge", {
		description: "Show Claude Code bridge status",
		handler: async (_args, ctx) => {
			if (activePaths && activeProjectRoot) {
				ctx.ui.notify(`Claude bridge active\nRoot: ${activePaths.root}\nSession: ${bridgeSessionId}`, "info");
				return;
			}
			ctx.ui.notify(`Claude bridge passive/off${passiveReason ? `\n${passiveReason}` : ""}`, passiveReason ? "warning" : "info");
		},
	});
}
