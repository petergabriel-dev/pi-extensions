import { isDesignSurfacePath, loadDesignManifest } from "../engineering-docs/design.js";

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
export const BASH_WRITE_REDIRECT = />>|(^|[^<])>/;

export interface ReviewPostConfirmationUI {
	confirm(title: string, message?: string): Promise<boolean>;
}

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

export async function confirmReviewPost(command: string, hasUI: boolean, ui?: ReviewPostConfirmationUI): Promise<boolean> {
	if (!isReviewPostingCommand(command)) return true;
	if (hasUI !== true || !ui) return false;
	try {
		return (await ui.confirm("Post this GitHub review?", sanitizeReviewCommand(command))) === true;
	} catch {
		return false;
	}
}

export async function isDesignWriteAllowed(cwd: string, filePath: string): Promise<boolean> {
	return isDesignSurfacePath(cwd, filePath, await loadDesignManifest(cwd));
}

export function isBashAllowedInMode(command: string, mode: "discuss" | "plan" | "review" | "design"): boolean {
	const normalized = command.trim().replace(/\s+/g, " ");
	const allowed = mode === "discuss" ? DISCUSS_BASH_ALLOW.test(normalized) : mode === "review" ? REVIEW_BASH_ALLOW.test(command.trim()) : PLAN_BASH_ALLOW.test(normalized);
	const denied = BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized) || (mode === "review" && REVIEW_BASH_DENY.test(command));
	return allowed && !denied;
}

export function getBuildGuardBlocker(emit: (payload: { blockedBy?: string }) => void): string | undefined {
	const payload: { blockedBy?: string } = {};
	try {
		emit(payload);
	} catch {
		return undefined;
	}
	return typeof payload.blockedBy === "string" && payload.blockedBy.length > 0 ? payload.blockedBy : undefined;
}
