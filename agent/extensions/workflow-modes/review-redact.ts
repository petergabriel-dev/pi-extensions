// Pure secret redaction for review evidence. Every persisted review artifact
// (bundles, reviews.jsonl, subagent summaries) must pass through redactText
// before it is written. Redact before truncating: this module truncates only
// as a work bound.

export const MAX_REDACT_INPUT_BYTES = 256 * 1024;
export const REDACTED_ENV = "[REDACTED:env]";
export const REDACTED_PATTERN = "[REDACTED:pattern]";

// AUTH counts only as a whole name segment so GIT_AUTHOR_* values are not
// treated as secrets; KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL match anywhere.
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)AUTH(?:_|$)/i;
const SECRET_ASSIGNMENT_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
const MIN_ENV_SECRET_LENGTH = 8;
const MIN_PARTIAL_TAIL = 4;
const MARKER = "[REDACTED:";

export interface RedactionResult {
	text: string;
	redactions: number;
	truncated: boolean;
}

// groups[0] is the whole match; undefined means "leave unchanged".
type Rule = { pattern: RegExp; replace: (groups: string[]) => string | undefined };

// Every quantifier is bounded (or linear) so adversarial input cannot trigger catastrophic backtracking.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

const RULES: Rule[] = [
	{ pattern: /\bsk-[A-Za-z0-9_-]{16,256}/g, replace: () => REDACTED_PATTERN },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}/g, replace: () => REDACTED_PATTERN },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}/g, replace: () => REDACTED_PATTERN },
	{ pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: () => REDACTED_PATTERN },
	{ pattern: /\b(Bearer)\s{1,8}[A-Za-z0-9._~+/=-]{16,4096}/gi, replace: (g) => `${g[1]} ${REDACTED_PATTERN}` },
	{
		pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:/@]{1,256}:[^\s@/]{1,256})@/gi,
		replace: (g) => (g[2].includes(MARKER) ? undefined : `${g[1]}${REDACTED_PATTERN}@`),
	},
	{
		pattern: /\b([A-Za-z0-9_.-]{1,128})=("[^"\n]{1,4096}"|'[^'\n]{1,4096}'|[^\s"'&;]{1,4096})/g,
		replace: (g) => (SECRET_ASSIGNMENT_NAME.test(g[1]) && !g[2].includes(MARKER) ? `${g[1]}=${REDACTED_PATTERN}` : undefined),
	},
	{
		pattern: /"([A-Za-z0-9_.-]{1,128})"(\s{0,4}:\s{0,4})"([^"\n]{1,4096})"/g,
		replace: (g) => (SECRET_ASSIGNMENT_NAME.test(g[1]) && !g[3].includes(MARKER) ? `"${g[1]}"${g[2]}"${REDACTED_PATTERN}"` : undefined),
	},
];

export function secretEnvValues(env: Readonly<Record<string, string | undefined>>): string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || !SECRET_ENV_NAME.test(name)) continue;
		if (value.trim().length < MIN_ENV_SECRET_LENGTH) continue;
		values.add(value);
	}
	// Longest first so a secret containing another secret is replaced whole.
	return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, env: Readonly<Record<string, string | undefined>> = {}): RedactionResult {
	if (typeof text !== "string") throw new TypeError("redactText expects a string");
	let output = text;
	let truncated = false;
	if (Buffer.byteLength(output, "utf8") > MAX_REDACT_INPUT_BYTES) {
		output = Buffer.from(output, "utf8").subarray(0, MAX_REDACT_INPUT_BYTES).toString("utf8");
		truncated = true;
	}

	let redactions = 0;
	const secrets = secretEnvValues(env);
	for (const secret of secrets) {
		const parts = output.split(secret);
		if (parts.length > 1) {
			redactions += parts.length - 1;
			output = parts.join(REDACTED_ENV);
		}
	}
	if (truncated) {
		// The byte cap may cut an env secret; mask a trailing prefix of one.
		for (const secret of secrets) {
			const tail = partialPrefixAtEnd(output, secret);
			if (tail > 0) {
				output = output.slice(0, -tail) + REDACTED_ENV;
				redactions += 1;
				break;
			}
		}
	}

	const keys = redactPrivateKeys(output);
	output = keys.text;
	redactions += keys.redactions;

	for (const rule of RULES) {
		output = output.replace(rule.pattern, (...args: unknown[]) => {
			const offsetIndex = args.findIndex((arg) => typeof arg === "number");
			const groups = args.slice(0, offsetIndex) as string[];
			const replacement = rule.replace(groups);
			if (replacement === undefined) return groups[0];
			redactions += 1;
			return replacement;
		});
	}

	return { text: output, redactions, truncated };
}

// Linear scan: each BEGIN either pairs with the next END or, if none remains,
// redacts to end of text (a truncated or unterminated block).
function redactPrivateKeys(text: string): { text: string; redactions: number } {
	let output = "";
	let cursor = 0;
	let redactions = 0;
	PEM_BEGIN.lastIndex = 0;
	for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
		PEM_END.lastIndex = PEM_BEGIN.lastIndex;
		const end = PEM_END.exec(text);
		output += text.slice(cursor, begin.index) + REDACTED_PATTERN;
		redactions += 1;
		if (!end) return { text: output, redactions };
		cursor = PEM_END.lastIndex;
		PEM_BEGIN.lastIndex = cursor;
	}
	return { text: output + text.slice(cursor), redactions };
}

function partialPrefixAtEnd(text: string, secret: string): number {
	for (let length = Math.min(secret.length - 1, text.length); length >= MIN_PARTIAL_TAIL; length -= 1) {
		if (text.endsWith(secret.slice(0, length))) return length;
	}
	return 0;
}

export function isSensitivePath(path: string): boolean {
	if (typeof path !== "string" || path.length === 0) return false;
	const base = path.split(/[\\/]/).pop() ?? "";
	const lower = base.toLowerCase();
	return lower.startsWith(".env") || lower.endsWith(".pem") || lower.endsWith(".key") || lower.startsWith("id_");
}
