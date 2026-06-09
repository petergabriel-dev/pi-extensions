import assert from "node:assert/strict";

import { createSubagentWatchdog, type SubagentTimeoutKind, type SubagentWatchdogClock } from "../timeout.ts";

class FakeClock implements SubagentWatchdogClock {
	private nowMs = 0;
	private nextId = 1;
	private timers = new Map<number, { due: number; callback: () => void }>();

	setTimeout(callback: () => void, ms: number): number {
		const id = this.nextId++;
		this.timers.set(id, { due: this.nowMs + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		const target = this.nowMs + ms;
		while (true) {
			let nextId: number | undefined;
			let nextDue = Number.POSITIVE_INFINITY;
			for (const [id, timer] of this.timers) {
				if (timer.due <= target && timer.due < nextDue) {
					nextDue = timer.due;
					nextId = id;
				}
			}
			if (nextId === undefined) break;
			const timer = this.timers.get(nextId);
			if (!timer) continue;
			this.nowMs = timer.due;
			this.timers.delete(nextId);
			timer.callback();
		}
		this.nowMs = target;
	}
}

function makeWatchdog(idleMs = 100, maxTotalMs = 1_000) {
	const clock = new FakeClock();
	const fired: SubagentTimeoutKind[] = [];
	const watchdog = createSubagentWatchdog({
		idleMs,
		maxTotalMs,
		clock,
		onFire: (kind) => fired.push(kind),
	});
	return { clock, fired, watchdog };
}

{
	const { clock, fired, watchdog } = makeWatchdog(100, 1_000);
	for (let i = 0; i < 5; i++) {
		clock.advance(90);
		watchdog.touch();
	}
	assert.deepEqual(fired, []);
	assert.equal(watchdog.firedKind, undefined);
	clock.advance(99);
	assert.deepEqual(fired, []);
	clock.advance(1);
	assert.deepEqual(fired, ["idle"]);
	assert.equal(watchdog.firedKind, "idle");
}

{
	const { clock, fired, watchdog } = makeWatchdog(100, 1_000);
	clock.advance(100);
	assert.deepEqual(fired, ["idle"]);
	assert.equal(watchdog.firedKind, "idle");
}

{
	const { clock, fired, watchdog } = makeWatchdog(100, 500);
	for (let elapsed = 0; elapsed < 500; elapsed += 90) {
		clock.advance(90);
		watchdog.touch();
	}
	assert.deepEqual(fired, ["max_total"]);
	assert.equal(watchdog.firedKind, "max_total");
}

{
	const { clock, fired, watchdog } = makeWatchdog(100, 500);
	watchdog.cancel();
	clock.advance(1_000);
	assert.deepEqual(fired, []);
	assert.equal(watchdog.firedKind, undefined);
}

{
	const { clock, fired, watchdog } = makeWatchdog(100, 100);
	clock.advance(100);
	clock.advance(100);
	watchdog.touch();
	assert.equal(fired.length, 1);
	assert.ok(fired[0] === "idle" || fired[0] === "max_total");
	assert.equal(watchdog.firedKind, fired[0]);
}

console.log("subagent watchdog tests passed");
