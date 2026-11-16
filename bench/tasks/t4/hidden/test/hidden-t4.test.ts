import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../src/cli.ts";
import { parseCsv } from "../src/parse.ts";

const BAD_LINES = [3, 4, 5, 6, 7, 8, 9, 10];
const bad = [
	"date,sku,qty,note", // 1 header
	"2026-01-02,A-1,5,ok", // 2
	"2026-02-30,A-1,1,", // 3 not a real date
	"2026-1-5,A-1,1,", // 4 wrong date form
	"2026-01-06,,1,", // 5 empty item code
	"2026-01-07,A-1,1.5,", // 6 not whole
	"2026-01-08,A-1,0,", // 7 zero
	"2026-01-09,A-1,abc,", // 8 not a number
	"2026-01-10,A-1", // 9 too few fields
	"2026-01-11, ,3,", // 10 blank item code
	"", // 11 blank line
	"2026-01-12,b-2,-2,late, really", // 12
].join("\n");
const good = "date,sku,qty,note\n2026-01-02,A-1,5,ok\n2026-01-12,B-2,-2,late\n";
const lineNumbers = (stderr: string) => stderr.split("\n").filter(Boolean).map((line) => {
	const match = /^line (\d+): \S.*$/.exec(line);
	assert.ok(match, `stderr line has the form "line <n>: <message>": ${JSON.stringify(line)}`);
	return Number(match[1]);
});
const result = (text: string) => parseCsv(text) as unknown as { movements: unknown[]; errors: Array<{ line: number; message: string }> };

test("R1 parseCsv returns movements and errors", () => {
	const parsed = result(good);
	assert.ok(parsed && Array.isArray(parsed.movements) && Array.isArray(parsed.errors), "returns { movements, errors }");
	assert.deepEqual(parsed.movements, [
		{ date: "2026-01-02", sku: "A-1", qty: 5, note: "ok" },
		{ date: "2026-01-12", sku: "B-2", qty: -2, note: "late" },
	]);
	assert.deepEqual(parsed.errors, []);
	assert.deepEqual(result("\n2026-01-02,A-1,5,\n").errors, [], "blank lines are not errors");
});

test("R2 each bad line gives exactly one error with its line number", () => {
	const { errors } = result(bad);
	assert.deepEqual(errors.map((error) => error.line), BAD_LINES);
	for (const error of errors) assert.ok(typeof error.message === "string" && error.message.trim().length > 0, `message for line ${error.line}`);
});

test("R3 good lines are kept in order alongside errors", () => {
	assert.deepEqual(result(bad).movements, [
		{ date: "2026-01-02", sku: "A-1", qty: 5, note: "ok" },
		{ date: "2026-01-12", sku: "B-2", qty: -2, note: "late, really" },
	]);
});

test("R4 every CLI command works on a valid file", () => {
	const read = () => good;
	assert.deepEqual(runCli(["balance", "f.csv"], read), { code: 0, stdout: "SKU  QTY\nA-1    5\nB-2   -2", stderr: "" });
	assert.deepEqual(runCli(["history", "f.csv", "a-1"], read), { code: 0, stdout: "2026-01-02  +5  ok", stderr: "" });
	assert.deepEqual(runCli(["low", "f.csv", "--threshold", "0"], read), { code: 0, stdout: "B-2 (-2)", stderr: "" });
});

test("R5 errors make the CLI exit 2 with one stderr line each", () => {
	for (const args of [["balance", "f.csv"], ["history", "f.csv", "A-1"], ["low", "f.csv", "--threshold", "3"]]) {
		const out = runCli(args, () => bad);
		assert.equal(out.code, 2, args.join(" "));
		assert.equal(out.stdout, "", args.join(" "));
		assert.deepEqual(lineNumbers(out.stderr), BAD_LINES, args.join(" "));
	}
});

test("R6 --lenient reports errors and still prints output", () => {
	const balance = runCli(["balance", "f.csv", "--lenient"], () => bad);
	assert.equal(balance.code, 0);
	assert.equal(balance.stdout, "SKU  QTY\nA-1    5\nB-2   -2");
	assert.deepEqual(lineNumbers(balance.stderr), BAD_LINES);
	const low = runCli(["low", "f.csv", "--threshold", "0", "--lenient"], () => bad);
	assert.equal(low.code, 0);
	assert.equal(low.stdout, "B-2 (-2)");
	const history = runCli(["history", "f.csv", "b-2", "--lenient"], () => bad);
	assert.equal(history.code, 0);
	assert.equal(history.stdout, "2026-01-12  -2  late, really");
});
