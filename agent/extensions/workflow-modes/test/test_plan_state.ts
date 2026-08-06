import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolveSavedPlanState, resolveSavedPlanTaskState } from "../plan-state.js";

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
const setPlan = (id: string, parentId: string | null, planId: string, day: number): Entry => entry(id, parentId, {
	event: "set",
	planId,
	path: `/plans/${planId}.md`,
	savedAt: timestamp(day),
}, day);
const activatePlan = (id: string, parentId: string | null, planId: string, day: number): Entry => entry(id, parentId, {
	event: "activate",
	planId,
}, day);
const clearPlan = (id: string, parentId: string | null, planId: string, day: number): Entry => entry(id, parentId, {
	event: "clear",
	planId,
}, day);

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
const saveA = setPlan("save-a", "root", "plan-a", 2);
const saveB = setPlan("save-b", "save-a", "plan-b", 3);
const activateA = activatePlan("activate-a", "save-b", "plan-a", 4);
const clearB = clearPlan("clear-b", "activate-a", "plan-b", 5);
const tree = [root, saveA, saveB, activateA, clearB];

assert.deepEqual(resolveSavedPlanState([]), { plans: [], activePlanId: undefined });
assert.deepEqual(resolveSavedPlanState(branch(tree, saveB.id)), {
	plans: [
		{ planId: "plan-a", path: "/plans/plan-a.md", savedAt: timestamp(2) },
		{ planId: "plan-b", path: "/plans/plan-b.md", savedAt: timestamp(3) },
	],
	activePlanId: "plan-b",
});
assert.deepEqual(resolveSavedPlanState(branch(tree, activateA.id)), {
	plans: [
		{ planId: "plan-a", path: "/plans/plan-a.md", savedAt: timestamp(2) },
		{ planId: "plan-b", path: "/plans/plan-b.md", savedAt: timestamp(3) },
	],
	activePlanId: "plan-a",
});
assert.deepEqual(resolveSavedPlanState(branch(tree, clearB.id)), {
	plans: [{ planId: "plan-a", path: "/plans/plan-a.md", savedAt: timestamp(2) }],
	activePlanId: "plan-a",
});

const clearActive = clearPlan("clear-a", "clear-b", "plan-a", 6);
assert.deepEqual(resolveSavedPlanState(branch([...tree, clearActive], clearActive.id)), { plans: [], activePlanId: undefined });

const clearThenActivate = activatePlan("activate-cleared", "clear-b", "plan-b", 7);
assert.deepEqual(resolveSavedPlanState(branch([...tree, clearThenActivate], clearThenActivate.id)), {
	plans: [{ planId: "plan-a", path: "/plans/plan-a.md", savedAt: timestamp(2) }],
	activePlanId: "plan-a",
}, "activating cleared plan must not resurrect it");

const preA = entry("pre-a", "root");
const postA = entry("post-a", saveA.id);
const forkTree = [...tree, preA, postA];
assert.deepEqual(resolveSavedPlanState(branch(forkTree, preA.id)), { plans: [], activePlanId: undefined }, "fork before save must not inherit plan");
assert.equal(resolveSavedPlanState(branch(forkTree, postA.id)).plans[0]?.planId, "plan-a", "fork after save must inherit ancestor plan");

assert.deepEqual(resolveSavedPlanState([
	entry("invalid", null, { event: "set", planId: "plan-x", path: "/x", savedAt: "invalid" }),
	entry("legacy", "invalid", { event: "set", plan: "legacy", planId: "plan-y", savedAt: timestamp(2) }),
]), { plans: [], activePlanId: undefined }, "invalid or legacy entries must be ignored");

const seededTasks = [
	{ id: "task-1", title: "First", metadata: {} },
	{ id: "task-2", title: "Second", metadata: {} },
];
const seeded = entry("seeded", "root", {
	event: "set",
	planId: "plan-tasks",
	path: "/plans/plan-tasks.md",
	savedAt: timestamp(2),
	tasks: seededTasks,
});
const tick = entry("tick", "seeded", { event: "tick", planId: "plan-tasks", taskId: "task-1" });
const duplicateTick = entry("duplicate-tick", "tick", { event: "tick", planId: "plan-tasks", taskId: "task-1" });
assert.deepEqual(resolveSavedPlanTaskState(branch([root, seeded, tick, duplicateTick], duplicateTick.id), "plan-tasks"), {
	tasks: seededTasks,
	completedTaskIds: ["task-1"],
	progress: { done: 1, total: 2 },
	nextTask: { id: "task-2", title: "Second" },
	seeded: true,
}, "ticks must be durable and idempotent");
assert.deepEqual(resolveSavedPlanTaskState([root], "legacy-plan", seededTasks), {
	tasks: seededTasks,
	completedTaskIds: [],
	progress: { done: 0, total: 2 },
	nextTask: { id: "task-1", title: "First" },
	seeded: false,
}, "legacy plans may fall back to parsed file tasks");

const longBranch: Entry[] = [entry("perf-root", null)];
for (let index = 1; index < 10_000; index++) longBranch.push(entry(`perf-${index}`, longBranch.at(-1)!.id));
longBranch.push(setPlan("perf-save", longBranch.at(-1)!.id, "perf-plan", 7));
const startedAt = performance.now();
assert.equal(resolveSavedPlanState(longBranch).activePlanId, "perf-plan");
const durationMs = performance.now() - startedAt;
assert.ok(durationMs < 50, `10,000-entry reconstruction took ${durationMs.toFixed(2)} ms`);

console.log(`test_plan_state passed (${durationMs.toFixed(2)} ms for 10,000 entries)`);
