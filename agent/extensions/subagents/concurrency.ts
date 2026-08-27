import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_CONCURRENCY_CAP = 3;

export interface SubagentConcurrencySettings {
	concurrencyCap: number;
}

export interface SlotInfo {
	lane: "default";
	queuedMs: number;
	activeAtAcquire: number;
	capacity: number;
}

export interface AcquiredSubagentSlot extends SlotInfo {
	release(): void;
}

interface Waiter {
	resolve: (info: SlotInfo) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abort?: () => void;
	enqueuedAt: number;
}

class Semaphore {
	private active = 0;
	private queue: Waiter[] = [];

	constructor(private capacity: number) {}

	setCapacity(capacity: number): void {
		this.capacity = Math.max(1, Math.floor(capacity));
		this.drain();
	}

	getActive(): number {
		return this.active;
	}

	getQueued(): number {
		return this.queue.length;
	}

	async acquire(signal: AbortSignal | undefined): Promise<SlotInfo> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent spawn aborted while waiting for a concurrency slot."));
		const enqueuedAt = Date.now();
		if (this.active < this.capacity) {
			this.active += 1;
			return { lane: "default", queuedMs: 0, activeAtAcquire: this.active, capacity: this.capacity };
		}
		return new Promise<SlotInfo>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal, enqueuedAt };
			const abort = () => {
				const index = this.queue.indexOf(waiter);
				if (index >= 0) this.queue.splice(index, 1);
				signal?.removeEventListener("abort", abort);
				reject(new Error("Subagent spawn aborted while waiting for a concurrency slot."));
			};
			waiter.abort = abort;
			signal?.addEventListener("abort", abort, { once: true });
			this.queue.push(waiter);
		});
	}

	release(): void {
		this.active = Math.max(0, this.active - 1);
		this.drain();
	}

	private drain(): void {
		while (this.active < this.capacity && this.queue.length > 0) {
			const waiter = this.queue.shift()!;
			waiter.signal?.removeEventListener("abort", waiter.abort!);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Subagent spawn aborted while waiting for a concurrency slot."));
				continue;
			}
			this.active += 1;
			waiter.resolve({ lane: "default", queuedMs: Date.now() - waiter.enqueuedAt, activeAtAcquire: this.active, capacity: this.capacity });
		}
	}
}

const defaultLane = new Semaphore(DEFAULT_CONCURRENCY_CAP);

function parsePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function readJsonObject(filePath: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function findNearestProjectSettings(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function subagentsConfig(settings: Record<string, unknown>): Record<string, unknown> {
	const value = settings.subagents;
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getSubagentConcurrencySettings(cwd: string): SubagentConcurrencySettings {
	const globalConfig = subagentsConfig(readJsonObject(path.join(getAgentDir(), "settings.json")));
	const projectPath = findNearestProjectSettings(cwd);
	const projectConfig = projectPath ? subagentsConfig(readJsonObject(projectPath)) : {};
	return { concurrencyCap: parsePositiveInteger({ ...globalConfig, ...projectConfig }.concurrencyCap, DEFAULT_CONCURRENCY_CAP) };
}

export function getConcurrencySnapshot(cwd: string) {
	const settings = getSubagentConcurrencySettings(cwd);
	defaultLane.setCapacity(settings.concurrencyCap);
	return { settings, defaultLane: { active: defaultLane.getActive(), queued: defaultLane.getQueued() } };
}

export async function acquireSubagentSlot(cwd: string, signal: AbortSignal | undefined): Promise<AcquiredSubagentSlot> {
	const settings = getSubagentConcurrencySettings(cwd);
	defaultLane.setCapacity(settings.concurrencyCap);
	const info = await defaultLane.acquire(signal);
	let released = false;
	return { ...info, release: () => { if (released) return; released = true; defaultLane.release(); } };
}

export async function withSubagentSlot<T>(
	_cwd: string,
	signal: AbortSignal | undefined,
	fn: (slot: SlotInfo) => Promise<T>,
): Promise<T> {
	const slot = await acquireSubagentSlot(_cwd, signal);
	try {
		return await fn(slot);
	} finally {
		slot.release();
	}
}
