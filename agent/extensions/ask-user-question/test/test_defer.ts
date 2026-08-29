import assert from "node:assert/strict";
import { buildResumeMessage, recordAnswer, shouldDefer, takePending } from "../defer.ts";

const usage = { tokens: 100_000, contextWindow: 100_000 };
const threshold = usage.contextWindow - 16_384;

function main(): void {
	assert.equal(
		shouldDefer({ usage: { ...usage, tokens: threshold - 1 }, status: "answered", mode: "tui", alreadyDeferred: false }),
		false,
	);
	assert.equal(
		shouldDefer({ usage: { ...usage, tokens: threshold }, status: "answered", mode: "tui", alreadyDeferred: false }),
		false,
	);
	assert.equal(shouldDefer({ usage: { ...usage, tokens: null }, status: "answered", mode: "tui", alreadyDeferred: false }), false);
	for (const status of ["cancelled", "skipped", "unavailable"]) {
		assert.equal(shouldDefer({ usage, status, mode: "tui", alreadyDeferred: false }), false, `${status} must not defer`);
	}
	assert.equal(shouldDefer({ usage, status: "answered", mode: "rpc", alreadyDeferred: false }), false);
	assert.equal(shouldDefer({ usage, status: "answered", mode: "tui", alreadyDeferred: true }), false);
	assert.equal(shouldDefer({ usage: undefined, status: "answered", mode: "tui", alreadyDeferred: false }), false);

	recordAnswer({ question: "Single question", answer: "Single answer" });
	assert.equal(buildResumeMessage().includes("Single question"), true);
	assert.equal(takePending()?.length, 1);
	assert.equal(takePending(), undefined);

	const batch = [
		{ question: "First question", answer: "First answer" },
		{ question: "Second question", answer: "Second answer" },
		{ question: "Third question", answer: "Third answer" },
	];
	let alreadyDeferred = false;
	let deferCount = 0;
	for (const answer of batch) {
		const defer = shouldDefer({ usage, status: "answered", mode: "tui", alreadyDeferred });
		if (defer) {
			deferCount += 1;
			alreadyDeferred = true;
		}
		if (alreadyDeferred) recordAnswer(answer);
	}

	assert.equal(deferCount, 1);
	const pending = takePending();
	assert.deepEqual(pending, batch);
	assert.ok(pending);
	const message = buildResumeMessage(pending);
	for (const answer of batch) {
		assert.match(message, new RegExp(answer.question));
		assert.match(message, new RegExp(answer.answer));
	}
	assert.match(message, /Resume the previous task using these answers\./);
	assert.equal(takePending(), undefined);

	console.log("ask-user-question defer tests passed");
}

try {
	main();
} catch (error: unknown) {
	console.error(error);
	process.exitCode = 1;
}
