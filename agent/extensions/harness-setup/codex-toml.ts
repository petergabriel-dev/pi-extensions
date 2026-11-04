// Minimal, dependency-free editor for the one Pi-owned table in Codex's config.toml:
// [mcp_servers.pi-claude-bridge]. Codex and its desktop app rewrite other parts of the file
// (hook trust under [hooks.state.*], projects, desktop prefs), so every byte outside this
// table must survive. Anything this scanner cannot read with certainty is reported as
// unsupported and left untouched.

export const CODEX_BRIDGE_TABLE = ["mcp_servers", "pi-claude-bridge"] as const;
export const CODEX_MCP_APPROVAL = "approve";

export interface BridgeTable {
	kind: "table";
	/** Line index of the table header. */
	start: number;
	/** Last line index that belongs to a key/value of the table (trailing blanks/comments excluded). */
	end: number;
	values: Map<string, unknown>;
	entries: Array<{ key: string | null; first: number; last: number }>;
}

export type BridgeTableScan = { kind: "absent" } | { kind: "unsupported"; reason: string } | BridgeTable;

class TomlScanError extends Error {}

function splitLines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

function eolOf(text: string | null): string {
	return text?.includes("\r\n") ? "\r\n" : "\n";
}

// Parses a dotted key (bare, "basic", or 'literal' parts) from `src` at `pos`; stops at `stop`.
function parseKey(src: string, pos: number, stop: string): { parts: string[]; pos: number } {
	const parts: string[] = [];
	for (;;) {
		while (src[pos] === " " || src[pos] === "\t") pos++;
		if (src[pos] === '"' || src[pos] === "'") {
			const parsed = parseString(src, pos);
			parts.push(parsed.value);
			pos = parsed.pos;
		} else {
			const match = /^[A-Za-z0-9_-]+/.exec(src.slice(pos));
			if (!match) throw new TomlScanError("invalid key");
			parts.push(match[0]);
			pos += match[0].length;
		}
		while (src[pos] === " " || src[pos] === "\t") pos++;
		if (src[pos] === ".") {
			pos++;
			continue;
		}
		if (src.startsWith(stop, pos)) return { parts, pos: pos + stop.length };
		throw new TomlScanError("unterminated key");
	}
}

function parseString(src: string, pos: number): { value: string; pos: number } {
	const quote = src[pos];
	if (src.startsWith(quote.repeat(3), pos)) {
		const close = src.indexOf(quote.repeat(3), pos + 3);
		if (close < 0) throw new TomlScanError("unterminated multi-line string");
		let end = close + 3;
		while (src[end] === quote && end - close < 5) end++; // up to two quotes may precede the delimiter
		return { value: src.slice(pos + 3, end - 3), pos: end };
	}
	if (quote === "'") {
		const close = src.indexOf("'", pos + 1);
		if (close < 0 || src.slice(pos + 1, close).includes("\n")) throw new TomlScanError("unterminated literal string");
		return { value: src.slice(pos + 1, close), pos: close + 1 };
	}
	let value = "";
	let i = pos + 1;
	for (; i < src.length; i++) {
		const char = src[i];
		if (char === '"') return { value, pos: i + 1 };
		if (char === "\n") break;
		if (char !== "\\") {
			value += char;
			continue;
		}
		const next = src[++i];
		const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
		if (next in simple) value += simple[next];
		else if (next === "u" || next === "U" || next === "x") {
			const width = next === "u" ? 4 : next === "U" ? 8 : 2;
			const hex = src.slice(i + 1, i + 1 + width);
			if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) throw new TomlScanError("invalid escape");
			value += String.fromCodePoint(Number.parseInt(hex, 16));
			i += width;
		} else throw new TomlScanError("invalid escape");
	}
	throw new TomlScanError("unterminated string");
}

function skipSpaceAndComments(src: string, pos: number): number {
	for (;;) {
		while (pos < src.length && /[ \t\r\n]/.test(src[pos])) pos++;
		if (src[pos] !== "#") return pos;
		while (pos < src.length && src[pos] !== "\n") pos++;
	}
}

// Parses one TOML value. Strings and string arrays are decoded; other scalars and inline
// tables are skipped (returned as an opaque marker) because the bridge table never needs them.
function parseValue(src: string, pos: number): { value: unknown; pos: number } {
	const char = src[pos];
	if (char === '"' || char === "'") return parseString(src, pos);
	if (char === "[") {
		const items: unknown[] = [];
		pos++;
		for (;;) {
			pos = skipSpaceAndComments(src, pos);
			if (src[pos] === "]") return { value: items, pos: pos + 1 };
			const item = parseValue(src, pos);
			items.push(item.value);
			pos = skipSpaceAndComments(src, item.pos);
			if (src[pos] === ",") pos++;
			else if (src[pos] !== "]") throw new TomlScanError("invalid array");
		}
	}
	if (char === "{") {
		let depth = 0;
		for (let i = pos; i < src.length; i++) {
			if (src[i] === '"' || src[i] === "'") {
				i = parseString(src, i).pos - 1;
				continue;
			}
			if (src[i] === "\n") break;
			if (src[i] === "{") depth++;
			if (src[i] === "}" && --depth === 0) return { value: { opaque: "inline-table" }, pos: i + 1 };
		}
		throw new TomlScanError("unterminated inline table");
	}
	const match = /^[^\s,\]}#]+/.exec(src.slice(pos));
	if (!match) throw new TomlScanError("missing value");
	return { value: { opaque: match[0] }, pos: pos + match[0].length };
}

function sameParts(parts: string[], expected: readonly string[]): boolean {
	return parts.length === expected.length && parts.every((part, index) => part === expected[index]);
}

function startsWithParts(parts: string[], prefix: readonly string[]): boolean {
	return parts.length >= prefix.length && prefix.every((part, index) => parts[index] === part);
}

/** Locates [mcp_servers.pi-claude-bridge] and decodes its key/values; never throws. */
export function scanBridgeTable(text: string): BridgeTableScan {
	try {
		return scan(text);
	} catch (error) {
		return { kind: "unsupported", reason: `config.toml could not be read safely (${error instanceof Error ? error.message : String(error)}); preserve it.` };
	}
}

function scan(text: string): BridgeTableScan {
	const lines = splitLines(text);
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length;
	}
	const lineAt = (pos: number): number => {
		let index = 0;
		while (index + 1 < offsets.length && offsets[index + 1] <= pos) index++;
		return index;
	};
	let table: string[] = [];
	let found: BridgeTable | undefined;
	let pos = 0;
	while (pos < text.length) {
		pos = skipSpaceAndComments(text, pos);
		if (pos >= text.length) break;
		const lineIndex = lineAt(pos);
		if (text[pos] === "[") {
			const isArray = text[pos + 1] === "[";
			const key = parseKey(text, pos + (isArray ? 2 : 1), isArray ? "]]" : "]");
			pos = key.pos;
			const rest = /^[ \t]*(#[^\n]*)?(\r?\n|$)/.exec(text.slice(pos));
			if (!rest) throw new TomlScanError("text after table header");
			pos += rest[0].length;
			table = key.parts;
			// [[mcp_servers]] makes mcp_servers an array; an appended [mcp_servers.pi-claude-bridge]
			// would then nest under its last element instead of defining the server.
			if (isArray && sameParts(table, ["mcp_servers"])) {
				return { kind: "unsupported", reason: "mcp_servers is an array of tables; preserve config and review manually." };
			}
			if (!isArray && sameParts(table, CODEX_BRIDGE_TABLE)) {
				if (found) return { kind: "unsupported", reason: "Duplicate [mcp_servers.pi-claude-bridge] tables; preserve config." };
				found = { kind: "table", start: lineIndex, end: lineIndex, values: new Map(), entries: [] };
			} else if (startsWithParts(table, CODEX_BRIDGE_TABLE)) {
				return { kind: "unsupported", reason: "pi-claude-bridge has sub-tables; preserve config and review manually." };
			}
			continue;
		}
		const key = parseKey(text, pos, "=");
		const full = [...table, ...key.parts];
		pos = skipSpaceAndComments(text, key.pos);
		const valueStart = pos;
		const value = parseValue(text, pos);
		pos = value.pos;
		const rest = /^[ \t]*(#[^\n]*)?(\r?\n|$)/.exec(text.slice(pos));
		if (!rest) throw new TomlScanError("text after value");
		pos += rest[0].length;
		const lastLine = lineAt(Math.max(valueStart, pos - 1));
		const inOwned = found !== undefined && sameParts(table, CODEX_BRIDGE_TABLE);
		if (inOwned) {
			if (key.parts.length !== 1) return { kind: "unsupported", reason: "pi-claude-bridge uses dotted keys; preserve config and review manually." };
			found!.values.set(key.parts[0], value.value);
			found!.entries.push({ key: key.parts[0], first: lineIndex, last: lastLine });
			found!.end = lastLine;
		} else if (startsWithParts(full, CODEX_BRIDGE_TABLE)) {
			return { kind: "unsupported", reason: "pi-claude-bridge is defined in an unsupported form; preserve config and review manually." };
		} else if (sameParts(full, ["mcp_servers"])) {
			// An inline table (or any value) is closed: TOML forbids adding [mcp_servers.pi-claude-bridge] to it.
			return { kind: "unsupported", reason: "mcp_servers is set as a single value; preserve config and review manually." };
		}
	}
	return found ?? { kind: "absent" };
}

export function tomlString(value: string): string {
	return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

export function bridgeTableTarget(table: BridgeTable): string | undefined {
	const args = table.values.get("args");
	return table.values.get("command") === "node" && Array.isArray(args) && args.length === 1 && typeof args[0] === "string" ? args[0] : undefined;
}

function canonicalLines(target: string, eol: string): Record<"command" | "args" | "default_tools_approval_mode", string> {
	return {
		command: `command = "node"${eol}`,
		args: `args = [${tomlString(target)}]${eol}`,
		default_tools_approval_mode: `default_tools_approval_mode = ${tomlString(CODEX_MCP_APPROVAL)}${eol}`,
	};
}

export type BridgeTablePlan = { kind: "unchanged" } | { kind: "change"; after: string } | { kind: "skip"; reason: string };

/**
 * Plans the minimal edit of config.toml text (null when the file is absent).
 * `isOwned` decides whether an existing table's node target belongs to this package.
 */
export function planBridgeTable(text: string | null, target: string, install: boolean, isOwned: (target: string) => boolean): BridgeTablePlan {
	const source = text ?? "";
	const eol = eolOf(text);
	const scan = scanBridgeTable(source);
	if (scan.kind === "unsupported") return { kind: "skip", reason: scan.reason };
	if (scan.kind === "absent") {
		if (!install) return { kind: "unchanged" };
		const lines = canonicalLines(target, eol);
		const block = `[mcp_servers.pi-claude-bridge]${eol}${lines.command}${lines.args}${lines.default_tools_approval_mode}`;
		if (source.length === 0) return { kind: "change", after: block };
		const terminated = /\r?\n$/.test(source) ? source : `${source}${eol}`;
		return { kind: "change", after: `${terminated}${eol}${block}` };
	}
	const current = bridgeTableTarget(scan);
	if (current === undefined || !isOwned(current)) {
		return { kind: "skip", reason: "Existing [mcp_servers.pi-claude-bridge] is not owned by this package; preserve it." };
	}
	const lines = splitLines(source);
	const before = lines.slice(0, scan.start);
	const after = lines.slice(scan.end + 1);
	if (!install) {
		// Drop the blank separator that install added, so install+uninstall round-trips.
		if (before.length > 0 && before[before.length - 1].trim() === "" && (after.length === 0 || after[0].trim() === "")) before.pop();
		return { kind: "change", after: [...before, ...after].join("") };
	}
	if (current === target && scan.values.get("default_tools_approval_mode") === CODEX_MCP_APPROVAL) return { kind: "unchanged" };
	const wanted = canonicalLines(target, eol);
	const header = lines[scan.start];
	const body: string[] = [];
	const emitted = new Set<string>();
	let cursor = scan.start + 1;
	for (const entry of scan.entries) {
		body.push(...lines.slice(cursor, entry.first)); // blank/comment lines between entries
		const key = entry.key as keyof typeof wanted;
		// Own keys only: `in` would match prototype names such as toString and emit function text.
		if (Object.hasOwn(wanted, key) && !emitted.has(key)) {
			body.push(wanted[key]);
			emitted.add(key);
		} else body.push(...lines.slice(entry.first, entry.last + 1));
		cursor = entry.last + 1;
	}
	for (const key of Object.keys(wanted) as Array<keyof typeof wanted>) {
		if (!emitted.has(key)) body.push(wanted[key]);
	}
	const lastBody = body[body.length - 1];
	if (lastBody !== undefined && !/\n$/.test(lastBody)) body[body.length - 1] = `${lastBody}${eol}`;
	return { kind: "change", after: [...before, header.endsWith("\n") ? header : `${header}${eol}`, ...body, ...after].join("") };
}
