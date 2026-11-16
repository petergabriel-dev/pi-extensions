import type { Movement } from "./types.ts";

const HEADER = "date,sku,qty,note";

/** Canonical form of an item code: trimmed and upper-case. */
export function normalizeSku(sku: string): string {
	return sku.trim().toUpperCase();
}

/**
 * Parses ledger CSV text into movements.
 * A header line and blank lines are skipped. Lines that cannot be read are skipped too.
 */
export function parseCsv(text: string): Movement[] {
	const movements: Movement[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.toLowerCase() === HEADER) continue;
		const [date, sku, qty, ...note] = line.split(",");
		const amount = Number(qty);
		if (!date || !sku || qty === undefined || qty.trim() === "" || Number.isNaN(amount)) continue;
		movements.push({ date: date.trim(), sku: normalizeSku(sku), qty: amount, note: note.join(",").trim() });
	}
	return movements;
}
