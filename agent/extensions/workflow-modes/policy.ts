export const READ_COMMANDS = String.raw`pwd|ls|find|rg|grep|cat|head|tail|wc|jq|tree|diff|stat|file|sort|uniq|column`;
export const READ_GIT_COMMANDS = String.raw`diff|log|show|status|blame`;

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

// Characters a dialog can hide or reorder: C0 controls except newline, DEL/C1,
// format characters (zero-width, bidi, BOM, soft hyphen), non-ASCII spaces,
// line/paragraph separators, and fillers that render blank (Hangul, braille).
const HIDDEN_CHARACTER = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]|(?! )\p{Zs}/gu;

export function sanitizeReviewCommand(command: string): string {
	return command.replace(HIDDEN_CHARACTER, (character) => {
		const codePoint = character.codePointAt(0)!;
		const hex = codePoint.toString(16).toUpperCase();
		if (codePoint <= 0x9f) return `\\x${hex.padStart(2, "0")}`;
		return codePoint <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
	});
}

// Shows the command exactly as it will run, with control characters escaped and
// runs of 4+ spaces marked, so padding cannot push part of it out of the dialog.
// Display only: the original command still runs unchanged.
export function formatCommandForConfirm(command: string): string {
	return sanitizeReviewCommand(command).replace(/ {4,}/g, (run) => ` [${run.length} spaces] `);
}

// Fresh human approval for one exact command: only literal true from an
// awaited confirm with live UI approves. Never cached; decline, headless,
// cancel, or dialog error all return false.
export async function confirmCommand(title: string, command: string, hasUI: boolean, ui?: CommandConfirmationUI): Promise<boolean> {
	if (hasUI !== true || !ui) return false;
	try {
		return (await ui.confirm(title, formatCommandForConfirm(command))) === true;
	} catch {
		return false;
	}
}

export async function confirmReviewPost(command: string, hasUI: boolean, ui?: ReviewPostConfirmationUI): Promise<boolean> {
	if (!isReviewPostingCommand(command)) return true;
	return confirmCommand("Post this GitHub review?", command, hasUI, ui);
}

export type PlanFallbackDecision = "confirm" | "deny";

// F9/F12: without a structural sandbox Pi never auto-runs bash. Classifying a
// command as a safe read kept leaking writing flags, so Plan denies multi-line
// commands (a confirm prompt could hide a line) and deny-list matches, and asks a
// human for every other single-line command. Approval never overrides a deny.
export function planFallbackDecision(command: string): PlanFallbackDecision {
	const trimmed = command.trim();
	if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return "deny";
	const normalized = trimmed.replace(/\s+/g, " ");
	if (BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized)) return "deny";
	return "confirm";
}

// Review allow-list: true when Review may run the command at all (sandboxed, or
// after approval without a sandbox). Discuss and Plan have no allow-list.
export function isBashAllowedInMode(command: string, mode: "discuss" | "plan" | "review"): boolean {
	if (mode !== "review") return false;
	const normalized = command.trim().replace(/\s+/g, " ");
	const allowed = REVIEW_BASH_ALLOW.test(command.trim());
	const denied = BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized) || REVIEW_BASH_DENY.test(command);
	return allowed && !denied;
}

// The one no-sandbox rule (no launcher, or wrapping failed), shared by the
// tool_call handler and the security corpus. There is no "allow": without a
// sandbox Pi never auto-runs bash. Discuss denies; Plan and Review (within its
// allow-list) ask a human for each single-line command no deny list catches.
export function noSandboxDecision(mode: "discuss" | "plan" | "review", command: string): PlanFallbackDecision {
	if (mode === "discuss") return "deny";
	if (mode === "review" && !isBashAllowedInMode(command, "review")) return "deny";
	return planFallbackDecision(command);
}

export const BUILD_GUARD_FAILED_BLOCKER = "an unverified writer (Build guard check failed); retry, or restart this Pi session if it persists";

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
