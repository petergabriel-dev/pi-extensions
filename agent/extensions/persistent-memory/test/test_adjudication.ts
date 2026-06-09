/**
 * Unit tests for consolidation/adjudication.ts
 *
 * Covers:
 *  - Valid verdicts (distinct, duplicate, supersedes, merge)
 *  - Valid verdicts with optional reason
 *  - Valid batch of mixed verdicts
 *  - Malformed JSON returns parked (no throw)
 *  - Missing verdicts key returns parked
 *  - Partial batch salvages valid verdicts, parks invalid
 *  - Merge without merged_text parks
 *  - Non-merge with merged_text parks
 *  - Invalid verdict value parks
 *  - Extra structural fields parks
 *  - Empty input returns parked
 *  - Tool schema build returns correct submit_plan shape
 *
 * Run: npx tsx test/test_adjudication.ts
 */

import assert from "node:assert";
import {
	buildAdjudicationTool,
	parseAdjudication,
	VERDICT_ACTIONS,
	type AdjudicationResult,
	type AdjudicationVerdict,
} from "../consolidation/adjudication.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertParked(result: AdjudicationResult, desc?: string): asserts result is { status: "parked"; raw: string; message: string; parked?: import("../consolidation/adjudication.js").ParkedItem[] } {
	assert.strictEqual(result.status, "parked", desc ?? "expected parked");
}

function assertValid(result: AdjudicationResult, desc?: string): asserts result is { status: "valid"; verdicts: AdjudicationVerdict[]; parked?: import("../consolidation/adjudication.js").ParkedItem[] } {
	assert.strictEqual(result.status, "valid", desc ?? "expected valid");
}

// ---------------------------------------------------------------------------
// Test: VERDICT_ACTIONS constant
// ---------------------------------------------------------------------------

{
	assert.deepStrictEqual(VERDICT_ACTIONS, ["distinct", "duplicate", "supersedes", "merge"]);
}

console.log("VERDICT_ACTIONS passed");

// ---------------------------------------------------------------------------
// Test: buildAdjudicationTool returns correct shape
// ---------------------------------------------------------------------------

{
	const tool = buildAdjudicationTool();
	assert.strictEqual(tool.name, "submit_plan");
	assert.strictEqual(typeof tool.description, "string");
	assert.ok(tool.description.length > 0);
	assert.ok(typeof tool.parameters === "object" && tool.parameters !== null);

	const params = tool.parameters as Record<string, unknown>;
	assert.strictEqual(params.type, "object");
	assert.strictEqual(params.additionalProperties, false);

	const props = params.properties as Record<string, unknown>;
	const verdictsSchema = props.verdicts as Record<string, unknown>;
	assert.strictEqual(verdictsSchema.type, "array");

	const itemsSchema = verdictsSchema.items as Record<string, unknown>;
	const variants = itemsSchema.anyOf as Record<string, unknown>[];
	assert.strictEqual(variants.length, 4);
	assert.ok(variants.every((variant) => variant.additionalProperties === false));
	const mergeVariant = variants.find((variant) => {
		const properties = variant.properties as Record<string, Record<string, unknown>>;
		return properties.verdict?.const === "merge";
	});
	assert.ok(mergeVariant);
	assert.deepStrictEqual(mergeVariant.required, ["verdict", "merged_text"]);
}

console.log("buildAdjudicationTool passed");

// ---------------------------------------------------------------------------
// Test: valid distinct verdict
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "distinct" }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.strictEqual(result.verdicts[0].merged_text, undefined);
}

console.log("valid distinct passed");

// ---------------------------------------------------------------------------
// Test: valid duplicate verdict
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "duplicate" }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "duplicate");
}

console.log("valid duplicate passed");

// ---------------------------------------------------------------------------
// Test: valid supersedes verdict
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "supersedes" }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "supersedes");
}

console.log("valid supersedes passed");

// ---------------------------------------------------------------------------
// Test: valid merge verdict with merged_text
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [{ verdict: "merge", merged_text: "Combined lesson about JWT authentication." }],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "merge");
	assert.strictEqual(result.verdicts[0].merged_text, "Combined lesson about JWT authentication.");
}

console.log("valid merge with merged_text passed");

// ---------------------------------------------------------------------------
// Test: valid verdict with optional reason
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [
			{ verdict: "distinct", reason: "no existing match found" },
			{ verdict: "duplicate", reason: "exact same content" },
			{ verdict: "merge", merged_text: "updated text", reason: "merged similar lessons" },
		],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 3);
	assert.strictEqual(result.verdicts[0].reason, "no existing match found");
	assert.strictEqual(result.verdicts[1].reason, "exact same content");
	assert.strictEqual(result.verdicts[2].reason, "merged similar lessons");
}

console.log("valid verdict with reason passed");

// ---------------------------------------------------------------------------
// Test: valid batch of mixed verdicts
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [
			{ verdict: "distinct" },
			{ verdict: "duplicate" },
			{ verdict: "supersedes" },
			{ verdict: "merge", merged_text: "The combined summary text." },
		],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 4);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.strictEqual(result.verdicts[1].verdict, "duplicate");
	assert.strictEqual(result.verdicts[2].verdict, "supersedes");
	assert.strictEqual(result.verdicts[3].verdict, "merge");
	assert.strictEqual(result.verdicts[3].merged_text, "The combined summary text.");
}

console.log("valid mixed batch passed");

// ---------------------------------------------------------------------------
// Test: malformed JSON returns parked (no throw)
// ---------------------------------------------------------------------------

{
	const result = parseAdjudication("this is not json at all {[[[");
	assertParked(result);
	assert.strictEqual(result.raw, "this is not json at all {[[[");
}

{
	const result = parseAdjudication("\x00\x01\x02{verdicts:[]}");
	assertParked(result);
}

console.log("malformed JSON returns parked passed");

// ---------------------------------------------------------------------------
// Test: missing verdicts key returns parked
// ---------------------------------------------------------------------------

{
	const result = parseAdjudication(JSON.stringify({ other_key: "something" }));
	assertParked(result);
}

{
	const result = parseAdjudication(JSON.stringify({}));
	assertParked(result);
}

console.log("missing verdicts key returns parked passed");

// ---------------------------------------------------------------------------
// Test: verdicts is not an array returns parked
// ---------------------------------------------------------------------------

{
	const result = parseAdjudication(JSON.stringify({ verdicts: "not-an-array" }));
	assertParked(result);
}

{
	const result = parseAdjudication(JSON.stringify({ verdicts: { 0: {}, 1: {} } }));
	assertParked(result);
}

console.log("verdicts not an array returns parked passed");

// ---------------------------------------------------------------------------
// Test: partial batch salvages valid verdicts, parks invalid
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [
			{ verdict: "distinct" },
			{ verdict: "unknown_action" },
			{ verdict: "duplicate", reason: "ok" },
		],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 2);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.strictEqual(result.verdicts[1].verdict, "duplicate");
	assert.ok(result.parked);
	assert.strictEqual(result.parked!.length, 1);
	const p = result.parked![0] as { index: number; reason: string };
	assert.strictEqual(p.index, 1);
}

{
	const json = JSON.stringify({
		verdicts: [
			"just a string",
			{ verdict: "distinct" },
			{ verdict: "merge", merged_text: "ok merge text" },
		],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 2);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.strictEqual(result.verdicts[1].verdict, "merge");
	assert.ok(result.parked);
	assert.strictEqual(result.parked!.length, 1);
}

console.log("partial batch salvages valid, parks invalid passed");

// ---------------------------------------------------------------------------
// Test: all verdicts invalid → parked
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [
			{ verdict: "bad1" },
			{ verdict: "bad2" },
		],
	});
	const result = parseAdjudication(json);
	assertParked(result);
	assert.ok(result.parked);
	assert.strictEqual(result.parked!.length, 2);
}

console.log("all verdicts invalid returns parked passed");

// ---------------------------------------------------------------------------
// Test: merge without merged_text parks
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "merge" }] });
	assertParked(parseAdjudication(json));
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "merge", merged_text: "" }] });
	assertParked(parseAdjudication(json));
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "merge", merged_text: "   " }] });
	assertParked(parseAdjudication(json));
}

console.log("merge without valid merged_text parks passed");

// ---------------------------------------------------------------------------
// Test: non-merge with merged_text parks
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "distinct", merged_text: "should not be here" }] });
	assertParked(parseAdjudication(json));
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "duplicate", merged_text: "nope" }] });
	assertParked(parseAdjudication(json));
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "supersedes", merged_text: "nope" }] });
	assertParked(parseAdjudication(json));
}

console.log("non-merge with merged_text parks passed");

// ---------------------------------------------------------------------------
// Test: extra structural fields park individual items
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({
		verdicts: [
			{ verdict: "distinct" },
			{ verdict: "distinct", target_id: "lsn-1" },
			{ verdict: "duplicate", candidate_id: "c1" },
			{ verdict: "distinct", supersedes: "old-lsn" },
		],
	});
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.ok(result.parked);
	assert.strictEqual(result.parked!.length, 3);

	for (const p of result.parked! as { reason: string }[]) {
		assert.ok(p.reason.includes("unexpected structural keys"), `Expected structural keys rejection, got: ${p.reason}`);
	}
}

console.log("extra structural fields park passed");

// ---------------------------------------------------------------------------
// Test: empty input returns parked
// ---------------------------------------------------------------------------

{
	assertParked(parseAdjudication(""));
}

{
	assertParked(parseAdjudication("   \n  \t "));
}

console.log("empty input returns parked passed");

// ---------------------------------------------------------------------------
// Test: JSON inside markdown fences is parsed
// ---------------------------------------------------------------------------

{
	const raw = "```json\n" + JSON.stringify({ verdicts: [{ verdict: "distinct" }] }) + "\n```";
	const result = parseAdjudication(raw);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
}

{
	const raw = "```\n" + JSON.stringify({ verdicts: [{ verdict: "duplicate" }] }) + "\n```";
	const result = parseAdjudication(raw);
	assertValid(result);
	assert.strictEqual(result.verdicts[0].verdict, "duplicate");
}

console.log("JSON inside markdown fences parsed passed");

// ---------------------------------------------------------------------------
// Test: whitespace around merge text is trimmed
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "merge", merged_text: "  trimmed text  " }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts[0].merged_text, "trimmed text");
}

console.log("merge text trimming passed");

// ---------------------------------------------------------------------------
// Test: reason whitespace trimming
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "distinct", reason: "  some reason  " }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts[0].reason, "some reason");
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "distinct", reason: "   " }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts[0].reason, undefined);
}

console.log("reason trimming passed");

// ---------------------------------------------------------------------------
// Test: null verdict item is parked
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [null, { verdict: "distinct" }] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 1);
	assert.strictEqual(result.verdicts[0].verdict, "distinct");
	assert.ok(result.parked);
	assert.strictEqual(result.parked!.length, 1);
}

console.log("null item parked passed");

// ---------------------------------------------------------------------------
// Test: non-string reason is parked
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "distinct", reason: 123 }] });
	assertParked(parseAdjudication(json));
}

console.log("non-string reason parked passed");

// ---------------------------------------------------------------------------
// Test: merge with non-string merged_text is parked
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "merge", merged_text: 42 }] });
	assertParked(parseAdjudication(json));
}

console.log("merge with non-string merged_text parked passed");

// ---------------------------------------------------------------------------
// Test: empty verdicts array is valid
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [] });
	const result = parseAdjudication(json);
	assertValid(result);
	assert.strictEqual(result.verdicts.length, 0);
}

console.log("empty verdicts array valid passed");

// ---------------------------------------------------------------------------
// Test: case sensitivity of verdict values
// ---------------------------------------------------------------------------

{
	const json = JSON.stringify({ verdicts: [{ verdict: "Distinct" }] });
	assertParked(parseAdjudication(json));
}

{
	const json = JSON.stringify({ verdicts: [{ verdict: "MERGE", merged_text: "text" }] });
	assertParked(parseAdjudication(json));
}

console.log("case sensitivity passed");

// ---------------------------------------------------------------------------
// Test: parser never throws even on deeply weird input
// ---------------------------------------------------------------------------

{
	let result: AdjudicationResult;
	try {
		result = parseAdjudication(undefined as unknown as string);
	} catch {
		assert.fail("parseAdjudication threw on undefined");
	}
	assertParked(result);
}

{
	const result = parseAdjudication("42");
	assertParked(result);
}

{
	const result = parseAdjudication("[1,2,3]");
	assertParked(result);
}

console.log("parser never throws passed");

// ---------------------------------------------------------------------------

console.log("\n✅ All adjudication tests passed!");
