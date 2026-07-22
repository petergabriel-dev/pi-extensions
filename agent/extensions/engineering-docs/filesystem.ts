// Filesystem utilities for docs/engineering/ management

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { DESIGN_DIR, DESIGN_MANIFEST_FILE, DESIGN_MANIFEST_KIND, DESIGN_MANIFEST_VERSION, loadDesignManifest, parseCssTokens, type DesignManifest, type DesignToken } from "./design.js";
import {
	DOCS_DIR,
	MANIFEST_FILE,
	DECISIONS_DIR,
	DECISIONS_INDEX,
	MANAGED_BY,
	MANIFEST_VERSION,
	CANONICAL_DOCS,
	ADR_TEMPLATE,
	DOCS_AREA_TAGS,
	ADR_ACTION_TAGS,
	SPOKE_FILES,
	SPOKE_MARKER_START,
	SPOKE_MARKER_END,
	type DocsManifest,
	type ADRMetadata,
} from "./constants.js";

// ── Manifest ──

function docsRoot(cwd: string): string {
	return join(cwd, DOCS_DIR);
}

function manifestPath(cwd: string): string {
	return join(docsRoot(cwd), MANIFEST_FILE);
}

export async function manifestExists(cwd: string): Promise<boolean> {
	try {
		await stat(manifestPath(cwd));
		return true;
	} catch {
		return false;
	}
}

export async function readManifest(cwd: string): Promise<DocsManifest | null> {
	try {
		const raw = await readFile(manifestPath(cwd), "utf-8");
		return JSON.parse(raw) as DocsManifest;
	} catch {
		return null;
	}
}

export async function writeManifest(cwd: string, manifest: DocsManifest): Promise<void> {
	await mkdir(docsRoot(cwd), { recursive: true });
	await writeFile(manifestPath(cwd), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ── Docs init ──

const README_CONTENT = `# Engineering Docs

These docs are plain Markdown for all contributors.

This project supports Pi documentation tooling for initialization,
validation, and generated indexes. If you edit generated sections,
run the docs tooling to refresh them.

## Structure

- **architecture.md** — System shape, component boundaries, data flow
- **dev-workflow.md** — Setup, env, commands, build/test/deploy steps
- **conventions.md** — Naming, style, patterns, coding rules
- **invariants.md** — Must-not-break rules
- **traps.md** — Known gotchas, pitfalls, and issues
- **decisions/** — Architectural decision records (ADRs)
`;

const TOPIC_PLACEHOLDER = (topic: string) =>
	`<!-- TODO: document verified project ${topic} -->\n\n## ${topic.charAt(0).toUpperCase() + topic.slice(1)}\n\n<!-- Replace this placeholder with verified project documentation. -->\n<!-- Include only facts confirmed by code inspection or authoritative sources. -->\n<!-- Mark unsupported claims as TODO. -->\n`;

const ADR_TEMPLATE_CONTENT = `---
id: ADR-000N
title: Short title
status: Proposed | Active | Superseded | Deprecated
date: YYYY-MM-DD
---

# ADR-000N: Short title

## Decision

- Decision point 1
- Decision point 2

## Why

- Main reason/tradeoff 1
- Main reason/tradeoff 2

## Affects

Docs:

- \`docs/engineering/...\`

Code:

- \`src/...\`

## Consequences

- Good: benefit 1
- Good: benefit 2
- Bad/risk: risk 1

## Read when

- touching relevant area 1
- touching relevant area 2

## Supersedes

- (ADR-XXXXX, if any)
`;

export interface InitResult {
	created: string[];
	skipped: string[];
	manifest: DocsManifest;
}

export interface DesignInitResult {
	created: string[];
	skipped: string[];
}

export function generateSpokeBody(): string {
	return `${SPOKE_MARKER_START}
# Project knowledge
Before writing code, read:
- docs/engineering/invariants.md — rules that must not break
- docs/engineering/conventions.md — how this codebase is written
Full docs (architecture, ADRs, traps): docs/engineering/
${SPOKE_MARKER_END}
`;
}

export interface WriteSpokesResult {
	written: string[];
	unchanged: string[];
}

export function mergeSpokeContent(existing: string | null, body = generateSpokeBody()): string {
	if (existing === null) return body;

	const start = existing.indexOf(SPOKE_MARKER_START);
	const end = existing.indexOf(SPOKE_MARKER_END, start + SPOKE_MARKER_START.length);
	if (start !== -1 && end !== -1) {
		let afterEnd = end + SPOKE_MARKER_END.length;
		if (existing.slice(afterEnd, afterEnd + 2) === "\r\n") afterEnd += 2;
		else if (existing[afterEnd] === "\n") afterEnd += 1;
		return existing.slice(0, start) + body + existing.slice(afterEnd);
	}

	if (existing.length === 0) return body;
	if (existing.endsWith("\n\n")) return existing + body;
	if (existing.endsWith("\n")) return existing + "\n" + body;
	return existing + "\n\n" + body;
}

export async function writeSpokes(cwd: string): Promise<WriteSpokesResult> {
	const written: string[] = [];
	const unchanged: string[] = [];

	for (const spoke of SPOKE_FILES) {
		const filePath = join(cwd, spoke);
		let existing: string | null = null;
		try {
			existing = await readFile(filePath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const next = mergeSpokeContent(existing);
		if (next === existing) {
			unchanged.push(spoke);
			continue;
		}

		await writeFile(filePath, next, "utf-8");
		written.push(spoke);
	}

	return { written, unchanged };
}

export async function initDocs(cwd: string): Promise<InitResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const root = docsRoot(cwd);

	// Ensure root dir
	await mkdir(root, { recursive: true });
	await mkdir(join(root, DECISIONS_DIR), { recursive: true });

	// README
	const readmePath = join(root, "README.md");
	try {
		await stat(readmePath);
		skipped.push(relative(cwd, readmePath));
	} catch {
		await writeFile(readmePath, README_CONTENT, "utf-8");
		created.push(relative(cwd, readmePath));
	}

	// Canonical docs
	for (const doc of CANONICAL_DOCS) {
		if (doc === "README.md") continue; // already handled
		const filePath = join(root, doc);
		try {
			await stat(filePath);
			skipped.push(relative(cwd, filePath));
		} catch {
			const topic = doc.replace(".md", "");
			await writeFile(filePath, TOPIC_PLACEHOLDER(topic), "utf-8");
			created.push(relative(cwd, filePath));
		}
	}

	// ADR template
	const templatePath = join(root, DECISIONS_DIR, ADR_TEMPLATE);
	try {
		await stat(templatePath);
		skipped.push(relative(cwd, templatePath));
	} catch {
		await writeFile(templatePath, ADR_TEMPLATE_CONTENT, "utf-8");
		created.push(relative(cwd, templatePath));
	}

	// Decisions index
	const indexPath = join(root, DECISIONS_DIR, DECISIONS_INDEX);
	try {
		await stat(indexPath);
		skipped.push(relative(cwd, indexPath));
	} catch {
		await writeFile(indexPath, "# Decisions\n\n| ADR | Status | Summary | Read when |\n|---|---|---|---|\n", "utf-8");
		created.push(relative(cwd, indexPath));
	}

	const spokes = await writeSpokes(cwd);
	created.push(...spokes.written);
	skipped.push(...spokes.unchanged);

	// Manifest
	const manifest: DocsManifest = {
		version: MANIFEST_VERSION,
		kind: "engineering-docs",
		managedBy: MANAGED_BY,
		entrypoint: `${DOCS_DIR}/README.md`,
		canonicalDocs: CANONICAL_DOCS.map((d) => `${DOCS_DIR}/${d}`),
		generated: [`${DOCS_DIR}/${DECISIONS_DIR}/${DECISIONS_INDEX}`, ...SPOKE_FILES],
	};
	await writeManifest(cwd, manifest);
	created.push(relative(cwd, manifestPath(cwd)));

	return { created, skipped, manifest };
}

const DESIGN_README_CONTENT = `# Design System

## Index

- [Tokens](tokens.md)
- [Components](components/)
- [Preview gallery](preview/index.html)

## Principles

Tokens before components. Use primitive values through semantic aliases. Component specs constrain implementation; component code belongs in Build mode. Previews are single-column, vertically stacked, and responsive-ready — no grid galleries.

## Token CSS convention

Declare custom properties only inside marked sections and supported theme roots:

\`\`\`css
/* @primitive */
:root { --color-blue-500: #2563eb; }
/* @semantic */
:root { --color-action: var(--color-blue-500); }
[data-theme="dark"] { --color-action: var(--color-blue-500); }
.dark { --color-action: var(--color-blue-500); }
\`\`\`

Use either \`[data-theme="dark"]\` or \`.dark\` for dark-theme roots. Add each token CSS path to \`manifest.json\` before editing it. Preview HTML must use \`var(--*)\` values only.
`;

const COMPONENT_TEMPLATE_CONTENT = `# Component name

## Purpose

## Anatomy

## Variants

## Sizes

## States

## Props/API

## Accessibility

Describe keyboard behavior, semantics, labels, focus, and contrast. This section is required.

## Responsive

Describe breakpoint behavior, fluid sizing, and touch targets. This section is required.

## Usage

## Preview

[Open preview](../preview/index.html)
`;

const PREVIEW_INDEX_CONTENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Design system gallery</title>
  <!-- Add stylesheet links for tokenFiles declared in ../manifest.json. -->
</head>
<body>
  <!-- Projects with a .dark-class base system (for example, shadcn) should toggle that class instead. -->
  <button type="button" data-theme-toggle aria-pressed="false">Toggle theme</button>
  <header><h1>Design system gallery</h1></header>
  <main>
    <!-- Single-column vertical layout: stack sections; do not use grid galleries. -->
    <nav aria-label="Preview examples"><a href="example.html">Example screen</a></nav>
  </main>
  <script>
    const themeToggle = document.querySelector("[data-theme-toggle]");
    themeToggle?.addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme !== "dark";
      root.dataset.theme = dark ? "dark" : "light";
      themeToggle.setAttribute("aria-pressed", String(dark));
    });
  </script>
</body>
</html>
`;

const PREVIEW_EXAMPLE_CONTENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example design screen</title>
</head>
<body>
  <!-- Projects with a .dark-class base system (for example, shadcn) should toggle that class instead. -->
  <button type="button" data-theme-toggle aria-pressed="false">Toggle theme</button>
  <main>
    <h1>Example screen</h1>
    <p>Compose approved components here after tokens and specs exist.</p>
  </main>
  <script>
    const themeToggle = document.querySelector("[data-theme-toggle]");
    themeToggle?.addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme !== "dark";
      root.dataset.theme = dark ? "dark" : "light";
      themeToggle.setAttribute("aria-pressed", String(dark));
    });
  </script>
</body>
</html>
`;

export async function designManifestExists(cwd: string): Promise<boolean> {
	try {
		await stat(join(cwd, DESIGN_DIR, DESIGN_MANIFEST_FILE));
		return true;
	} catch {
		return false;
	}
}

export async function initDesignDocs(cwd: string): Promise<DesignInitResult> {
	const created: string[] = [];
	const skipped: string[] = [];
	const files = new Map<string, string>([
		[join(DESIGN_DIR, DESIGN_MANIFEST_FILE), `${JSON.stringify({ version: DESIGN_MANIFEST_VERSION, kind: DESIGN_MANIFEST_KIND, tokenFiles: [] }, null, 2)}\n`],
		[join(DESIGN_DIR, "README.md"), DESIGN_README_CONTENT],
		[join(DESIGN_DIR, "components", "TEMPLATE.md"), COMPONENT_TEMPLATE_CONTENT],
		[join(DESIGN_DIR, "preview", "index.html"), PREVIEW_INDEX_CONTENT],
		[join(DESIGN_DIR, "preview", "example.html"), PREVIEW_EXAMPLE_CONTENT],
	]);
	for (const [file, content] of files) {
		const path = join(cwd, file);
		try {
			await stat(path);
			skipped.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(resolve(path, ".."), { recursive: true });
			await writeFile(path, content, "utf8");
			created.push(file);
		}
	}
	return { created, skipped };
}

export interface DesignCheckResult {
	manifest: DesignManifest | null;
	errors: string[];
	warnings: string[];
	tokensStale: boolean;
	previewViolations: string[];
}

async function readDesignTokenFiles(cwd: string, manifest: DesignManifest): Promise<{ sources: Array<{ path: string; content: string }>; errors: string[] }> {
	const sources: Array<{ path: string; content: string }> = [];
	const errors: string[] = [];
	for (const file of manifest.tokenFiles) {
		try {
			sources.push({ path: file, content: await readFile(join(cwd, file), "utf8") });
		} catch {
			errors.push(`Token file unreadable: ${file}`);
		}
	}
	return { sources, errors };
}

function tokenHash(sources: Array<{ path: string; content: string }>): string {
	return createHash("sha256").update(sources.map(source => `${source.path}\0${source.content}`).join("\0")).digest("hex");
}

export function generateTokensMarkdown(tokens: readonly DesignToken[], hash: string): string {
	const rows = new Map<string, { layer: DesignToken["layer"]; light?: string; dark?: string }>();
	for (const token of tokens) {
		const row = rows.get(token.name) ?? { layer: token.layer };
		row[token.theme] = token.value;
		rows.set(token.name, row);
	}
	const byLayer = (layer: DesignToken["layer"]) => [...rows.entries()].filter(([, row]) => row.layer === layer).sort(([a], [b]) => a.localeCompare(b));
	const table = (layer: DesignToken["layer"]) => {
		const rows = byLayer(layer);
		return rows.length === 0 ? "No tokens found.\n" : ["| Token | Light | Dark |", "|---|---|---|", ...rows.map(([name, row]) => `| ${name} | ${row.light ?? "—"} | ${row.dark ?? "—"} |`), ""].join("\n");
	};
	return `# Design Tokens\n\n<!-- token-hash: ${hash} -->\n\n## Primitive\n\n${table("primitive")}## Semantic\n\n${table("semantic")}`;
}

export async function updateDesignTokens(cwd: string): Promise<{ path: string; warnings: string[] }> {
	const manifest = await loadDesignManifest(cwd);
	if (!manifest) throw new Error(`Invalid or missing ${DESIGN_DIR}/${DESIGN_MANIFEST_FILE}.`);
	const { sources, errors } = await readDesignTokenFiles(cwd, manifest);
	if (errors.length > 0) throw new Error(errors.join(" "));
	const parsed = sources.flatMap(source => parseCssTokens(source.content));
	const warnings = parsed.flatMap(result => result.warnings);
	const tokens = parsed.flatMap(result => result.tokens);
	const path = join(cwd, DESIGN_DIR, "tokens.md");
	await writeFile(path, generateTokensMarkdown(tokens, tokenHash(sources)), "utf8");
	return { path: relative(cwd, path), warnings };
}

function previewLint(content: string, file: string): string[] {
	const violations: string[] = [];
	const styles = [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|\sstyle\s*=\s*(["'])([\s\S]*?)\2/gi)].map(match => match[1] ?? match[3] ?? "");
	for (const style of styles) {
		if (/#(?:[0-9a-f]{3,8})\b/i.test(style) || /\b\d+(?:\.\d+)?(?:px|rem)\b/i.test(style) || /:(?!\s*var\(--)[^;{}]+(?:;|$)/.test(style)) violations.push(`${file}: preview styles must use var(--*) values only`);
	}
	return violations;
}

export async function checkDesignDocs(cwd: string): Promise<DesignCheckResult> {
	const manifest = await loadDesignManifest(cwd);
	if (!manifest) return { manifest: null, errors: [`Invalid or missing ${DESIGN_DIR}/${DESIGN_MANIFEST_FILE}.`], warnings: [], tokensStale: false, previewViolations: [] };
	const { sources, errors } = await readDesignTokenFiles(cwd, manifest);
	const parsed = sources.map(source => parseCssTokens(source.content));
	const warnings = parsed.flatMap(result => result.warnings);
	const expected = generateTokensMarkdown(parsed.flatMap(result => result.tokens), tokenHash(sources));
	let tokensStale = true;
	try { tokensStale = await readFile(join(cwd, DESIGN_DIR, "tokens.md"), "utf8") !== expected; } catch { /* missing tokens.md is stale */ }
	const previewViolations: string[] = [];
	for (const file of ["index.html", "example.html"]) {
		try { previewViolations.push(...previewLint(await readFile(join(cwd, DESIGN_DIR, "preview", file), "utf8"), `${DESIGN_DIR}/preview/${file}`)); } catch { /* preview is optional until scaffolded */ }
	}
	return { manifest, errors, warnings, tokensStale, previewViolations };
}

// ── Docs check/status ──

export type DocStatus = "managed" | "unmanaged-partial" | "missing";

export interface SpokeCheckResult {
	path: string;
	exists: boolean;
	hasBlock: boolean;
	bodyMatches: boolean;
	deadLinks: string[];
	healthy: boolean;
}

export interface DocsCheckResult {
	status: DocStatus;
	manifest: DocsManifest | null;
	missingDocs: string[];
	existingDocs: string[];
	staleIndex: boolean;
	adrFiles: string[];
	spokes: SpokeCheckResult[];
	spokesRepaired: string[];
}

export interface CheckDocsOptions {
	repairSpokes?: boolean;
}

const SPOKE_LINKS = [
	`${DOCS_DIR}/invariants.md`,
	`${DOCS_DIR}/conventions.md`,
	DOCS_DIR,
] as const;

export async function checkSpokes(cwd: string): Promise<SpokeCheckResult[]> {
	const body = generateSpokeBody();
	const deadLinks: string[] = [];
	for (const link of SPOKE_LINKS) {
		try {
			await stat(join(cwd, link));
		} catch {
			deadLinks.push(link);
		}
	}

	const results: SpokeCheckResult[] = [];
	for (const spoke of SPOKE_FILES) {
		let content = "";
		let exists = true;
		try {
			content = await readFile(join(cwd, spoke), "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			exists = false;
		}

		const start = exists ? content.indexOf(SPOKE_MARKER_START) : -1;
		const end = start === -1 ? -1 : content.indexOf(SPOKE_MARKER_END, start + SPOKE_MARKER_START.length);
		const hasBlock = start !== -1 && end !== -1;
		const bodyMatches = hasBlock && mergeSpokeContent(content) === content;
		results.push({
			path: spoke,
			exists,
			hasBlock,
			bodyMatches,
			deadLinks: [...deadLinks],
			healthy: exists && hasBlock && bodyMatches && deadLinks.length === 0,
		});
	}
	return results;
}

export async function checkDocs(cwd: string, options: CheckDocsOptions = {}): Promise<DocsCheckResult> {
	const manifest = await readManifest(cwd);
	const root = docsRoot(cwd);
	const missingDocs: string[] = [];
	const existingDocs: string[] = [];

	// Check canonical docs
	for (const doc of CANONICAL_DOCS) {
		const filePath = join(root, doc);
		try {
			await stat(filePath);
			existingDocs.push(relative(cwd, filePath));
		} catch {
			missingDocs.push(relative(cwd, filePath));
		}
	}

	// Check manifest
	if (manifest) {
		for (const doc of manifest.canonicalDocs) {
			const absPath = join(cwd, doc);
			if (!existingDocs.includes(relative(cwd, absPath)) && !missingDocs.includes(relative(cwd, absPath))) {
				try {
					await stat(absPath);
					existingDocs.push(doc);
				} catch {
					missingDocs.push(doc);
				}
			}
		}
	}

	// List ADR files
	const adrFiles: string[] = [];
	const decisionsDir = join(root, DECISIONS_DIR);
	try {
		const entries = await readdir(decisionsDir);
		for (const entry of entries) {
			if (entry.startsWith("ADR-") && entry.endsWith(".md") && entry !== ADR_TEMPLATE) {
				adrFiles.push(relative(cwd, join(decisionsDir, entry)));
			}
		}
	} catch {
		// decisions dir doesn't exist yet
	}

	// Check if decisions index is stale
	let staleIndex = false;
	const indexPath = join(decisionsDir, DECISIONS_INDEX);
	try {
		const indexContent = await readFile(indexPath, "utf-8");
		// If there are ADR files but index doesn't reference them, it's stale
		for (const adr of adrFiles) {
			const adrName = adr.split("/").pop()?.match(/^ADR-\d{4,}/)?.[0] ?? "";
			if (!indexContent.includes(adrName)) {
				staleIndex = true;
				break;
			}
		}
	} catch {
		staleIndex = adrFiles.length > 0;
	}

	let spokes = await checkSpokes(cwd);
	let spokesRepaired: string[] = [];
	if (options.repairSpokes && spokes.some((spoke) => !spoke.healthy)) {
		const repaired = await writeSpokes(cwd);
		spokesRepaired = repaired.written;
		spokes = await checkSpokes(cwd);
	}

	// Determine status
	let status: DocStatus;
	if (manifest && missingDocs.length === 0) {
		status = "managed";
	} else if (manifest || existingDocs.length > 0) {
		status = "unmanaged-partial";
	} else {
		status = "missing";
	}

	return { status, manifest, missingDocs, existingDocs, staleIndex, adrFiles, spokes, spokesRepaired };
}

// ── Decision index generation ──

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const frontmatter = match[1];
	const result: Record<string, string> = {};
	for (const line of frontmatter.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			result[key] = value;
		}
	}
	return result;
}

export async function generateDecisionIndex(cwd: string): Promise<string> {
	const decisionsDir = join(docsRoot(cwd), DECISIONS_DIR);
	const adrFiles: { filename: string; meta: Record<string, string> }[] = [];

	try {
		const entries = await readdir(decisionsDir);
		for (const entry of entries) {
			if (!entry.startsWith("ADR-") || !entry.endsWith(".md") || entry === ADR_TEMPLATE) continue;
			const content = await readFile(join(decisionsDir, entry), "utf-8");
			const meta = parseFrontmatter(content);
			adrFiles.push({ filename: entry, meta });
		}
	} catch {
		// decisions dir doesn't exist
	}

	// Sort by ID
	adrFiles.sort((a, b) => a.meta.id?.localeCompare(b.meta.id ?? "") ?? 0);

	const rows = adrFiles.map((adr) => {
		const id = adr.meta.id ?? adr.filename.replace(".md", "");
		const status = adr.meta.status ?? "Unknown";
		const summary = adr.meta.title ?? adr.filename;
		const readWhen = adr.meta.readWhen ?? "";
		return `| ${id} | ${status} | ${summary} | ${readWhen} |`;
	});

	const header = "# Decisions\n\n| ADR | Status | Summary | Read when |\n|---|---|---|---|\n";
	const content = header + rows.join("\n") + "\n";

	return content;
}

export async function updateDecisionIndex(cwd: string): Promise<void> {
	const content = await generateDecisionIndex(cwd);
	const indexPath = join(docsRoot(cwd), DECISIONS_DIR, DECISIONS_INDEX);
	await mkdir(join(docsRoot(cwd), DECISIONS_DIR), { recursive: true });
	await writeFile(indexPath, content, "utf-8");
}

// ── ADR parsing ──

export async function parseADR(cwd: string, filename: string): Promise<ADRMetadata | null> {
	const filePath = join(docsRoot(cwd), DECISIONS_DIR, filename);
	try {
		const content = await readFile(filePath, "utf-8");
		const meta = parseFrontmatter(content);
		return {
			id: meta.id ?? filename.replace(".md", ""),
			title: meta.title ?? filename,
			status: (meta.status as ADRMetadata["status"]) ?? "Proposed",
			date: meta.date ?? "",
			decision: [],
			why: [],
			affectsDocs: [],
			affectsCode: [],
			consequencesGood: [],
			consequencesBadRisk: [],
			readWhen: meta.readWhen ? [meta.readWhen] : [],
			supersedes: meta.supersedes,
		};
	} catch {
		return null;
	}
}

// ── ADR validation ──

export interface ADRValidationResult {
	filename: string;
	valid: boolean;
	errors: string[];
}

const REQUIRED_ADR_FIELDS = ["id", "title", "status", "date"] as const;

const VALID_ADR_STATUSES = ["Proposed", "Active", "Superseded", "Deprecated"] as const;

export function validateADRContent(content: string, filename: string): ADRValidationResult {
	const errors: string[] = [];
	const meta = parseFrontmatter(content);

	// Check required fields
	for (const field of REQUIRED_ADR_FIELDS) {
		if (!meta[field] || meta[field].trim() === "") {
			errors.push(`Missing required field: ${field}`);
		}
	}

	// Validate status
	if (meta.status && !VALID_ADR_STATUSES.includes(meta.status as any)) {
		errors.push(`Invalid status: ${meta.status}. Must be one of: ${VALID_ADR_STATUSES.join(", ")}`);
	}

	// Validate ID format
	if (meta.id && !/^ADR-\d{4,}$/.test(meta.id)) {
		errors.push(`Invalid ADR ID format: ${meta.id}. Must match ADR-NNNN`);
	}

	return { filename, valid: errors.length === 0, errors };
}

export async function validateAllADRs(cwd: string): Promise<ADRValidationResult[]> {
	const decisionsDir = join(docsRoot(cwd), DECISIONS_DIR);
	const results: ADRValidationResult[] = [];

	try {
		const entries = await readdir(decisionsDir);
		for (const entry of entries) {
			if (!entry.startsWith("ADR-") || !entry.endsWith(".md") || entry === ADR_TEMPLATE) continue;
			const content = await readFile(join(decisionsDir, entry), "utf-8");
			results.push(validateADRContent(content, entry));
		}
	} catch {
		// decisions dir doesn't exist
	}

	return results;
}

// ── Docs tag validation ──

export interface DocsTagValidation {
	tag: string;
	valid: boolean;
	error?: string;
}

export function validateDocsTag(tag: string): DocsTagValidation {
	// Match [DOCS:area] tags
	const docsMatch = tag.match(/^\[DOCS:([^\]]+)\]$/);
	if (!docsMatch) {
		// Bare [DOCS] without area is invalid
		if (tag === "[DOCS]") {
			return { tag, valid: false, error: "Bare [DOCS] tag is invalid. Specify area: [DOCS:architecture], [DOCS:dev-workflow], etc." };
		}
		return { tag, valid: false, error: "Not a docs tag" };
	}

	const area = docsMatch[1];
	if (!DOCS_AREA_TAGS.includes(area as any)) {
		return { tag, valid: false, error: `Unknown docs area: ${area}. Valid areas: ${DOCS_AREA_TAGS.join(", ")}` };
	}

	return { tag, valid: true };
}

export function validatePlanDocsTags(planText: string): DocsTagValidation[] {
	const results: DocsTagValidation[] = [];
	const tagRegex = /\[(DOCS|ADR)(?::([^\]]+))?\]/g;

	for (const line of planText.split("\n")) {
		const lineResults: DocsTagValidation[] = [];
		let hasValidAdrAction = false;

		for (const match of line.matchAll(tagRegex)) {
			const [tag, kind, value] = match;
			if (kind === "DOCS") {
				lineResults.push(validateDocsTag(tag));
				continue;
			}

			if (!value) {
				lineResults.push({ tag, valid: false, error: `Bare [ADR] tag is invalid. Specify action: ${ADR_ACTION_TAGS.map(action => `[ADR:${action}]`).join(", ")}` });
			} else if (ADR_ACTION_TAGS.includes(value as any)) {
				hasValidAdrAction = true;
				lineResults.push({ tag, valid: true });
			} else {
				lineResults.push({ tag, valid: false, error: `Unknown ADR action: ${value}. Valid actions: ${ADR_ACTION_TAGS.join(", ")}` });
			}
		}

		if (!hasValidAdrAction) {
			for (const result of lineResults) {
				if (result.tag === "[DOCS:decisions]" && result.valid) {
					result.valid = false;
					result.error = "[DOCS:decisions] must be accompanied by [ADR:new], [ADR:update], or [ADR:supersede]";
				}
			}
		}

		results.push(...lineResults);
	}

	return results;
}

export function formatPlanDocsTagValidation(planText: string): string {
	const validations = validatePlanDocsTags(planText);
	if (validations.length === 0) {
		return "No docs tags found in plan text.";
	}

	const invalidTags = validations.filter(validation => !validation.valid);
	if (invalidTags.length > 0) {
		return `Invalid docs tags found:\n${invalidTags.map(validation => `- ${validation.tag}: ${validation.error}`).join("\n")}`;
	}

	return `All ${validations.length} docs tags valid: ${validations.map(validation => validation.tag).join(", ")}`;
}

// ── Enhanced check with ADR validation ──

export interface EnhancedCheckResult extends DocsCheckResult {
	adrValidations: ADRValidationResult[];
	tagValidations: DocsTagValidation[];
}

export async function enhancedCheckDocs(cwd: string, planText?: string, options: CheckDocsOptions = {}): Promise<EnhancedCheckResult> {
	const baseCheck = await checkDocs(cwd, options);
	const adrValidations = await validateAllADRs(cwd);
	const tagValidations = planText ? validatePlanDocsTags(planText) : [];

	return { ...baseCheck, adrValidations, tagValidations };
}