import type { Movement } from "./types.ts";

function formatQty(qty: number): string {
	const sign = qty < 0 ? "-" : "";
	const digits = Math.abs(qty).toString();
	return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Two-column balance table: SKU left-aligned, quantity right-aligned. */
export function formatBalances(totals: Map<string, number>): string {
	const rows = [...totals.entries()].map(([sku, qty]) => [sku, formatQty(qty)]);
	const skuWidth = Math.max(3, ...rows.map(([sku]) => sku.length));
	const qtyWidth = Math.max(3, ...rows.map(([, qty]) => qty.length));
	const lines = [`${"SKU".padEnd(skuWidth)}  ${"QTY".padStart(qtyWidth)}`];
	for (const [sku, qty] of rows) lines.push(`${sku.padEnd(skuWidth)}  ${qty.padStart(qtyWidth)}`);
	return lines.join("\n");
}

/** One line per movement: date, signed quantity, note. */
export function formatHistory(movements: Movement[]): string {
	return movements
		.map((movement) => `${movement.date}  ${movement.qty > 0 ? "+" : ""}${formatQty(movement.qty)}  ${movement.note}`.trimEnd())
		.join("\n");
}
