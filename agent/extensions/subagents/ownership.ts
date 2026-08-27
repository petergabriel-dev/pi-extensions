export interface OwnershipConflict {
	owner: string;
	requestedPath: string;
	existingPath: string;
}

export interface OwnershipAcquireResult {
	ok: boolean;
	paths: string[];
	conflict?: OwnershipConflict;
}

export function normalizeOwnership(paths: readonly string[] | undefined): string[] {
	return [...new Set((paths ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

export function ownershipOverlaps(left: string, right: string): boolean {
	const a = left.replace(/\/{1,2}\*\*?$/, "").replace(/\/$/, "");
	const b = right.replace(/\/{1,2}\*\*?$/, "").replace(/\/$/, "");
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class OwnershipLockManager {
	private readonly locks = new Map<string, Set<string>>();

	acquire(owner: string, requestedPaths: readonly string[] | undefined): OwnershipAcquireResult {
		const paths = normalizeOwnership(requestedPaths);
		for (const requestedPath of paths) {
			for (const [existingOwner, existingPaths] of this.locks) {
				if (existingOwner === owner) continue;
				for (const existingPath of existingPaths) {
					if (ownershipOverlaps(requestedPath, existingPath)) return { ok: false, paths, conflict: { owner: existingOwner, requestedPath, existingPath } };
				}
			}
		}
		if (paths.length > 0) this.locks.set(owner, new Set(paths));
		return { ok: true, paths };
	}

	release(owner: string): void {
		this.locks.delete(owner);
	}

	has(owner: string): boolean {
		return this.locks.has(owner);
	}

	snapshot(): Record<string, string[]> {
		return Object.fromEntries([...this.locks.entries()].map(([owner, paths]) => [owner, [...paths]]));
	}
}
