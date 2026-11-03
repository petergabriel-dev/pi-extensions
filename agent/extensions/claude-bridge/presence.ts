import * as fs from "node:fs";

export const LIVE_TTL_MS = 5_000;

export interface PresencePeer {
	harness: string;
	id: string;
}

export interface LivePresence {
	peers: readonly PresencePeer[];
}

export function stoppedHeartbeatAt(now: number): string {
	return new Date(now - LIVE_TTL_MS - 1).toISOString();
}

export function clearRequestCache(dirs: readonly string[]): void {
	for (const dir of dirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cache cleanup */ }
	}
}

export function restorablePeers<T extends PresencePeer>(previous: readonly T[], otherLive: readonly LivePresence[]): T[] {
	const livePeerKeys = new Set(otherLive.flatMap(({ peers }) => peers.map((peer) => JSON.stringify([peer.harness, peer.id]))));
	return previous.filter((peer) => !livePeerKeys.has(JSON.stringify([peer.harness, peer.id])));
}

// A namespace with no readable presence whose directory has not changed for this
// long has no live owner: every heartbeat renames a fresh presence file into it,
// refreshing the directory mtime. A future or unknown (NaN) mtime is never
// abandoned: its age is never over the threshold.
export const ABANDONED_NAMESPACE_MS = 60_000;

export function isAbandonedNamespace(hasPresence: boolean, dirMtimeMs: number, now: number): boolean {
	return !hasPresence && now - dirMtimeMs > ABANDONED_NAMESPACE_MS;
}

// Reports a repeating failure once per streak: later failures stay quiet until a
// success resets it.
export function failureStreakReporter(report: (error: unknown) => void): { failed(error: unknown): void; succeeded(): void } {
	let failing = false;
	return {
		failed(error: unknown) {
			if (failing) return;
			failing = true;
			report(error);
		},
		succeeded() {
			failing = false;
		},
	};
}
