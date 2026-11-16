import { inRange } from "./dates.ts";
import { normalizeSku } from "./parse.ts";
import type { DateRange, Movement } from "./types.ts";

const bySku = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Stock on hand per SKU for movements inside the range, sorted by SKU. */
export function balances(movements: Movement[], range: DateRange = {}): Map<string, number> {
	const totals = new Map<string, number>();
	for (const movement of movements) {
		if (!inRange(movement.date, range.from, range.to)) continue;
		totals.set(movement.sku, (totals.get(movement.sku) ?? 0) + movement.qty);
	}
	return new Map([...totals.entries()].sort(([a], [b]) => bySku(a, b)));
}

/** Movements for one SKU inside the range, oldest first. */
export function history(movements: Movement[], sku: string, range: DateRange = {}): Movement[] {
	const wanted = normalizeSku(sku);
	return movements
		.filter((movement) => movement.sku === wanted && inRange(movement.date, range.from, range.to))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** SKUs whose balance is below the threshold, in balance order. */
export function lowStock(totals: Map<string, number>, threshold: number): string[] {
	return [...totals.entries()].filter(([, qty]) => qty < threshold).map(([sku]) => sku);
}
