export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TOTAL_MS = 1_200_000;
const MIN_IDLE_TIMEOUT_MS = 5_000;
const MAX_IDLE_TIMEOUT_MS = 1_800_000;
const MIN_MAX_TOTAL_MS = 60_000;
const MAX_MAX_TOTAL_MS = 7_200_000;

export interface SubagentTimeoutPolicy {
	idleTimeoutMs: number;
	maxTotalMs: number;
}

export interface SubagentTimeoutSettings {
	idleTimeoutMs?: unknown;
	maxTotalMs?: unknown;
}

function isTimeoutInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function resolveSubagentTimeoutPolicy(settings: SubagentTimeoutSettings | undefined): SubagentTimeoutPolicy {
	const idleTimeoutMs = settings?.idleTimeoutMs;
	const maxTotalMs = settings?.maxTotalMs;
	if (
		!isTimeoutInRange(idleTimeoutMs, MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS) ||
		!isTimeoutInRange(maxTotalMs, MIN_MAX_TOTAL_MS, MAX_MAX_TOTAL_MS) ||
		maxTotalMs < idleTimeoutMs
	) {
		return { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, maxTotalMs: DEFAULT_MAX_TOTAL_MS };
	}
	return { idleTimeoutMs, maxTotalMs };
}
