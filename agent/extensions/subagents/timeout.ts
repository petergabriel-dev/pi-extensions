export type SubagentTimeoutKind = "idle" | "max_total";

export interface SubagentWatchdogClock {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface SubagentWatchdogOptions {
	idleMs: number;
	maxTotalMs: number;
	onFire: (kind: SubagentTimeoutKind) => void;
	clock?: SubagentWatchdogClock;
}

export interface SubagentWatchdog {
	touch(): void;
	cancel(): void;
	readonly firedKind: SubagentTimeoutKind | undefined;
}

function defaultClock(): SubagentWatchdogClock {
	return {
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	};
}

export function createSubagentWatchdog(options: SubagentWatchdogOptions): SubagentWatchdog {
	const clock = options.clock ?? defaultClock();
	let idleHandle: unknown | undefined;
	let maxTotalHandle: unknown | undefined;
	let firedKind: SubagentTimeoutKind | undefined;
	let cancelled = false;

	const clearIdle = () => {
		if (idleHandle !== undefined) {
			clock.clearTimeout(idleHandle);
			idleHandle = undefined;
		}
	};

	const clearMaxTotal = () => {
		if (maxTotalHandle !== undefined) {
			clock.clearTimeout(maxTotalHandle);
			maxTotalHandle = undefined;
		}
	};

	const clearAll = () => {
		clearIdle();
		clearMaxTotal();
	};

	const fire = (kind: SubagentTimeoutKind) => {
		if (cancelled || firedKind) return;
		firedKind = kind;
		clearAll();
		options.onFire(kind);
	};

	const armIdle = () => {
		clearIdle();
		if (cancelled || firedKind) return;
		idleHandle = clock.setTimeout(() => fire("idle"), options.idleMs);
	};

	maxTotalHandle = clock.setTimeout(() => fire("max_total"), options.maxTotalMs);
	armIdle();

	return {
		touch() {
			armIdle();
		},
		cancel() {
			if (cancelled) return;
			cancelled = true;
			clearAll();
		},
		get firedKind() {
			return firedKind;
		},
	};
}
