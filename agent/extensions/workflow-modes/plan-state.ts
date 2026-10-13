import { MAX_PLAN_TASKS, type PlanTask } from "./plan-tasks.js";

export interface SavedPlan {
	planId: string;
	path: string;
	savedAt: string;
}

export interface SavedPlanState {
	plans: SavedPlan[];
	activePlanId: string | undefined;

	// Transitional fields for callers replaced by file-backed prompt composition in later tasks.
	plan?: string;
	planId?: string;
	savedAt?: string;
}

interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	timestamp?: unknown;
	data?: unknown;
}

interface PlanEventData {
	event?: unknown;
	planId?: unknown;
	path?: unknown;
	savedAt?: unknown;
	tasks?: unknown;
	taskId?: unknown;
}

interface VersionedPlan extends SavedPlan {
	generation: number;
}

interface PlanVersion {
	planId: string;
	generation: number;
}

export interface SavedPlanTaskState {
	tasks: PlanTask[];
	completedTaskIds: string[];
	progress: { done: number; total: number };
	nextTask?: { id: string; title: string };
	seeded: boolean;
}

export function resolveSavedPlanTaskState(entries: readonly BranchEntry[], planId: string, fallbackTasks: readonly PlanTask[] = [], customType = "workflow-plan"): SavedPlanTaskState {
	let tasks: PlanTask[] | undefined;
	let cleared = false;
	const completed = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = asPlanEventData(entry.data);
		if (!data || data.planId !== planId) continue;
		if (data.event === "set") {
			const seed = parseTasks(data.tasks);
			if (seed === undefined) continue;
			tasks = seed;
			cleared = false;
			completed.clear();
			continue;
		}
		if (data.event === "clear") {
			tasks = undefined;
			cleared = true;
			completed.clear();
			continue;
		}
		if (data.event !== "tick" || !tasks) continue;
		const taskId = nonEmptyText(data.taskId);
		if (taskId && tasks.some((task) => task.id === taskId)) completed.add(taskId);
	}

	const seeded = tasks !== undefined;
	const resolvedTasks = tasks ?? (cleared ? [] : [...fallbackTasks]);
	const completedTaskIds = resolvedTasks.filter((task) => completed.has(task.id)).map((task) => task.id);
	const nextTask = resolvedTasks.find((task) => !completed.has(task.id));
	return {
		tasks: resolvedTasks,
		completedTaskIds,
		progress: { done: completedTaskIds.length, total: resolvedTasks.length },
		...(nextTask ? { nextTask: { id: nextTask.id, title: nextTask.title } } : {}),
		seeded,
	};
}

export function resolveSavedPlanState(entries: readonly BranchEntry[], customType = "workflow-plan"): SavedPlanState {
	const plans = new Map<string, VersionedPlan>();
	const generationCounters = new Map<string, number>();
	const setHistory: PlanVersion[] = [];
	const activateHistory: PlanVersion[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = asPlanEventData(entry.data);
		if (!data) continue;

		if (data.event === "set") {
			const plan = parsePlan(data);
			if (!plan) continue;
			const generation = (generationCounters.get(plan.planId) ?? 0) + 1;
			generationCounters.set(plan.planId, generation);
			plans.set(plan.planId, { ...plan, generation });
			setHistory.push({ planId: plan.planId, generation });
			continue;
		}

		const planId = nonEmptyText(data.planId);
		if (!planId) continue;
		if (data.event === "activate") {
			const plan = plans.get(planId);
			if (plan) activateHistory.push({ planId, generation: plan.generation });
			continue;
		}
		if (data.event === "clear") plans.delete(planId);
	}

	const activePlanId = lastCurrentPlan(activateHistory, plans) ?? lastCurrentPlan(setHistory, plans);
	return {
		plans: Array.from(plans.values(), ({ generation: _generation, ...plan }) => plan),
		activePlanId,
	};
}

function parseTasks(value: unknown): PlanTask[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.slice(0, MAX_PLAN_TASKS)
		.filter((task): task is PlanTask => {
			if (!task || typeof task !== "object") return false;
			const candidate = task as { id?: unknown; title?: unknown; metadata?: unknown };
			return typeof candidate.id === "string" && candidate.id.trim().length > 0
				&& typeof candidate.title === "string" && candidate.title.trim().length > 0
				&& !!candidate.metadata && typeof candidate.metadata === "object";
		});
}

function asPlanEventData(value: unknown): PlanEventData | undefined {
	return value && typeof value === "object" ? value as PlanEventData : undefined;
}

function parsePlan(data: PlanEventData): SavedPlan | undefined {
	const planId = nonEmptyText(data.planId);
	const filePath = nonEmptyText(data.path);
	const savedAt = validDate(data.savedAt);
	if (!planId || !filePath || !savedAt) return undefined;
	return { planId, path: filePath, savedAt };
}

function lastCurrentPlan(history: readonly PlanVersion[], plans: ReadonlyMap<string, VersionedPlan>): string | undefined {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const candidate = history[index];
		if (plans.get(candidate.planId)?.generation === candidate.generation) return candidate.planId;
	}
	return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validDate(value: unknown): string | undefined {
	const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}
