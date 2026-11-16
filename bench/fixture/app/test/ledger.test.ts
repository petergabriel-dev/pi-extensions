import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidDate } from "../src/dates.ts";
import { balances, history, lowStock } from "../src/ledger.ts";
import type { Movement } from "../src/types.ts";

const movements: Movement[] = [
	{ date: "2026-01-05", sku: "B-2", qty: 10, note: "" },
	{ date: "2026-01-02", sku: "A-1", qty: 4, note: "" },
	{ date: "2026-01-09", sku: "A-1", qty: -1, note: "sold" },
	{ date: "2026-02-01", sku: "B-2", qty: -7, note: "" },
];

test("balances sum per SKU, sorted by SKU", () => {
	assert.deepEqual([...balances(movements)], [["A-1", 3], ["B-2", 3]]);
});

test("ranges include both end dates", () => {
	assert.deepEqual([...balances(movements, { from: "2026-01-05", to: "2026-01-09" })], [["A-1", -1], ["B-2", 10]]);
});

test("history is oldest first", () => {
	assert.deepEqual(history(movements, "A-1").map((m) => m.date), ["2026-01-02", "2026-01-09"]);
});

test("lowStock lists SKUs under the threshold", () => {
	assert.deepEqual(lowStock(new Map([["A-1", 2], ["B-2", 9]]), 5), ["A-1"]);
});

test("isValidDate rejects impossible dates", () => {
	assert.equal(isValidDate("2026-02-28"), true);
	assert.equal(isValidDate("2026-02-30"), false);
	assert.equal(isValidDate("2026-2-3"), false);
});
