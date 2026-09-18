import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDesignTokenIndex,
	detectDesignAdherence,
	formatDesignAdvisory,
} from "../design-adherence.ts";
import { registerTrackingHooks } from "../tracking.ts";

const tokenCss = `
/* @primitive */
:root {
	--color-brand: #d65a3a;
	--color-blue: #2563eb;
}
/* @semantic */
:root { --color-action: var(--color-brand); }
`;

async function createDesignRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "design-adherence-"));
	await mkdir(join(root, "docs/design"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "docs/design/manifest.json"), JSON.stringify({ version: 1, kind: "design-docs", tokenFiles: ["src/tokens.css"] }));
	await writeFile(join(root, "src/tokens.css"), tokenCss);
	return root;
}

function registerTestHandler(): (event: unknown, ctx: unknown) => Promise<unknown> {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	registerTrackingHooks({
		on: (_event: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) => { handler = callback; },
		appendEntry: async () => undefined,
	} as never);
	assert.ok(handler);
	return handler;
}

const root = await createDesignRoot();
const noManifestRoot = await mkdtemp(join(tmpdir(), "design-adherence-no-manifest-"));
try {
	const index = await buildDesignTokenIndex(root);
	assert.ok(index);

	assert.deepEqual(detectDesignAdherence("#d65a3a", index).findings, [
		{ literal: "#d65a3a", kind: "semantic", token: "--color-action" },
	]);
	assert.deepEqual(detectDesignAdherence("#2563eb", index).findings, [
		{ literal: "#2563eb", kind: "primitive", token: "--color-blue" },
	]);
	assert.deepEqual(detectDesignAdherence("#abcdef", index).findings, [
		{ literal: "#abcdef", kind: "unknown" },
	]);
	assert.deepEqual(detectDesignAdherence("rgb(214, 90, 58) rgba(214 90 58 / .5)", index).findings, [
		{ literal: "rgb(214, 90, 58)", kind: "semantic", token: "--color-action" },
		{ literal: "rgba(214 90 58 / .5)", kind: "semantic", token: "--color-action" },
	]);
	assert.deepEqual(detectDesignAdherence("hsl(10 20% 30%)", index).findings, [
		{ literal: "hsl(10 20% 30%)", kind: "hsl" },
	]);
	assert.deepEqual(detectDesignAdherence("#d65a3aff red", index).findings, [
		{ literal: "#d65a3aff", kind: "semantic", token: "--color-action" },
	]);
	assert.equal(formatDesignAdvisory(detectDesignAdherence("#abcdef", index))?.includes("docs/design/tokens.md"), true);
	assert.equal(formatDesignAdvisory(detectDesignAdherence("hsl(10 20% 30%)", index))?.includes("no exact suggestion"), true);

	const cap = detectDesignAdherence("#111111 #222222 #333333 #444444 #555555 #666666 #111111", index);
	assert.equal(cap.findings.length, 5);
	assert.equal(cap.more, 1);
	assert.equal(formatDesignAdvisory(cap)?.includes("+1 more"), true);

	const handler = registerTestHandler();
	const event = {
		isError: false,
		toolName: "write",
		input: { path: "src/Button.tsx", content: "const color = '#d65a3a';" },
		content: [{ type: "text", text: "Successfully wrote" }],
	};
	const writeResult = await handler(event, { cwd: root });
	assert.deepEqual((writeResult as { content: unknown[] }).content[0], event.content[0]);
	assert.match(String((writeResult as { content: { text: string }[] }).content[1]?.text), /var\(--color-action\)/);

	const editResult = await handler({
		...event,
		toolName: "edit",
		input: { path: "src/Button.tsx", edits: [{ oldText: "old", newText: "#d65a3a" }] },
	}, { cwd: root });
	assert.match(String((editResult as { content: { text: string }[] }).content[1]?.text), /var\(--color-action\)/);

	for (const path of ["README.md", "docs/design/components/Button.tsx", "src/tokens.css", "node_modules/Button.ts"]) {
		assert.equal(await handler({ ...event, input: { path, content: "#d65a3a" } }, { cwd: root }), undefined, path);
	}
	assert.equal(await handler(event, { cwd: noManifestRoot }), undefined, "missing manifest is passthrough");

	let reads = 0;
	let tokenMtime = 1;
	const cacheRoot = await mkdtemp(join(tmpdir(), "design-adherence-cache-test-"));
	try {
		const io = {
			stat: async (path: string) => ({ mtimeMs: path.endsWith("tokens.css") ? tokenMtime : 1 }),
			readFile: async (path: string) => {
				reads++;
				return path.endsWith("manifest.json")
					? JSON.stringify({ version: 1, kind: "design-docs", tokenFiles: ["src/tokens.css"] })
					: tokenCss;
			},
		};
		const first = await buildDesignTokenIndex(cacheRoot, io);
		assert.ok(first);
		assert.equal(reads, 2);
		assert.equal(await buildDesignTokenIndex(cacheRoot, io), first);
		assert.equal(reads, 2, "cached index avoids token-file reads");
		tokenMtime = 2;
		await buildDesignTokenIndex(cacheRoot, io);
		assert.equal(reads, 4, "token mtime invalidates parsed source");
	} finally {
		await rm(cacheRoot, { recursive: true, force: true });
	}
} finally {
	await rm(root, { recursive: true, force: true });
	await rm(noManifestRoot, { recursive: true, force: true });
}

console.log("design adherence assertions passed");
