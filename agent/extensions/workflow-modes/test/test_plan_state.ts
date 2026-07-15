import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveSavedPlanState } from "../plan-state.js";

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	data?: unknown;
}

const PLAN_ENTRY = "workflow-plan";
const timestamp = (day: number) => `2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const entry = (id: string, parentId: string | null, data?: unknown, day = 1): Entry => ({
	type: data === undefined ? "message" : "custom",
	id,
	parentId,
	timestamp: timestamp(day),
	...(data === undefined ? {} : { customType: PLAN_ENTRY, data }),
});

function branch(entries: Entry[], leafId: string | null): Entry[] {
	const byId = new Map(entries.map((item) => [item.id, item]));
	const result: Entry[] = [];
	for (let id = leafId; id;) {
		const item = byId.get(id);
		assert.ok(item, `missing entry ${id}`);
		result.push(item);
		id = item.parentId;
	}
	return result.reverse();
}

console.log("Running test_plan_state...");

const root = entry("root", null);
const save = entry("save", "root", { event: "set", plan: "# Plan A", planId: "plan-a", savedAt: timestamp(2), at: Date.parse(timestamp(2)) }, 2);
const afterSave = entry("after-save", "save");
const clear = entry("clear", "after-save", { event: "clear", at: Date.parse(timestamp(3)) }, 3);
const afterClear = entry("after-clear", "clear");
const preSaveFork = entry("pre-save-fork", "root");
const postSaveFork = entry("post-save-fork", "save");
const preClearFork = entry("pre-clear-fork", "after-save");
const postClearFork = entry("post-clear-fork", "clear");
const tree = [root, save, afterSave, clear, afterClear, preSaveFork, postSaveFork, preClearFork, postClearFork];

assert.equal(resolveSavedPlanState([]), undefined, "new session must have no plan");
assert.equal(resolveSavedPlanState(branch(tree, preSaveFork.id)), undefined, "fork before save must not inherit plan");
assert.equal(resolveSavedPlanState(branch(tree, postSaveFork.id))?.planId, "plan-a", "fork after save must inherit plan");
assert.equal(resolveSavedPlanState(branch(tree, preClearFork.id))?.plan, "# Plan A", "branch before clear must retain plan");
assert.equal(resolveSavedPlanState(branch(tree, postClearFork.id)), undefined, "branch after clear must have no plan");
assert.equal(resolveSavedPlanState(branch(tree, afterSave.id))?.plan, "# Plan A", "tree navigation to saved branch must restore plan");
assert.equal(resolveSavedPlanState(branch(tree, afterClear.id)), undefined, "tree navigation to cleared branch must clear plan");

const legacy = entry("legacy-save", "root", { event: "set", plan: "legacy", at: Date.parse(timestamp(4)) }, 5);
assert.deepEqual(resolveSavedPlanState(branch([root, legacy], legacy.id)), {
	plan: "legacy",
	planId: "legacy-save",
	savedAt: timestamp(4),
});
assert.equal(resolveSavedPlanState([entry("invalid", null, { event: "set", plan: "", planId: "x", savedAt: timestamp(1) })]), undefined);

const otherSession = [entry("other-root", null), entry("other-save", "other-root", { event: "set", plan: "other", planId: "other-plan", savedAt: timestamp(6) }, 6)];
assert.equal(resolveSavedPlanState(branch(tree, preSaveFork.id)), undefined, "independent session plan must not leak");
assert.equal(resolveSavedPlanState(branch(otherSession, "other-save"))?.plan, "other");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-plan-state-"));
try {
	const sessionFile = path.join(tempDir, "session.jsonl");
	const persisted = [root, save, afterSave];
	await fs.writeFile(sessionFile, [JSON.stringify({ type: "session", version: 3, id: "session-a", timestamp: timestamp(1), cwd: tempDir }), ...persisted.map((item) => JSON.stringify(item))].join("\n") + "\n");
	const reopened = (await fs.readFile(sessionFile, "utf8")).trim().split("\n").slice(1).map((line) => JSON.parse(line) as Entry);
	assert.deepEqual(resolveSavedPlanState(branch(reopened, reopened.at(-1)?.id ?? null)), {
		plan: "# Plan A",
		planId: "plan-a",
		savedAt: timestamp(2),
	}, "reopening persisted session must restore selected branch plan");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}

const longBranch: Entry[] = [entry("perf-root", null)];
for (let index = 1; index < 10_000; index++) longBranch.push(entry(`perf-${index}`, longBranch.at(-1)!.id));
longBranch.push(entry("perf-save", longBranch.at(-1)!.id, { event: "set", plan: "perf", planId: "perf-plan", savedAt: timestamp(7) }, 7));
const startedAt = performance.now();
assert.equal(resolveSavedPlanState(longBranch)?.planId, "perf-plan");
const durationMs = performance.now() - startedAt;
assert.ok(durationMs < 50, `10,000-entry reconstruction took ${durationMs.toFixed(2)} ms`);

console.log(`test_plan_state passed (${durationMs.toFixed(2)} ms for 10,000 entries)`);
