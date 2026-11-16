const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a real calendar date written as `YYYY-MM-DD`. */
export function isValidDate(value: string): boolean {
	const match = DATE.exec(value);
	if (!match) return false;
	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Inclusive range check on `YYYY-MM-DD` strings. */
export function inRange(date: string, from?: string, to?: string): boolean {
	return (from === undefined || date >= from) && (to === undefined || date <= to);
}
