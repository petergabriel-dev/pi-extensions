import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadDesignManifest } from "./design.js";

export async function suggestDesignDrift(changedFiles: string[], cwd: string): Promise<string[]> {
	const manifest = await loadDesignManifest(cwd);
	const declared = new Set(manifest?.tokenFiles.map(file => file.replaceAll("\\", "/")) ?? []);
	const tokenChanges = changedFiles.filter(file => declared.has(file.replaceAll("\\", "/")));
	const componentChanges: string[] = [];
	for (const file of changedFiles.filter(file => /(?:src\/)?components\/[^/]+\.(?:[cm]?[jt]sx?)$/i.test(file))) {
		try {
			await stat(join(cwd, "docs/design/components", basename(file).replace(/\.[^.]+$/, ".md")));
			componentChanges.push(file);
		} catch { /* no matching curated spec */ }
	}
	return [
		...(tokenChanges.length ? [`Run /docs update-tokens; declared token files changed: ${tokenChanges.join(", ")}`] : []),
		...(componentChanges.length ? [`Review matching docs/design/components specs for changed component source: ${componentChanges.join(", ")}`] : []),
	];
}
