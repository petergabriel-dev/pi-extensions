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
			"model",
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
			"model",
			undefined,
			async () => {
				order.push("second");
				return "second";
			},
			() => "cancelled",
		);
		const thirdResult = withAskUserQuestionQueue(
			"model",
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
		const activeResult = withAskUserQuestionQueue("model", undefined, () => active.promise, () => "cancelled");
		await flush();

		let childRendered = false;
		let modelRendered = false;
		const childResult = withAskUserQuestionQueue(
			"child",
			undefined,
			async () => {
				childRendered = true;
				return "child";
			},
			(reason) => `cancelled:${reason}`,
		);
		const queuedModelResult = withAskUserQuestionQueue(
			"model",
			undefined,
			async () => {
				modelRendered = true;
				return "model";
			},
			(reason) => `cancelled:${reason}`,
		);
		cancelAskUserQuestionBatch("model");
		active.resolve("active");

		assert.equal(await activeResult, "active");
		assert.deepEqual(await Promise.all([childResult, queuedModelResult]), ["child", "cancelled:batch-cancelled"]);
		assert.equal(childRendered, true, "model cancellation must preserve queued child questions");
		assert.equal(modelRendered, false, "model cancellation must skip queued model questions");
	}

	{
		const order: string[] = [];
		const childResult = withAskUserQuestionQueue(
			"child",
			undefined,
			async () => {
				order.push("child-dismissed");
				return "dismissed";
			},
			() => "cancelled",
		);
		const modelResult = withAskUserQuestionQueue(
			"model",
			undefined,
			async () => {
				order.push("model-answered");
				return "answered";
			},
			() => "cancelled",
		);

		assert.deepEqual(await Promise.all([childResult, modelResult]), ["dismissed", "answered"]);
		assert.deepEqual(order, ["child-dismissed", "model-answered"], "child dismissal must leave model waiters intact");
	}

	{
		const active = deferred<string>();
		const activeResult = withAskUserQuestionQueue("model", undefined, () => active.promise, () => "cancelled");
		await flush();

		const controller = new AbortController();
		let rendered = false;
		const queuedResult = withAskUserQuestionQueue(
			"child",
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
		assert.equal(rendered, false, "aborted queued child request must not render");
	}

	{
		let resetRan = false;
		assert.equal(
			await withAskUserQuestionQueue(
				"model",
				undefined,
				async () => {
					resetRan = true;
					return "after-reset";
				},
				() => "cancelled",
			),
			"after-reset",
		);
		assert.equal(resetRan, true, "source-scoped cancellation state must reset after queue drains");
	}

	console.log("ask-user-question queue tests passed");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
