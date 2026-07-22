import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DESIGN_DIR = "docs/design";
export const DESIGN_MANIFEST_FILE = "manifest.json";
export const DESIGN_MANIFEST_KIND = "design-docs";
export const DESIGN_MANIFEST_VERSION = 1;
export const MAX_TOKEN_FILE_BYTES = 512 * 1024;
export const MAX_TOKENS = 2_000;

export interface DesignManifest {
	version: number;
	kind: typeof DESIGN_MANIFEST_KIND;
	tokenFiles: string[];
}

export interface DesignToken {
	name: string;
	value: string;
	layer: "primitive" | "semantic";
	theme: "light" | "dark";
}

export interface TokenParseResult {
	tokens: DesignToken[];
	warnings: string[];
}

function isSafeTokenFile(value: unknown): value is string {
	if (typeof value !== "string" || !value || isAbsolute(value) || !value.toLowerCase().endsWith(".css")) return false;
	return value.split(/[\\/]/).every(part => part !== ".." && part !== "");
}

export function validateDesignManifest(value: unknown): DesignManifest | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const manifest = value as Record<string, unknown>;
	if (manifest.version !== DESIGN_MANIFEST_VERSION || manifest.kind !== DESIGN_MANIFEST_KIND || !Array.isArray(manifest.tokenFiles)) return null;
	if (!manifest.tokenFiles.every(isSafeTokenFile)) return null;
	return { version: DESIGN_MANIFEST_VERSION, kind: DESIGN_MANIFEST_KIND, tokenFiles: [...manifest.tokenFiles] };
}

export function parseDesignManifest(raw: string): DesignManifest | null {
	try {
		return validateDesignManifest(JSON.parse(raw));
	} catch {
		return null;
	}
}

export async function loadDesignManifest(cwd: string): Promise<DesignManifest | null> {
	try {
		return parseDesignManifest(await readFile(resolve(cwd, DESIGN_DIR, DESIGN_MANIFEST_FILE), "utf8"));
	} catch {
		return null;
	}
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function isDesignSurfacePath(cwd: string, filePath: string, manifest: DesignManifest | null): boolean {
	const root = resolve(cwd);
	const target = resolve(root, filePath);
	if (!isInside(root, target)) return false;
	const designRoot = resolve(root, DESIGN_DIR);
	if (isInside(designRoot, target)) return true;
	if (!manifest) return false;
	return manifest.tokenFiles.some(tokenFile => resolve(root, tokenFile) === target);
}

function layerBefore(css: string, offset: number): DesignToken["layer"] | null {
	const markers = [...css.slice(0, offset).matchAll(/\/\*\s*@(primitive|semantic)\s*\*\//g)];
	return markers.at(-1)?.[1] as DesignToken["layer"] | undefined ?? null;
}

function matchingBrace(css: string, open: number): number {
	let depth = 0;
	for (let index = open; index < css.length; index++) {
		if (css[index] === "{") depth++;
		if (css[index] === "}" && --depth === 0) return index;
	}
	return -1;
}

export function parseCssTokens(css: string): TokenParseResult {
	const warnings: string[] = [];
	if (Buffer.byteLength(css, "utf8") > MAX_TOKEN_FILE_BYTES) {
		return { tokens: [], warnings: [`Token file exceeds ${MAX_TOKEN_FILE_BYTES} byte limit.`] };
	}

	const tokens: DesignToken[] = [];
	const blocks = /:root|\[data-theme\s*=\s*["']dark["']\s*\]|\.dark(?![\w-])/g;
	for (let match = blocks.exec(css); match; match = blocks.exec(css)) {
		const theme: DesignToken["theme"] = match[0] === ":root" ? "light" : "dark";
		const open = css.indexOf("{", match.index + match[0].length);
		if (open < 0) {
			warnings.push(`Missing block for ${match[0]}.`);
			continue;
		}
		const close = matchingBrace(css, open);
		if (close < 0) {
			warnings.push(`Unclosed block for ${match[0]}.`);
			continue;
		}
		const layer = layerBefore(css, match.index);
		const body = css.slice(open + 1, close);
		for (const declaration of body.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);?/g)) {
			if (!layer) {
				warnings.push(`Custom property --${declaration[1]} is outside an @primitive or @semantic section.`);
				continue;
			}
			if (tokens.length >= MAX_TOKENS) {
				warnings.push(`Token count exceeds ${MAX_TOKENS} limit.`);
				return { tokens, warnings };
			}
			tokens.push({ name: `--${declaration[1]}`, value: declaration[2]!.trim(), layer, theme });
		}
		blocks.lastIndex = close + 1;
	}
	return { tokens, warnings };
}
