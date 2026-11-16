import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../src/cli.ts";
import { balances, history } from "../src/ledger.ts";
import { parseCsv } from "../src/parse.ts";

const csv = "date,sku,qty,note\n2026-01-02,abc-1,5,\n2026-01-03,ABC-1,2,\n2026-01-04, Abc-1 ,-1,\n2026-01-05,xyz-2,9,\n";
const read = () => csv;

test("R1 balances merge letter-case variants of an item code", () => {
	assert.deepEqual([...balances(parseCsv(csv))], [["ABC-1", 6], ["XYZ-2", 9]]);
});

test("R2 history matches an item whatever the letter case of query or data", () => {
	const movements = parseCsv(csv);
	for (const query of ["abc-1", "ABC-1", " aBc-1 "]) {
		assert.deepEqual(history(movements, query).map((m) => m.date), ["2026-01-02", "2026-01-03", "2026-01-04"], query);
	}
});

test("R3 the CLI prints item codes in upper case", () => {
	const balance = runCli(["balance", "f.csv"], read);
	assert.equal(balance.code, 0);
	assert.match(balance.stdout, /^ABC-1 +6$/m);
	assert.doesNotMatch(balance.stdout, /abc-1|Abc-1|xyz-2/);
	assert.equal(runCli(["low", "f.csv", "--threshold", "100"], read).stdout, "ABC-1 (6)\nXYZ-2 (9)");
	assert.equal(runCli(["history", "f.csv", "abc-1"], read).stdout.split("\n").length, 3);
});
