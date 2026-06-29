import assert from "node:assert";
import persistentMemory, { __beginModalSaveTurnForTest, __pendingModalSaveTurnForTest, __routeMemoryConsolidateThroughAgentTurnForTest, buildMemoryConsolidateDirective, computeMemoryMenuModel } from "../index.js";

console.log("Running test_memory_menu...");

function recommendedValues(model: ReturnType<typeof computeMemoryMenuModel>): string[] {
	return model.rows.filter((row) => row.recommended).map((row) => row.value);
}

function testStagingRecommendedFirst() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 2, deadLetterCount: 3 });
	assert.equal(model.recommended, "consolidate");
	assert.deepEqual(recommendedValues(model), ["consolidate"]);
	assert.ok(model.rows.some((row) => row.value === "consolidate" && row.count === 2 && row.label.includes("2")));
	assert.ok(model.rows.some((row) => row.value === "recover" && row.count === 3 && row.label.includes("3")));
}

function testDeadLetterRecommendedWhenNoStaging() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 0, deadLetterCount: 1 });
	assert.equal(model.recommended, "recover");
	assert.deepEqual(recommendedValues(model), ["recover"]);
}

function testNoRecommendationWhenNoWork() {
	const model = computeMemoryMenuModel({ initialized: true, stagingCount: 0, deadLetterCount: 0 });
	assert.equal(model.recommended, null);
	assert.deepEqual(recommendedValues(model), []);
	assert.deepEqual(model.rows.map((row) => row.value), ["consolidate", "recover", "inspect"]);
}

function testUninitializedInitOnly() {
	const model = computeMemoryMenuModel({ initialized: false, stagingCount: 5, deadLetterCount: 4 });
	assert.equal(model.recommended, null);
	assert.deepEqual(model.rows.map((row) => row.value), ["init"]);
	assert.deepEqual(recommendedValues(model), []);
}

function testConsolidateDirectiveRequiresToolCall() {
	const directive = buildMemoryConsolidateDirective();
	assert.match(directive, /save_to_memory tool exactly once/);
	assert.match(directive, /lessons: \[\], preferences: \[\], decisions: \[\], domain: \[\]/);
	assert.match(directive, /Do not edit memory files directly/);
	assert.match(directive, /\/memory consolidate/);
}

async function testMissedModalSaveTurnNudgesOnce() {
	const { handlers, notifications } = setupExtensionHarness();
	__beginModalSaveTurnForTest();
	await emit(handlers, "turn_end", {}, { ui: { notify: (message: string) => notifications.push(message) } });
	await emit(handlers, "agent_end", {}, { ui: { notify: (message: string) => notifications.push(message) } });
	assert.equal(notifications.filter((message) => message.includes("without save_to_memory")).length, 1);
	assert.equal(__pendingModalSaveTurnForTest(), null);
}

async function testModalSaveToolCallSuppressesNudge() {
	const { handlers, notifications } = setupExtensionHarness();
	__beginModalSaveTurnForTest();
	await emit(handlers, "tool_call", { toolName: "save_to_memory", input: {}, toolCallId: "t1" }, { ui: { notify: (message: string) => notifications.push(message) } });
	assert.equal(__pendingModalSaveTurnForTest()?.toolCalled, true);
	await emit(handlers, "turn_end", {}, { ui: { notify: (message: string) => notifications.push(message) } });
	assert.equal(notifications.filter((message) => message.includes("without save_to_memory")).length, 0);
	assert.equal(__pendingModalSaveTurnForTest(), null);
}

async function testModalConsolidateUsesPiSendUserMessage() {
	const sent: Array<{ content: string; options?: unknown }> = [];
	await __routeMemoryConsolidateThroughAgentTurnForTest({
		sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
	} as any, { isIdle: () => true, ui: { notify: () => undefined } } as any);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.content, /Persistent memory save requested/);
	assert.equal(sent[0]!.options, undefined);
	assert.deepEqual(__pendingModalSaveTurnForTest(), { toolCalled: false, nudged: false });
}

async function testModalConsolidateQueuesFollowUpWhenBusy() {
	const sent: Array<{ content: string; options?: unknown }> = [];
	await __routeMemoryConsolidateThroughAgentTurnForTest({
		sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
	} as any, { isIdle: () => false, ui: { notify: () => undefined } } as any);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.options, { deliverAs: "followUp" });
}

async function testModalConsolidateFailureClearsPendingTurn() {
	const notifications: string[] = [];
	await __routeMemoryConsolidateThroughAgentTurnForTest({
		sendUserMessage: () => { throw new Error("boom"); },
	} as any, { isIdle: () => true, ui: { notify: (message: string) => notifications.push(message) } } as any);
	assert.equal(__pendingModalSaveTurnForTest(), null);
	assert.equal(notifications.filter((message) => message.includes("failed to start save turn")).length, 1);
}

function setupExtensionHarness() {
	const handlers = new Map<string, Function[]>();
	const notifications: string[] = [];
	persistentMemory({
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: () => undefined,
		registerTool: () => undefined,
		appendEntry: () => undefined,
		events: { on: () => undefined },
		ui: {},
	} as any);
	return { handlers, notifications };
}

async function emit(handlers: Map<string, Function[]>, name: string, event: unknown, ctx: unknown) {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

testStagingRecommendedFirst();
testDeadLetterRecommendedWhenNoStaging();
testNoRecommendationWhenNoWork();
testUninitializedInitOnly();
testConsolidateDirectiveRequiresToolCall();
await testMissedModalSaveTurnNudgesOnce();
await testModalSaveToolCallSuppressesNudge();
await testModalConsolidateUsesPiSendUserMessage();
await testModalConsolidateQueuesFollowUpWhenBusy();
await testModalConsolidateFailureClearsPendingTurn();
console.log("test_memory_menu passed!");
