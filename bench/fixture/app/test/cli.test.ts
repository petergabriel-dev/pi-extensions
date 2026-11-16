import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../src/cli.ts";

const csv = "date,sku,qty,note\n2026-01-02,A-1,4,\n2026-01-05,B-2,1500,\n2026-01-09,A-1,-1,sold\n";
const read = () => csv;

test("balance prints the table", () => {
	const result = runCli(["balance", "stock.csv"], read);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, ["SKU    QTY", "A-1      3", "B-2  1,500"].join("\n"));
});

test("history prints one SKU", () => {
	assert.equal(runCli(["history", "stock.csv", "A-1"], read).stdout, "2026-01-02  +4\n2026-01-09  -1  sold");
});

test("low lists items under the threshold with quantities", () => {
	assert.equal(runCli(["low", "stock.csv", "--threshold", "10"], read).stdout, "A-1 (3)");
});

test("missing arguments print usage", () => {
	const result = runCli(["balance"], read);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /usage/);
});

test("unreadable files are reported", () => {
	const result = runCli(["balance", "missing.csv"], () => {
		throw new Error("ENOENT");
	});
	assert.deepEqual(result, { code: 1, stdout: "", stderr: "cannot read missing.csv" });
});
