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
}

interface VersionedPlan extends SavedPlan {
	generation: number;
}

interface PlanVersion {
	planId: string;
	generation: number;
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
