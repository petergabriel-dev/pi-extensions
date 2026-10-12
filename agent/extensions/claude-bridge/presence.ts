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

export function restorablePeers<T extends PresencePeer>(previous: readonly T[], otherLive: readonly LivePresence[]): T[] {
	const livePeerKeys = new Set(otherLive.flatMap(({ peers }) => peers.map((peer) => JSON.stringify([peer.harness, peer.id]))));
	return previous.filter((peer) => !livePeerKeys.has(JSON.stringify([peer.harness, peer.id])));
}
