import assert from "node:assert";
import { updateMemoryMeter } from "../index.js";

console.log("Running test_memory_meter...");

function createSpyUi() {
	const setStatusCalls: unknown[][] = [];
	const setWidgetCalls: unknown[][] = [];
	const setFooterCalls: unknown[][] = [];
	return {
		ui: {
			setStatus: (...args: unknown[]) => setStatusCalls.push(args),
			setWidget: (...args: unknown[]) => setWidgetCalls.push(args),
			setFooter: (...args: unknown[]) => setFooterCalls.push(args),
		},
		setStatusCalls,
		setWidgetCalls,
		setFooterCalls,
	};
}

// No UI is a no-op and does not throw.
{
	assert.doesNotThrow(() => updateMemoryMeter(undefined));
}

// A UI handle without setStatus is a no-op and does not throw.
{
	const handle: Record<string, unknown> = {};
	assert.doesNotThrow(() => updateMemoryMeter(handle as never, { showPanel: true }));
	assert.deepStrictEqual(handle, {});
}

// Show path updates status and widget using deterministic spies.
{
	const { ui, setStatusCalls, setWidgetCalls, setFooterCalls } = createSpyUi();
	assert.doesNotThrow(() => updateMemoryMeter(ui as never, { showPanel: true, panelTitle: "Memory test" }));

	assert.strictEqual(setStatusCalls.length, 1);
	assert.strictEqual(setStatusCalls[0][0], "persistent-memory");
	assert.strictEqual(setStatusCalls[0][1], "Mem: not initialized");

	assert.strictEqual(setWidgetCalls.length, 1);
	assert.strictEqual(setWidgetCalls[0][0], "persistent-memory");
	assert.deepStrictEqual(setWidgetCalls[0][1], ["Memory test", "No project memory dir."]);
	assert.deepStrictEqual(setWidgetCalls[0][2], { placement: "belowEditor" });
	assert.strictEqual(setFooterCalls.length, 0);
}

// Clear path updates status and clears the widget using deterministic spies.
{
	const { ui, setStatusCalls, setWidgetCalls, setFooterCalls } = createSpyUi();
	assert.doesNotThrow(() => updateMemoryMeter(ui as never, { clearPanel: true }));

	assert.strictEqual(setStatusCalls.length, 1);
	assert.strictEqual(setStatusCalls[0][0], "persistent-memory");
	assert.strictEqual(setStatusCalls[0][1], "Mem: not initialized");

	assert.strictEqual(setWidgetCalls.length, 1);
	assert.strictEqual(setWidgetCalls[0][0], "persistent-memory");
	assert.strictEqual(setWidgetCalls[0][1], undefined);
	assert.strictEqual(setFooterCalls.length, 0);
}

console.log("test_memory_meter passed!");
