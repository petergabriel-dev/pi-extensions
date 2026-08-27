export type SubagentTimeoutKind = "idle" | "max_total";

export interface SubagentWatchdogClock {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now?: () => number;
}

export interface SubagentWatchdogOptions {
	idleMs: number;
	maxTotalMs: number;
	onFire: (kind: SubagentTimeoutKind) => void;
	clock?: SubagentWatchdogClock;
}

export interface SubagentWatchdog {
	touch(): void;
	setWaiting(waiting: boolean): void;
	cancel(): void;
	readonly firedKind: SubagentTimeoutKind | undefined;
	readonly waiting: boolean;
}

function defaultClock(): SubagentWatchdogClock {
	return {
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		now: () => Date.now(),
	};
}

export function createSubagentWatchdog(options: SubagentWatchdogOptions): SubagentWatchdog {
	const clock = options.clock ?? defaultClock();
	let idleHandle: unknown | undefined;
	let maxTotalHandle: unknown | undefined;
	let firedKind: SubagentTimeoutKind | undefined;
	let cancelled = false;
	let waiting = false;
	let activeElapsedMs = 0;
	let activeStartedAt = clock.now ? clock.now() : Date.now();

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

	const now = () => clock.now ? clock.now() : Date.now();
	const activeElapsed = () => activeElapsedMs + (waiting ? 0 : Math.max(0, now() - activeStartedAt));

	const fire = (kind: SubagentTimeoutKind) => {
		if (cancelled || firedKind) return;
		firedKind = kind;
		clearAll();
		options.onFire(kind);
	};

	const armIdle = () => {
		clearIdle();
		if (cancelled || firedKind || waiting) return;
		idleHandle = clock.setTimeout(() => fire("idle"), options.idleMs);
	};

	const armMaxTotal = () => {
		clearMaxTotal();
		if (cancelled || firedKind || waiting) return;
		const remaining = options.maxTotalMs - activeElapsed();
		if (remaining <= 0) return fire("max_total");
		activeStartedAt = now();
		maxTotalHandle = clock.setTimeout(() => fire("max_total"), remaining);
	};

	armMaxTotal();
	armIdle();

	return {
		touch() {
			if (!waiting) armIdle();
		},
		setWaiting(nextWaiting) {
			if (cancelled || firedKind || waiting === nextWaiting) return;
			if (nextWaiting) {
				activeElapsedMs = activeElapsed();
				waiting = true;
				clearAll();
				return;
			}
			waiting = false;
			activeStartedAt = now();
			armMaxTotal();
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
		get waiting() {
			return waiting;
		},
	};
}
