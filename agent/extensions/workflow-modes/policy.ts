import { createRequire } from "node:module";

export const READ_COMMANDS = String.raw`pwd|ls|find|rg|grep|cat|head|tail|wc|jq|tree|diff|stat|file|sort|uniq|column`;
export const READ_GIT_COMMANDS = String.raw`diff|log|show|status|blame`;
export const READ_SED_AWK = String.raw`sed\s+-n|awk`;

export const DISCUSS_BASH_ALLOW = new RegExp(
	String.raw`^((` + READ_COMMANDS + String.raw`)(\s|$)|git\s+(` + READ_GIT_COMMANDS + String.raw`)(\s|$)|` + READ_SED_AWK + String.raw`(\s|$)|ccc\s+search(\s|$))`,
);

export const PLAN_BASH_ALLOW = new RegExp(
	String.raw`^((` + READ_COMMANDS + String.raw`)(\s|$)|git\s+(` + READ_GIT_COMMANDS + String.raw`)(\s|$)|` + READ_SED_AWK + String.raw`(\s|$)|ccc\s+(search|index)(\s|$)|.*\b(test|tests|check|checks|lint|typecheck|tsc|build|compile|gradle|mvn|pytest|cargo test|go test|swift test)\b)`,
);

const REVIEW_ARG = String.raw`(?:'[^']*'|"[^"$\x60\\]*(?:\\.[^"$\x60\\]*)*"|[^\s;&|()<>\x60$]+)`;

export const REVIEW_BASH_ALLOW = new RegExp(
	String.raw`^(?:((` + READ_COMMANDS + String.raw`)|awk)|git[ \t]+(` + READ_GIT_COMMANDS + String.raw`)|sed[ \t]+-n|ccc[ \t]+search|gh[ \t]+pr[ \t]+(view|diff|list|review|comment|status|checks))(?:[ \t]+` + REVIEW_ARG + String.raw`)*[ \t]*$`,
);

export const REVIEW_BASH_DENY = /(^|[;&|()]\s*)(curl|wget|nc|ssh|scp)(\s|$)|(^|[;&|()]\s*)gh\s+(pr\s+(merge|close)|repo)(\s|$)/;

export const BASH_MUTATION_DENY = /(^|[;&|()]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|cat\s*>|python|python3|node|perl|ruby|sh|bash|zsh|fish|npm\s+(i|install|add|update|audit\s+fix)|pnpm\s+(i|install|add|update)|yarn\s+(add|install|upgrade)|bun\s+(add|install)|pip\s+install|cargo\s+(add|update|install)|go\s+get|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|apply|am|config)|git\s+diff\b[^;&|]*--output|find\s+.*-delete|find\s+.*-(?:exec|execdir|ok|okdir)\b|xargs|awk\s+.*system\s*\(|(?:format|fmt|fix|write|migrate|migration)(\s|$))|\$\(|`/;
export const BASH_WRITE_REDIRECT = />>|<>|(^|[^<])>/;

export interface CommandConfirmationUI {
	confirm(title: string, message?: string): Promise<boolean>;
}

export type ReviewPostConfirmationUI = CommandConfirmationUI;

export function isReviewPostingCommand(command: string): boolean {
	return /^gh[ \t]+pr[ \t]+(?:review|comment)(?=[ \t]|$)/.test(command.trim());
}

export function sanitizeReviewCommand(command: string): string {
	return command.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) => {
		const codePoint = character.codePointAt(0)!;
		const prefix = codePoint <= 0xff ? "\\x" : "\\u";
		return `${prefix}${codePoint.toString(16).padStart(prefix === "\\x" ? 2 : 4, "0").toUpperCase()}`;
	});
}

// Fresh human approval for one exact command: only literal true from an
// awaited confirm with live UI approves. Never cached; decline, headless,
// cancel, or dialog error all return false.
export async function confirmCommand(title: string, command: string, hasUI: boolean, ui?: CommandConfirmationUI): Promise<boolean> {
	if (hasUI !== true || !ui) return false;
	try {
		return (await ui.confirm(title, sanitizeReviewCommand(command))) === true;
	} catch {
		return false;
	}
}

export async function confirmReviewPost(command: string, hasUI: boolean, ui?: ReviewPostConfirmationUI): Promise<boolean> {
	if (!isReviewPostingCommand(command)) return true;
	return confirmCommand("Post this GitHub review?", command, hasUI, ui);
}

export type PlanFallbackDecision = "allow" | "confirm" | "deny";

// No-sandbox fallback normalization. Newlines separate commands in bash, so map
// them to ";" before collapsing whitespace; otherwise deny lists miss later lines.
function normalizeFallbackCommand(command: string): string {
	return command.trim().replace(/[\r\n]+/g, "; ").replace(/\s+/g, " ");
}

function isFallbackDenied(normalized: string): boolean {
	return BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized);
}

type ShellPermission = "allow" | "ask" | "deny";
type ShellClassifier = (command: string) => { permission?: unknown } | undefined;

// Reuse the shipped Cursor hook's segment classifier, which carries per-command
// flag checks (rg --pre, sort -o, find -fprint, git --output, ...), instead of a
// second Pi copy. A missing or throwing classifier denies.
const requireShipped = createRequire(import.meta.url);
const cursorClassifyShell: ShellClassifier | undefined = (() => {
	try {
		const hook = requireShipped("../../cursor-bridge-client/cursor-readonly-hook.js") as { classifyShell?: unknown };
		return typeof hook.classifyShell === "function" ? hook.classifyShell as ShellClassifier : undefined;
	} catch {
		return undefined;
	}
})();

function classifyFallbackShell(command: string): ShellPermission {
	if (!cursorClassifyShell) return "deny";
	try {
		const permission = cursorClassifyShell(command)?.permission;
		return permission === "allow" || permission === "ask" ? permission : "deny";
	} catch {
		return "deny";
	}
}

// F9/F12: without a structural sandbox, Pi deny lists run first, then the Cursor
// classifier decides. Allowlisted reads (and pipes of them) run; other read- or
// test/build-shaped commands need fresh human approval; everything else denies.
// Multi-line commands deny so a confirm prompt can never hide a later line.
export function planFallbackDecision(command: string): PlanFallbackDecision {
	const trimmed = command.trim();
	if (/[\r\n]/.test(trimmed)) return "deny";
	const normalized = normalizeFallbackCommand(trimmed);
	if (isFallbackDenied(normalized)) return "deny";
	const permission = classifyFallbackShell(trimmed);
	if (permission === "allow") return "allow";
	if (permission === "deny") return "deny";
	return DISCUSS_BASH_ALLOW.test(normalized) || PLAN_BASH_ALLOW.test(normalized) ? "confirm" : "deny";
}

// No-sandbox fallback: true only when the command may run without approval.
export function isBashAllowedInMode(command: string, mode: "discuss" | "plan" | "review"): boolean {
	if (mode === "plan") return planFallbackDecision(command) === "allow";
	if (mode === "discuss") {
		const trimmed = command.trim();
		return !isFallbackDenied(normalizeFallbackCommand(trimmed)) && classifyFallbackShell(trimmed) === "allow";
	}
	const normalized = command.trim().replace(/\s+/g, " ");
	const allowed = REVIEW_BASH_ALLOW.test(command.trim());
	const denied = BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized) || REVIEW_BASH_DENY.test(command);
	return allowed && !denied;
}

export const BUILD_GUARD_FAILED_BLOCKER = "an unverified writer (Build guard check failed)";

// Fails closed: a listener error blocks with any blocker it already set, or a
// generic one. No listener (bridge not installed) means no blocker.
export function getBuildGuardBlocker(emit: (payload: { blockedBy?: string }) => void): string | undefined {
	const payload: { blockedBy?: string } = {};
	try {
		emit(payload);
	} catch {
		return typeof payload.blockedBy === "string" && payload.blockedBy.length > 0 ? payload.blockedBy : BUILD_GUARD_FAILED_BLOCKER;
	}
	return typeof payload.blockedBy === "string" && payload.blockedBy.length > 0 ? payload.blockedBy : undefined;
}
