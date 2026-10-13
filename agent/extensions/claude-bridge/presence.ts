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
