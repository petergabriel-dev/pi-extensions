export const DEFER_RESERVE_TOKENS = 16_384;

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
}

export interface ShouldDeferInput {
	usage: ContextUsage | null | undefined;
	status: string;
	mode: string;
	alreadyDeferred: boolean;
}

export interface DeferredAnswer {
	question: string;
	answer: string;
}

let pendingAnswers: DeferredAnswer[] = [];

export function shouldDefer({ usage, status, mode, alreadyDeferred }: ShouldDeferInput): boolean {
	if (alreadyDeferred || status !== "answered" || mode !== "tui" || usage?.tokens === null || usage === null || usage === undefined) {
		return false;
	}

	return usage.tokens > usage.contextWindow - DEFER_RESERVE_TOKENS;
}

export function recordAnswer(answer: DeferredAnswer): void {
	pendingAnswers.push({ ...answer });
}

export function buildResumeMessage(answers: readonly DeferredAnswer[] = pendingAnswers): string {
	const answerLines = answers.flatMap(({ question, answer }, index) => [
		`Question ${index + 1}: ${question}`,
		`Answer: ${answer}`,
	]);

	return [
		"Context threshold reached after ask_user_question answer.",
		"",
		...answerLines,
		"",
		"Resume the previous task using these answers.",
	].join("\n");
}

export function takePending(): DeferredAnswer[] | undefined {
	if (pendingAnswers.length === 0) return undefined;
	const answers = pendingAnswers;
	pendingAnswers = [];
	return answers;
}
