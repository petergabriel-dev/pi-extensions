import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSku, parseCsv } from "../src/parse.ts";

test("parses rows after the header", () => {
	const rows = parseCsv("date,sku,qty,note\n2026-01-02,ABC-1,5,first delivery\n2026-01-03,ABC-1,-2,");
	assert.deepEqual(rows, [
		{ date: "2026-01-02", sku: "ABC-1", qty: 5, note: "first delivery" },
		{ date: "2026-01-03", sku: "ABC-1", qty: -2, note: "" },
	]);
});

test("skips blank lines and keeps commas inside notes", () => {
	const rows = parseCsv("\n2026-01-02,XY-9,3,box 1, box 2\n\n");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].note, "box 1, box 2");
});

test("accepts Windows line endings", () => {
	assert.equal(parseCsv("date,sku,qty,note\r\n2026-01-02,XY-9,3,\r\n").length, 1);
});

test("trims SKUs", () => {
	assert.equal(normalizeSku("  ABC-1 "), "ABC-1");
});
