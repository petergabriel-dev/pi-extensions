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

export const BASH_MUTATION_DENY = /(^|[;&|()]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|cat\s*>|python|python3|node|perl|ruby|sh|bash|zsh|fish|npm\s+(i|install|add|update|audit\s+fix)|pnpm\s+(i|install|add|update)|yarn\s+(add|install|upgrade)|bun\s+(add|install)|pip\s+install|cargo\s+(add|update|install)|go\s+get|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash)|find\s+.*-delete|(?:format|fmt|fix|write|migrate|migration)(\s|$))/;
export const BASH_WRITE_REDIRECT = /(^|[^<])>(?!>?)|>>/;

export function isBashAllowedInMode(command: string, mode: "discuss" | "plan" | "review"): boolean {
	const normalized = command.trim().replace(/\s+/g, " ");
	const allowed = mode === "discuss" ? DISCUSS_BASH_ALLOW.test(normalized) : mode === "plan" ? PLAN_BASH_ALLOW.test(normalized) : REVIEW_BASH_ALLOW.test(command.trim());
	const denied = BASH_MUTATION_DENY.test(normalized) || BASH_WRITE_REDIRECT.test(normalized) || (mode === "review" && REVIEW_BASH_DENY.test(command));
	return allowed && !denied;
}
