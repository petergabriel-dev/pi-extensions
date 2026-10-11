import { fileURLToPath } from "node:url";

import { checkDocs, validateAllADRs } from "../agent/extensions/engineering-docs/filesystem.ts";

async function main(): Promise<void> {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const [docs, adrs] = await Promise.all([checkDocs(root), validateAllADRs(root)]);
	const failures: string[] = [];

	if (docs.staleIndex) failures.push("Decision index is stale; fix with /docs update-index in Build/Off.");
	for (const spoke of docs.spokes) {
		if (!spoke.healthy) failures.push(`Root spoke ${spoke.path} is unhealthy; fix with /docs check in Build/Off.`);
	}
	for (const adr of adrs) {
		if (!adr.valid) failures.push(`${adr.filename}: ${adr.errors.join("; ")}; review/fix with /docs check in Build/Off.`);
	}

	if (failures.length > 0) {
		console.error(`Engineering docs check failed:\n- ${failures.join("\n- ")}`);
		process.exitCode = 1;
	} else {
		console.log("Engineering docs check passed.");
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
