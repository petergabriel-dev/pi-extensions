import assert from "node:assert/strict";

import {
	clearSubagentProgress,
	getProgressSnapshot,
	setSubagentProgressContext,
	startSubagentProgress,
} from "../progress.ts";

const renders: Array<{ key: string; content: string[] | undefined; placement?: string }> = [];
const ctx = {
	hasUI: true,
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
			renders.push({ key, content, placement: options?.placement });
		},
	},
} as never;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
	try {
		setSubagentProgressContext(ctx);
		const first = startSubagentProgress("worker", { name: "worker-one" });
		await delay(260);
		assert.match(renders.at(-1)?.content?.[1] ?? "", /worker-one \[running\]/);
		assert.equal(renders.at(-1)?.key, "subagents-progress");
		assert.equal(renders.at(-1)?.placement, "aboveEditor");

		first.setStatus("waiting");
		await delay(260);
		assert.match(renders.at(-1)?.content?.[1] ?? "", /worker-one \[waiting\]/);

		const second = startSubagentProgress("explorer", { name: "explorer-one" });
		first.finish("done");
		await delay(260);
		const snapshot = getProgressSnapshot();
		assert.deepEqual(snapshot.running.map((run) => run.status), ["done", "running"]);
		assert.match(renders.at(-1)?.content?.join("\n") ?? "", /worker-one \[done\]/);

		second.finish("done");
		await delay(520);
		assert.equal(getProgressSnapshot().running.length, 0);
		assert.equal(renders.at(-1)?.content, undefined);
	} finally {
		clearSubagentProgress();
		setSubagentProgressContext(undefined);
	}
	console.log("subagent progress tests passed");
})();
