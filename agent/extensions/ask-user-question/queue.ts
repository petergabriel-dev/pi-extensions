type QueueCancelReason = "batch-cancelled" | "aborted";

let queueTail: Promise<void> = Promise.resolve();
let pending = 0;
let batchCancelled = false;

export function cancelAskUserQuestionBatch(): void {
	if (pending > 0) batchCancelled = true;
}

export function askUserQuestionQueueDepth(): number {
	return pending;
}

export function withAskUserQuestionQueue<T>(
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
	onCancelled: (reason: QueueCancelReason) => T | Promise<T>,
): Promise<T> {
	pending += 1;
	const previous = queueTail;
	let release!: () => void;
	queueTail = new Promise<void>((resolve) => {
		release = resolve;
	});

	return previous
		.then(() => {
			// Re-check after waiting: a queued question may have been aborted while
			// another question owned the UI.
			if (batchCancelled) return onCancelled("batch-cancelled");
			if (signal?.aborted) return onCancelled("aborted");
			return run();
		})
		.finally(() => {
			pending -= 1;
			release();
			if (pending === 0) batchCancelled = false;
		});
}
