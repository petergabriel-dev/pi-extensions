import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	DESIGN_DIR,
	DESIGN_MANIFEST_FILE,
	parseCssTokens,
	parseDesignManifest,
	type DesignManifest,
	type DesignToken,
} from "./design.js";

export const MAX_ADHERENCE_TEXT_BYTES = 256 * 1024;
export const MAX_ADHERENCE_FINDINGS = 5;
export const MAX_VAR_HOPS = 5;

export interface ResolvedDesignToken {
	name: string;
	value: string;
	layer: DesignToken["layer"];
	theme: DesignToken["theme"];
}

export interface DesignTokenIndex {
	readonly tokenFiles: readonly string[];
	readonly tokens: readonly ResolvedDesignToken[];
	readonly byValue: ReadonlyMap<string, readonly ResolvedDesignToken[]>;
}

export type DesignAdherenceFinding =
	| { literal: string; kind: "semantic"; token: string }
	| { literal: string; kind: "primitive"; token: string }
	| { literal: string; kind: "hsl" | "unknown" };

export interface DesignAdherenceResult {
	readonly findings: readonly DesignAdherenceFinding[];
	readonly more: number;
}

interface DesignIndexIO {
	stat(path: string): Promise<{ mtimeMs: number }>;
	readFile(path: string): Promise<string>;
}

interface CachedTokenSource {
	path: string;
	mtimeMs: number;
	tokens: readonly DesignToken[];
}

interface CachedIndex {
	manifestMtimeMs: number;
	manifest: DesignManifest;
	tokenSources: readonly CachedTokenSource[];
	index: DesignTokenIndex;
}

const defaultIO: DesignIndexIO = {
	stat: async path => fsStat(path),
	readFile: async path => fsReadFile(path, "utf8"),
};

const sourceCache = new Map<string, CachedTokenSource>();
const indexCache = new Map<string, CachedIndex>();

function canonicalHex(value: string): string | null {
	const match = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim());
	if (!match) return null;
	const hex = match[1]!.toLowerCase();
	if (hex.length === 3 || hex.length === 4) return `#${[...hex.slice(0, 3)].map(channel => channel + channel).join("")}`;
	return `#${hex.slice(0, 6)}`;
}

function rgbChannel(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed.endsWith("%")) {
		const percent = Number(trimmed.slice(0, -1));
		return Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent)) * 255 / 100) : null;
	}
	const channel = Number(trimmed);
	return Number.isFinite(channel) ? Math.round(Math.min(255, Math.max(0, channel))) : null;
}

function canonicalRgb(value: string): string | null {
	const match = /^rgba?\s*\(([^)]*)\)$/i.exec(value.trim());
	if (!match) return null;
	const channels = match[1]!.replaceAll("/", " ").split(/[\s,]+/).filter(Boolean);
	if (channels.length < 3 || channels.length > 4) return null;
	const rgb = channels.slice(0, 3).map(rgbChannel);
	if (rgb.some(channel => channel === null)) return null;
	return `#${rgb.map(channel => channel!.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalColor(value: string): string | null {
	return canonicalHex(value) ?? canonicalRgb(value);
}

function tokenKey(theme: DesignToken["theme"], name: string): string {
	return `${theme}:${name}`;
}

function resolveTokens(tokens: readonly DesignToken[]): ResolvedDesignToken[] {
	const byName = new Map<string, DesignToken[]>();
	const byThemeName = new Map<string, DesignToken[]>();
	for (const token of tokens) {
		byName.set(token.name, [...(byName.get(token.name) ?? []), token]);
		const key = tokenKey(token.theme, token.name);
		byThemeName.set(key, [...(byThemeName.get(key) ?? []), token]);
	}

	function resolveValue(token: DesignToken, stack: ReadonlySet<string>, hops: number): string | null {
		const value = token.value.trim();
		const variable = /^var\(\s*(--[\w-]+)\s*\)$/i.exec(value);
		if (!variable) return canonicalColor(value);
		if (hops >= MAX_VAR_HOPS) return null;
		const name = variable[1]!;
		const key = tokenKey(token.theme, name);
		if (stack.has(key)) return null;
		const reference = byThemeName.get(key)?.[0] ?? byName.get(name)?.[0];
		if (!reference) return null;
		return resolveValue(reference, new Set([...stack, key]), hops + 1);
	}

	return tokens.flatMap(token => {
		const key = tokenKey(token.theme, token.name);
		const value = resolveValue(token, new Set([key]), 0);
		return value ? [{ ...token, value }] : [];
	});
}

export function createDesignTokenIndex(tokens: readonly DesignToken[]): DesignTokenIndex {
	const resolved = resolveTokens(tokens);
	const byValue = new Map<string, ResolvedDesignToken[]>();
	for (const token of resolved) {
		const entries = byValue.get(token.value) ?? [];
		if (!entries.some(entry => entry.name === token.name && entry.layer === token.layer && entry.theme === token.theme)) entries.push(token);
		byValue.set(token.value, entries);
	}
	return { tokenFiles: [], tokens: resolved, byValue };
}

function sameSources(left: readonly CachedTokenSource[], right: readonly CachedTokenSource[]): boolean {
	return left.length === right.length && left.every((source, index) => source.path === right[index]!.path && source.mtimeMs === right[index]!.mtimeMs);
}

export async function buildDesignTokenIndex(cwd: string, io: DesignIndexIO = defaultIO): Promise<DesignTokenIndex | null> {
	try {
		const root = resolve(cwd);
		const manifestPath = resolve(root, DESIGN_DIR, DESIGN_MANIFEST_FILE);
		const manifestMtimeMs = (await io.stat(manifestPath)).mtimeMs;
		const cached = indexCache.get(root);
		if (cached?.manifestMtimeMs === manifestMtimeMs) {
			const currentSources = await Promise.all(cached.tokenSources.map(async source => ({
				path: source.path,
				mtimeMs: (await io.stat(source.path)).mtimeMs,
				tokens: source.tokens,
			})));
			if (sameSources(cached.tokenSources, currentSources)) return cached.index;
		}

		const manifest = parseDesignManifest(await io.readFile(manifestPath));
		if (!manifest) return null;
		const tokenPaths = [...new Set(manifest.tokenFiles.map(file => resolve(root, file)))];
		const tokenSources: CachedTokenSource[] = [];
		for (const path of tokenPaths) {
			const mtimeMs = (await io.stat(path)).mtimeMs;
			const cachedSource = sourceCache.get(path);
			const tokens = cachedSource?.mtimeMs === mtimeMs ? cachedSource.tokens : parseCssTokens(await io.readFile(path)).tokens;
			const source = { path, mtimeMs, tokens };
			sourceCache.set(path, source);
			tokenSources.push(source);
		}
		const index = {
			...createDesignTokenIndex(tokenSources.flatMap(source => source.tokens)),
			tokenFiles: [...manifest.tokenFiles],
		};
		indexCache.set(root, { manifestMtimeMs, manifest, tokenSources, index });
		return index;
	} catch {
		return null;
	}
}

interface LiteralMatch {
	literal: string;
	kind: "hex" | "rgb" | "hsl";
	index: number;
}

const hexPattern = /(?<![\w-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/gi;
const functionPattern = /(?<![\w-])(?:rgba?|hsla?)\s*\([^)]*\)/gi;

function literalMatches(text: string): LiteralMatch[] {
	const matches: LiteralMatch[] = [];
	for (const match of text.matchAll(hexPattern)) matches.push({ literal: match[0], kind: "hex", index: match.index ?? 0 });
	for (const match of text.matchAll(functionPattern)) {
		const kind = match[0]!.trimStart().toLowerCase().startsWith("hsl") ? "hsl" : "rgb";
		matches.push({ literal: match[0], kind, index: match.index ?? 0 });
	}
	return matches.sort((left, right) => left.index - right.index);
}

function classifyLiteral(match: LiteralMatch, index: DesignTokenIndex): DesignAdherenceFinding {
	if (match.kind === "hsl") return { literal: match.literal, kind: "hsl" };
	const canonical = match.kind === "hex" ? canonicalHex(match.literal) : canonicalRgb(match.literal);
	if (!canonical) return { literal: match.literal, kind: "unknown" };
	const tokens = index.byValue.get(canonical) ?? [];
	const semantic = tokens.find(token => token.layer === "semantic");
	if (semantic) return { literal: match.literal, kind: "semantic", token: semantic.name };
	const primitive = tokens.find(token => token.layer === "primitive");
	if (primitive) return { literal: match.literal, kind: "primitive", token: primitive.name };
	return { literal: match.literal, kind: "unknown" };
}

export function detectDesignAdherence(text: string, index: DesignTokenIndex): DesignAdherenceResult {
	if (Buffer.byteLength(text, "utf8") > MAX_ADHERENCE_TEXT_BYTES) return { findings: [], more: 0 };
	const findings: DesignAdherenceFinding[] = [];
	const seen = new Set<string>();
	let more = 0;
	for (const match of literalMatches(text)) {
		if (seen.has(match.literal)) continue;
		seen.add(match.literal);
		if (findings.length >= MAX_ADHERENCE_FINDINGS) {
			more++;
			continue;
		}
		findings.push(classifyLiteral(match, index));
	}
	return { findings, more };
}

export function formatDesignAdvisory(result: DesignAdherenceResult): string | undefined {
	if (result.findings.length === 0) return undefined;
	const lines = ["Design token advisory:"];
	for (const finding of result.findings) {
		if (finding.kind === "semantic") lines.push(`- ${finding.literal}: use var(${finding.token})`);
		else if (finding.kind === "primitive") lines.push(`- ${finding.literal}: use var(${finding.token}) (primitive token; prefer semantic alias)`);
		else if (finding.kind === "hsl") lines.push(`- ${finding.literal}: no exact suggestion; see docs/design/tokens.md`);
		else lines.push(`- ${finding.literal}: see docs/design/tokens.md`);
	}
	if (result.more > 0) lines.push(`- +${result.more} more`);
	return lines.join("\n");
}
