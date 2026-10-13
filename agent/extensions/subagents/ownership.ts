import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_OWNERSHIP_PATHS = 100;

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
	const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/{1,2}\*\*?$/, "").replace(/\/+$/, "");
	const a = normalize(left);
	const b = normalize(right);
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

interface OwnershipPath {
	original: string;
	canonical: string;
}

function canonicalOwnershipPath(value: string, cwd: string): string {
	const relativePath = value.replace(/\/\*\*?$/, "");
	const lexicalPath = path.resolve(cwd, relativePath);
	let ancestor = lexicalPath;
	const remainder: string[] = [];
	while (true) {
		try {
			const realAncestor = fs.realpathSync.native(ancestor);
			return path.resolve(realAncestor, ...remainder.reverse()).toLowerCase();
		} catch {
			const parent = path.dirname(ancestor);
			if (parent === ancestor) return lexicalPath.toLowerCase();
			remainder.push(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

export class OwnershipLockManager {
	private readonly locks = new Map<string, OwnershipPath[]>();

	acquire(owner: string, requestedPaths: readonly string[] | undefined, cwd: string): OwnershipAcquireResult {
		if ((requestedPaths?.length ?? 0) > MAX_OWNERSHIP_PATHS) throw new Error(`Ownership paths exceed maximum of ${MAX_OWNERSHIP_PATHS}.`);
		const paths = normalizeOwnership(requestedPaths);
		const identities = paths.map((original) => ({ original, canonical: canonicalOwnershipPath(original, cwd) }));
		for (const requested of identities) {
			for (const [existingOwner, existingPaths] of this.locks) {
				if (existingOwner === owner) continue;
				for (const existing of existingPaths) {
					if (ownershipOverlaps(requested.canonical, existing.canonical)) {
						return { ok: false, paths, conflict: { owner: existingOwner, requestedPath: requested.original, existingPath: existing.original } };
					}
				}
			}
		}
		if (paths.length > 0) this.locks.set(owner, identities);
		return { ok: true, paths };
	}

	release(owner: string): void {
		this.locks.delete(owner);
	}

	has(owner: string): boolean {
		return this.locks.has(owner);
	}

	snapshot(): Record<string, string[]> {
		return Object.fromEntries([...this.locks.entries()].map(([owner, paths]) => [owner, paths.map(({ original }) => original)]));
	}
}
