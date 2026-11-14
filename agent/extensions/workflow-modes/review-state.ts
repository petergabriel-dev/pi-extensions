import { resolveCommit, runGit } from "./git.js";
import { BUNDLE_ID, readEvidenceBundle, type EvidenceBundle } from "./review-bundle.js";
import type { ReviewEvent } from "./review-store.js";
import { parseFindingIds, type PlanTask } from "./plan-tasks.js";
import type { PlanTaskTick } from "./plan-state.js";

// Review findings and per-task review state. Validation runs at the trust boundary;
// state is derived from the review log, ticks, and plans, never stored.

export const MAX_FINDING_TEXT = 2000;
export const MAX_FINDING_REFS = 10;
export const MAX_FINDINGS_PER_SUBMIT = 20;
const MAX_PATH = 512;
const MAX_LINE = 10_000_000;
const MAX_VERIFY_FILE_BYTES = 4 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUNDLE_REF = /^([0-9a-f]{64})#(commands|hunks|files|subagents|warnings)\/(\d{1,4})$/;
const CODE_REF = /^([0-9a-fA-F]{7,64}):(.+):(\d{1,8})$/;
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = typeof SEVERITIES[number];

export interface FindingInput {
	planId: string;
	taskId: string;
	commit: string;
	file?: string;
	line?: number;
	severity: Severity;
	text: string;
	fix?: string;
	repro?: string;
	evidenceRefs: string[];
}

export type FindingStatus = "open" | "approved" | "rejected" | "resolved";

export interface FindingState extends FindingInput {
	id: string;
	by?: string;
	status: FindingStatus;
	classification: "suspected" | "verified";
	resolvedBy?: string;
	resolvedCommit?: string;
}

export type TaskReviewState = "not_ready" | "ready" | "in_review" | "changes_requested" | "rework_in_progress" | "re_review_required" | "approved";

function boundedText(value: unknown, label: string, required: boolean): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`finding ${label} must be a non-empty string`);
	if (value.length > MAX_FINDING_TEXT) throw new Error(`finding ${label} exceeds ${MAX_FINDING_TEXT} characters`);
	return value.trim();
}

export function isSafeRepoPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && !value.includes("\0") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}

// Schema and caps only (pure). References are checked by validateFindingReferences.
export function validateFindingInput(raw: unknown): FindingInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("finding must be an object");
	const value = raw as Record<string, unknown>;
	const allowed = new Set(["planId", "taskId", "commit", "file", "line", "severity", "text", "fix", "repro", "evidenceRefs"]);
	const extra = Object.keys(value).filter((key) => !allowed.has(key));
	if (extra.length > 0) throw new Error(`finding has unsupported field(s): ${extra.slice(0, 5).join(", ")}`);
	if (typeof value.planId !== "string" || !SAFE_SEGMENT.test(value.planId)) throw new Error("finding planId must be a path-safe identifier");
	if (typeof value.taskId !== "string" || !SAFE_ID.test(value.taskId)) throw new Error("finding taskId must be a safe identifier");
	if (typeof value.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(value.commit)) throw new Error("finding commit must be a 7-64 character hexadecimal SHA");
	if (value.file !== undefined && !isSafeRepoPath(value.file)) throw new Error("finding file must be a relative repository path without ..");
	if (value.line !== undefined && (typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 1 || value.line > MAX_LINE)) throw new Error("finding line must be a positive integer");
	if (value.line !== undefined && value.file === undefined) throw new Error("finding line requires file");
	if (!SEVERITIES.includes(value.severity as Severity)) throw new Error("finding severity must be high, medium, or low");
	const refs = value.evidenceRefs === undefined ? [] : value.evidenceRefs;
	if (!Array.isArray(refs) || refs.length > MAX_FINDING_REFS || refs.some((ref) => typeof ref !== "string" || ref.length > MAX_PATH + 80)) throw new Error(`finding evidenceRefs must be at most ${MAX_FINDING_REFS} strings`);
	const text = boundedText(value.text, "text", true)!;
	const fix = boundedText(value.fix, "fix", false);
	const repro = boundedText(value.repro, "repro", false);
	return {
		planId: value.planId,
		taskId: value.taskId,
		commit: value.commit.toLowerCase(),
		...(value.file !== undefined ? { file: value.file as string } : {}),
		...(value.line !== undefined ? { line: value.line as number } : {}),
		severity: value.severity as Severity,
		text,
		...(fix ? { fix } : {}),
		...(repro ? { repro } : {}),
		evidenceRefs: [...new Set(refs as string[])],
	};
}

// Per-submit memo so each distinct commit, file, line count, and bundle is resolved
// once however many findings or references repeat it. Values are promises, so
// concurrent lookups share one git call.
export interface ReferenceCache {
	commits: Map<string, Promise<string>>;
	files: Map<string, Promise<boolean>>;
	lineCounts: Map<string, Promise<number | undefined>>;
	bundles: Map<string, Promise<EvidenceBundle | undefined>>;
}

export function createReferenceCache(): ReferenceCache {
	return { commits: new Map(), files: new Map(), lineCounts: new Map(), bundles: new Map() };
}

function memo<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
	let value = map.get(key);
	if (!value) {
		value = load();
		map.set(key, value);
	}
	return value;
}

// Reads a file at a commit up to MAX_VERIFY_FILE_BYTES; undefined when it cannot be read.
export async function readFileAtCommit(cwd: string, commit: string, file: string): Promise<string | undefined> {
	const blob = await runGit(cwd, ["cat-file", "blob", `${commit}:${file}`], MAX_VERIFY_FILE_BYTES);
	return blob.ok ? blob.stdout : undefined;
}

async function verifyCodeLocation(cwd: string, commit: string, file: string, line: number | undefined, cache: ReferenceCache): Promise<void> {
	const object = `${commit}:${file}`;
	const exists = await memo(cache.files, object, async () => (await runGit(cwd, ["cat-file", "-e", object])).ok);
	if (!exists) throw new Error(`file ${file} does not exist at commit ${commit.slice(0, 12)}`);
	if (line === undefined) return;
	const lines = await memo(cache.lineCounts, object, async () => {
		const text = await readFileAtCommit(cwd, commit, file);
		if (text === undefined) return undefined;
		return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	});
	if (lines === undefined) throw new Error(`file ${file} at ${commit.slice(0, 12)} cannot be read to verify line ${line}`);
	if (line > lines) throw new Error(`line ${line} is beyond the end of ${file} (${lines} lines) at ${commit.slice(0, 12)}`);
}

// Resolves the commit to its full SHA and checks every reference. Bundle references
// must point at an existing record of a bundle for the same plan task.
export async function validateFindingReferences(finding: FindingInput, context: { cwd: string; agentDir: string; sessionId: string }, cache: ReferenceCache = createReferenceCache()): Promise<FindingInput> {
	const resolve = (sha: string) => memo(cache.commits, sha.toLowerCase(), () => resolveCommit(context.cwd, sha));
	const commit = await resolve(finding.commit);
	if (finding.file !== undefined) await verifyCodeLocation(context.cwd, commit, finding.file, finding.line, cache);
	for (const ref of finding.evidenceRefs) {
		const bundleRef = BUNDLE_REF.exec(ref);
		if (bundleRef) {
			const bundle = await memo(cache.bundles, bundleRef[1], () => readEvidenceBundle(context.agentDir, context.sessionId, bundleRef[1]));
			if (!bundle) throw new Error(`evidence bundle ${bundleRef[1].slice(0, 12)} does not exist`);
			if (bundle.planId !== finding.planId || bundle.taskId !== finding.taskId) throw new Error(`evidence bundle ${bundleRef[1].slice(0, 12)} belongs to a different task`);
			const records = (bundle as unknown as Record<string, unknown>)[bundleRef[2]];
			if (!Array.isArray(records) || Number(bundleRef[3]) >= records.length) throw new Error(`evidence record ${bundleRef[2]}/${bundleRef[3]} does not exist in bundle ${bundleRef[1].slice(0, 12)}`);
			continue;
		}
		const codeRef = CODE_REF.exec(ref);
		if (codeRef && isSafeRepoPath(codeRef[2])) {
			const refCommit = await resolve(codeRef[1]);
			await verifyCodeLocation(context.cwd, refCommit, codeRef[2], Number(codeRef[3]), cache);
			continue;
		}
		throw new Error(`evidence reference ${JSON.stringify(ref.slice(0, 80))} must be <bundleId>#<section>/<index> or <commit>:<path>:<line>`);
	}
	return { ...finding, commit };
}

// Folds the review log into finding states. Only valid transitions apply:
// open -> approved | rejected, approved -> resolved.
export function foldFindings(events: readonly ReviewEvent[]): Map<string, FindingState> {
	const findings = new Map<string, FindingState>();
	for (const event of events) {
		if (event.ev === "finding_submitted" && typeof event.id === "string" && !findings.has(event.id)) {
			try {
				const { id: _id, at: _at, ev: _ev, by, ...fields } = event;
				const input = validateFindingInput(fields);
				findings.set(event.id, { ...input, id: event.id, ...(typeof by === "string" ? { by } : {}), status: "open", classification: "suspected" });
			} catch { /* a malformed stored finding is ignored, never trusted */ }
			continue;
		}
		const finding = typeof event.id === "string" ? findings.get(event.id) : undefined;
		if (!finding) continue;
		if (event.ev === "finding_approved" && finding.status === "open") {
			finding.status = "approved";
			finding.classification = event.classification === "verified" && finding.evidenceRefs.length > 0 ? "verified" : "suspected";
		} else if (event.ev === "finding_rejected" && finding.status === "open") {
			finding.status = "rejected";
		} else if (event.ev === "finding_resolved" && finding.status === "approved") {
			finding.status = "resolved";
			if (typeof event.by === "string") finding.resolvedBy = event.by;
			if (typeof event.commit === "string") finding.resolvedCommit = event.commit;
		}
	}
	return findings;
}

export function isUnresolved(finding: FindingState): boolean {
	return finding.status === "open" || finding.status === "approved";
}

// Bundles that cleanup must keep: cited by a finding that is still open or approved.
export function citedBundleIds(findings: Iterable<FindingState>): Set<string> {
	const cited = new Set<string>();
	for (const finding of findings) {
		if (!isUnresolved(finding)) continue;
		for (const ref of finding.evidenceRefs) {
			const id = ref.split("#")[0];
			if (BUNDLE_ID.test(id)) cited.add(id);
		}
	}
	return cited;
}

export interface PlanTaskView {
	id: string;
	ticked: boolean;
	findings: readonly string[];
}

export interface ReviewStateInput {
	planId: string;
	taskId: string;
	ticked: boolean;
	events: readonly ReviewEvent[];
	plans: ReadonlyArray<{ planId: string; tasks: readonly PlanTaskView[] }>;
}

export interface TaskReviewSummary {
	state: TaskReviewState;
	rounds: number;
	reworkPlans: string[];
	findings: string[];
	bundleId?: string;
}

// Pure: ready -> in_review -> changes_requested -> rework_in_progress ->
// re_review_required -> approved. Rounds = distinct rework plans citing this task's findings.
export function deriveTaskReviewState(input: ReviewStateInput): TaskReviewSummary {
	const forTask = (event: ReviewEvent) => event.planId === input.planId && event.taskId === input.taskId;
	const findings = [...foldFindings(input.events).values()].filter((finding) => finding.planId === input.planId && finding.taskId === input.taskId);
	const findingIds = new Set(findings.map((finding) => finding.id));
	let bundleId: string | undefined;
	let reviewStarted = false;
	let lastFindingIndex = -1;
	let approvedIndex = -1;
	input.events.forEach((event, index) => {
		if (event.ev === "bundle_created" && forTask(event) && typeof event.bundleId === "string") bundleId = event.bundleId;
		if (event.ev === "review_started" && forTask(event)) reviewStarted = true;
		if (typeof event.id === "string" && findingIds.has(event.id)) lastFindingIndex = index;
		if (event.ev === "task_approved" && forTask(event)) approvedIndex = index;
	});
	const reworkPlans = new Set<string>();
	const citing: PlanTaskView[] = [];
	for (const plan of input.plans) {
		for (const task of plan.tasks) {
			if (!task.findings.some((id) => findingIds.has(id))) continue;
			reworkPlans.add(plan.planId);
			citing.push(task);
		}
	}
	const summary = (state: TaskReviewState): TaskReviewSummary => ({ state, rounds: reworkPlans.size, reworkPlans: [...reworkPlans], findings: findings.map((finding) => finding.id), ...(bundleId ? { bundleId } : {}) });
	if (!input.ticked) return summary("not_ready");
	const unresolved = findings.filter(isUnresolved);
	const approvedOpen = unresolved.filter((finding) => finding.status === "approved");
	if (unresolved.length === 0 && approvedIndex > lastFindingIndex && approvedIndex >= 0) return summary("approved");
	if (approvedOpen.length > 0) {
		const reworkFor = citing.filter((task) => task.findings.some((id) => approvedOpen.some((finding) => finding.id === id)));
		if (reworkFor.length > 0 && reworkFor.every((task) => task.ticked)) return summary("re_review_required");
		if (reworkFor.length > 0) return summary("rework_in_progress");
		return summary("changes_requested");
	}
	if (findings.length > 0 || reviewStarted) return summary("in_review");
	return summary("ready");
}

export const MAX_REVIEW_OVERVIEW_BYTES = 16 * 1024;
const MAX_OVERVIEW_TASKS = 50;
const MAX_OVERVIEW_FINDINGS = 30;

export interface OverviewPlan {
	planId: string;
	active: boolean;
	tasks: readonly PlanTask[];
	completedTaskIds: readonly string[];
	ticks: ReadonlyMap<string, PlanTaskTick>;
}

export interface ReviewOverview {
	tasks: Array<{ planId: string; taskId: string; title: string; state: TaskReviewState; rounds: number; findings: string[]; bundleId?: string; commit?: string; by?: string; note?: string }>;
	findings: Array<{ id: string; planId: string; taskId: string; status: FindingStatus; classification: string; severity: Severity; file?: string; line?: number; text: string; by?: string }>;
	omitted: { tasks: number; findings: number };
	warnings: string[];
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Pure and bounded: ticked tasks (active plan first) with derived review state, plus
// unresolved findings, trimmed to MAX_REVIEW_OVERVIEW_BYTES.
export function buildReviewOverview(plans: readonly OverviewPlan[], events: readonly ReviewEvent[], warnings: readonly string[] = []): ReviewOverview {
	const planViews = plans.map((plan) => ({
		planId: plan.planId,
		tasks: plan.tasks.map((task) => ({ id: task.id, ticked: plan.completedTaskIds.includes(task.id), findings: parseFindingIds(task.metadata.findings) })),
	}));
	const ordered = [...plans].sort((a, b) => Number(b.active) - Number(a.active));
	const tasks: ReviewOverview["tasks"] = [];
	let omittedTasks = 0;
	for (const plan of ordered) {
		for (const task of plan.tasks) {
			if (!plan.completedTaskIds.includes(task.id)) continue;
			if (tasks.length >= MAX_OVERVIEW_TASKS) {
				omittedTasks += 1;
				continue;
			}
			const summary = deriveTaskReviewState({ planId: plan.planId, taskId: task.id, ticked: true, events, plans: planViews });
			const tick = plan.ticks.get(task.id);
			tasks.push({
				planId: plan.planId,
				taskId: task.id,
				title: clip(task.title, 200),
				state: summary.state,
				rounds: summary.rounds,
				findings: summary.findings,
				...(summary.bundleId ? { bundleId: summary.bundleId } : {}),
				...(tick?.commit ? { commit: tick.commit } : {}),
				...(tick?.by ? { by: tick.by } : {}),
				...(tick?.note ? { note: clip(tick.note, 200) } : {}),
			});
		}
	}
	const unresolved = [...foldFindings(events).values()].filter(isUnresolved);
	const findings: ReviewOverview["findings"] = unresolved.slice(0, MAX_OVERVIEW_FINDINGS).map((finding) => ({
		id: finding.id,
		planId: finding.planId,
		taskId: finding.taskId,
		status: finding.status,
		classification: finding.classification,
		severity: finding.severity,
		...(finding.file ? { file: finding.file } : {}),
		...(finding.line ? { line: finding.line } : {}),
		text: clip(finding.text, 300),
		...(finding.by ? { by: finding.by } : {}),
	}));
	const overview: ReviewOverview = { tasks, findings, omitted: { tasks: omittedTasks, findings: unresolved.length - findings.length }, warnings: warnings.slice(0, 5).map((warning) => clip(warning, 200)) };
	while (Buffer.byteLength(JSON.stringify(overview), "utf8") > MAX_REVIEW_OVERVIEW_BYTES) {
		if (overview.findings.length > 0) { overview.findings.pop(); overview.omitted.findings += 1; continue; }
		if (overview.tasks.length > 0) { overview.tasks.pop(); overview.omitted.tasks += 1; continue; }
		overview.warnings = [];
		break;
	}
	return overview;
}
