import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { balances, history, lowStock } from "./ledger.ts";
import { parseCsv } from "./parse.ts";
import { formatBalances, formatHistory } from "./report.ts";

const USAGE = `usage:
  ledger balance <file> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  ledger history <file> <sku> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  ledger low <file> --threshold <n>`;

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function formatQty(qty: number): string {
	const sign = qty < 0 ? "-" : "";
	return sign + Math.abs(qty).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const readFile = (file: string) => readFileSync(file, "utf8");

/** Runs one command and returns its output instead of printing it, so it can be tested. */
export function runCli(args: string[], read: (file: string) => string = readFile): CliResult {
	const [command, file, ...rest] = args;
	if (!command || !file) return { code: 1, stdout: "", stderr: USAGE };
	let text: string;
	try {
		text = read(file);
	} catch {
		return { code: 1, stdout: "", stderr: `cannot read ${file}` };
	}
	const movements = parseCsv(text);
	const range = { from: option(rest, "--from"), to: option(rest, "--to") };
	switch (command) {
		case "balance":
			return { code: 0, stdout: formatBalances(balances(movements, range)), stderr: "" };
		case "history": {
			const sku = rest[0];
			if (!sku || sku.startsWith("--")) return { code: 1, stdout: "", stderr: USAGE };
			return { code: 0, stdout: formatHistory(history(movements, sku, range)), stderr: "" };
		}
		case "low": {
			const threshold = Number(option(rest, "--threshold"));
			if (!Number.isFinite(threshold)) return { code: 1, stdout: "", stderr: "--threshold must be a number" };
			const totals = balances(movements);
			const lines = lowStock(totals, threshold).map((sku) => `${sku} (${formatQty(totals.get(sku) ?? 0)})`);
			return { code: 0, stdout: lines.join("\n"), stderr: "" };
		}
		default:
			return { code: 1, stdout: "", stderr: USAGE };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = runCli(process.argv.slice(2));
	if (result.stdout) process.stdout.write(`${result.stdout}\n`);
	if (result.stderr) process.stderr.write(`${result.stderr}\n`);
	process.exitCode = result.code;
}
