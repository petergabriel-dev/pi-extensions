import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBalances, formatHistory } from "../src/report.ts";

test("balance table aligns columns and groups thousands", () => {
	const table = formatBalances(new Map([["A-1", 1200], ["LONG-SKU", -5]]));
	assert.equal(table, ["SKU         QTY", "A-1       1,200", "LONG-SKU     -5"].join("\n"));
});

test("history lines show signed quantities", () => {
	const lines = formatHistory([
		{ date: "2026-01-02", sku: "A-1", qty: 4, note: "" },
		{ date: "2026-01-09", sku: "A-1", qty: -1, note: "sold" },
	]);
	assert.equal(lines, "2026-01-02  +4\n2026-01-09  -1  sold");
});
