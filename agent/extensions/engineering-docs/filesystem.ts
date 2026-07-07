// Filesystem utilities for docs/engineering/ management

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
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
			const adrName = adr.split("/").pop()?.replace(".md", "") ?? "";
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

	// Find all [DOCS:...] tags
	const docsTagRegex = /\[DOCS:[^\]]+\]/g;
	const matches = planText.match(docsTagRegex) ?? [];

	for (const match of matches) {
		const validation = validateDocsTag(match);
		if (!validation.valid) {
			results.push(validation);
		}
	}

	// Check if bare [DOCS] exists (without area)
	if (/\[DOCS\](?!:)/.test(planText)) {
		results.push({ tag: "[DOCS]", valid: false, error: "Bare [DOCS] tag without area. Specify: [DOCS:architecture], [DOCS:decisions], etc." });
	}

	// Check that [DOCS:decisions] has accompanying [ADR:*] tag on the same line
	const lines = planText.split("\n");
	for (const line of lines) {
		if (/\[DOCS:decisions\]/.test(line) && !/\[ADR:(new|update|supersede)\]/.test(line)) {
			results.push({ tag: "[DOCS:decisions]", valid: false, error: "[DOCS:decisions] must be accompanied by [ADR:new], [ADR:update], or [ADR:supersede]" });
		}
	}

	return results;
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