import assert from "node:assert/strict";
import { cancelAskUserQuestionBatch, withAskUserQuestionQueue } from "../queue.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function main(): Promise<void> {
{
	const order: string[] = [];
	const first = deferred<string>();
	const firstResult = withAskUserQuestionQueue(
		undefined,
		async () => {
			order.push("first-start");
			const value = await first.promise;
			order.push("first-end");
			return value;
		},
		() => "cancelled",
	);
	const secondResult = withAskUserQuestionQueue(
		undefined,
		async () => {
			order.push("second");
			return "second";
		},
		() => "cancelled",
	);
	const thirdResult = withAskUserQuestionQueue(
		undefined,
		async () => {
			order.push("third");
			return "third";
		},
		() => "cancelled",
	);

	await flush();
	assert.deepEqual(order, ["first-start"]);
	first.resolve("first");
	assert.deepEqual(await Promise.all([firstResult, secondResult, thirdResult]), ["first", "second", "third"]);
	assert.deepEqual(order, ["first-start", "first-end", "second", "third"]);
}

{
	const active = deferred<string>();
	const activeResult = withAskUserQuestionQueue(
		undefined,
		async () => active.promise,
		() => "cancelled",
	);
	await flush();

	let rendered = 0;
	const queuedResults = [0, 1].map(() =>
		withAskUserQuestionQueue(
			undefined,
			async () => {
				rendered += 1;
				return "rendered";
			},
			(reason) => `cancelled:${reason}`,
		),
	);
	cancelAskUserQuestionBatch();
	active.resolve("active");

	assert.equal(await activeResult, "active");
	assert.deepEqual(await Promise.all(queuedResults), ["cancelled:batch-cancelled", "cancelled:batch-cancelled"]);
	assert.equal(rendered, 0, "batch cancellation must not invoke queued render callbacks");

	let resetRan = false;
	assert.equal(
		await withAskUserQuestionQueue(
			undefined,
			async () => {
				resetRan = true;
				return "after-reset";
			},
			() => "cancelled",
		),
		"after-reset",
	);
	assert.equal(resetRan, true, "batch cancellation flag must reset after queue drains");
}

{
	const active = deferred<string>();
	const activeResult = withAskUserQuestionQueue(
		undefined,
		async () => active.promise,
		() => "cancelled",
	);
	await flush();

	const controller = new AbortController();
	let rendered = false;
	const queuedResult = withAskUserQuestionQueue(
		controller.signal,
		async () => {
			rendered = true;
			return "rendered";
		},
		(reason) => `cancelled:${reason}`,
	);
	controller.abort();
	active.resolve("active");

	assert.equal(await activeResult, "active");
	assert.equal(await queuedResult, "cancelled:aborted");
	assert.equal(rendered, false, "abort re-check must prevent queued rendering");
}

{
	const order: string[] = [];
	const first = withAskUserQuestionQueue(
		undefined,
		async () => {
			order.push("skip");
			return "skipped";
		},
		() => "cancelled",
	);
	const second = withAskUserQuestionQueue(
		undefined,
		async () => {
			order.push("next");
			return "answered";
		},
		() => "cancelled",
	);

	assert.deepEqual(await Promise.all([first, second]), ["skipped", "answered"]);
	assert.deepEqual(order, ["skip", "next"]);
}

console.log("ask-user-question queue tests passed");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
