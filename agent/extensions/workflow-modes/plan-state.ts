export interface SavedPlanState {
	plan: string;
	planId: string;
	savedAt: string;
}

interface BranchEntry {
	type?: unknown;
	customType?: unknown;
	id?: unknown;
	timestamp?: unknown;
	data?: unknown;
}

export function resolveSavedPlanState(entries: readonly BranchEntry[], customType = "workflow-plan"): SavedPlanState | undefined {
	let current: SavedPlanState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as { event?: unknown; plan?: unknown; planId?: unknown; savedAt?: unknown; at?: unknown } | undefined;
		if (data?.event === "clear") {
			current = undefined;
			continue;
		}
		if (data?.event !== "set" || typeof data.plan !== "string" || data.plan.trim().length === 0) continue;

		const planId = nonEmptyText(data.planId) ?? nonEmptyText(entry.id);
		const savedAt = validDate(data.savedAt) ?? validDate(data.at) ?? validDate(entry.timestamp);
		if (planId && savedAt) current = { plan: data.plan, planId, savedAt };
	}
	return current;
}

function nonEmptyText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validDate(value: unknown): string | undefined {
	const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}
