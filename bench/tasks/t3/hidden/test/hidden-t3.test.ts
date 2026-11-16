import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { formatBalances, formatHistory } from "../src/report.ts";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const csv = "date,sku,qty,note\n2026-01-02,LONG-ITEM-9,1234567,big\n2026-01-03,A-1,-1500,oversold\n2026-01-04,A-1,20,\n2026-01-05,B,999,\n";
const read = () => csv;

test("R1 src/format.ts exports formatQty with the existing behavior", async () => {
	const format: Record<string, unknown> = await import("../src/format.ts");
	assert.equal(typeof format.formatQty, "function");
	const formatQty = format.formatQty as (qty: number) => string;
	assert.equal(formatQty(0), "0");
	assert.equal(formatQty(999), "999");
	assert.equal(formatQty(1000), "1,000");
	assert.equal(formatQty(1234567), "1,234,567");
	assert.equal(formatQty(-1200), "-1,200");
});

test("R2 report.ts and cli.ts import the one formatQty", () => {
	const definition = /\bfunction\s+formatQty\b|\b(?:const|let|var)\s+formatQty\s*=/;
	const definers = readdirSync(src).filter((name) => name.endsWith(".ts") && definition.test(readFileSync(join(src, name), "utf8")));
	assert.deepEqual(definers, ["format.ts"]);
	for (const name of ["report.ts", "cli.ts"]) {
		assert.match(readFileSync(join(src, name), "utf8"), /import\s*\{[^}]*\bformatQty\b[^}]*\}\s*from\s*["']\.\/format\.ts["']/, name);
	}
});

test("R3 outputs are unchanged", () => {
	assert.deepEqual(runCli(["balance", "f.csv"], read), { code: 0, stdout: "SKU                QTY\nA-1             -1,480\nB                  999\nLONG-ITEM-9  1,234,567", stderr: "" });
	assert.deepEqual(runCli(["history", "f.csv", "a-1"], read), { code: 0, stdout: "2026-01-03  -1,500  oversold\n2026-01-04  +20", stderr: "" });
	assert.deepEqual(runCli(["low", "f.csv", "--threshold", "1000"], read), { code: 0, stdout: "A-1 (-1,480)\nB (999)", stderr: "" });
	assert.equal(formatBalances(new Map([["X", 0], ["Y", -1234], ["Z", 1000000]])), "SKU        QTY\nX            0\nY       -1,234\nZ    1,000,000");
	assert.equal(formatHistory([{ date: "2026-01-01", sku: "X", qty: 12345, note: "n" }, { date: "2026-01-02", sku: "X", qty: -7, note: "" }]), "2026-01-01  +12,345  n\n2026-01-02  -7");
});
