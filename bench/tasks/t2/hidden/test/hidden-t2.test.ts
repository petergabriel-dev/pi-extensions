import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { parseCsv } from "../src/parse.ts";

const here = fileURLToPath(import.meta.url);
const csv = "date,sku,qty,note\n2026-03-02,B-2,-4,\n2026-01-02,A-1,1500,\n2026-01-20,B-2,4,\n2026-01-25,A-1,-200,\n2026-03-01,a-1,-1,\n";
const read = () => csv;
const pick = (rows: Array<Record<string, unknown>>) => rows.map(({ month, received, shipped, net }) => ({ month, received, shipped, net }));

async function monthlyTotals(...args: unknown[]) {
	const ledger: Record<string, unknown> = await import("../src/ledger.ts");
	assert.equal(typeof ledger.monthlyTotals, "function", "src/ledger.ts exports monthlyTotals");
	return (ledger.monthlyTotals as (...a: unknown[]) => Array<Record<string, unknown>>)(...args);
}

test("R1 monthlyTotals returns one entry per month, oldest first", async () => {
	const rows = await monthlyTotals(parseCsv(csv));
	assert.deepEqual(pick(rows), [
		{ month: "2026-01", received: 1504, shipped: 200, net: 1304 },
		{ month: "2026-03", received: 0, shipped: 5, net: -5 },
	]);
	assert.deepEqual(Object.keys(rows[0]).sort(), ["month", "net", "received", "shipped"]);
	assert.deepEqual(await monthlyTotals([]), []);
});

test("R2 the sku filter ignores letter case and spaces", async () => {
	assert.deepEqual(pick(await monthlyTotals(parseCsv(csv), " a-1 ")), [
		{ month: "2026-01", received: 1500, shipped: 200, net: 1300 },
		{ month: "2026-03", received: 0, shipped: 1, net: -1 },
	]);
});

test("R3 the monthly command prints the documented lines", () => {
	const all = runCli(["monthly", "f.csv"], read);
	assert.equal(all.code, 0);
	assert.equal(all.stdout, "2026-01  +1,504  -200  1,304\n2026-03  +0  -5  -5");
	assert.equal(runCli(["monthly", "f.csv", "--sku", "b-2"], read).stdout, "2026-01  +4  -0  4\n2026-03  +0  -4  -4");
	const empty = runCli(["monthly", "f.csv"], () => "date,sku,qty,note\n");
	assert.equal(empty.code, 0);
	assert.equal(empty.stdout, "");
	assert.match(runCli([], read).stderr, /monthly/);
});

test("R4 the visible suite covers monthlyTotals and the monthly command, and passes", () => {
	const dir = dirname(here);
	const files = readdirSync(dir).filter((name) => name.endsWith(".test.ts") && name !== basename(here));
	const sources = files.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
	assert.match(sources, /monthlyTotals/);
	assert.match(sources, /["']monthly["']/);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	execFileSync(process.execPath, ["--test", ...files.map((name) => join(dir, name))], { cwd: join(dir, ".."), env, stdio: "pipe" });
});
