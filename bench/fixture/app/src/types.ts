/** One stock movement from the ledger CSV. */
export interface Movement {
	/** Calendar date, `YYYY-MM-DD`. */
	date: string;
	/** Item code. */
	sku: string;
	/** Positive when stock is received, negative when it is shipped. */
	qty: number;
	/** Free text; may be empty. */
	note: string;
}

/** Optional inclusive date range; a missing end matches everything on that side. */
export interface DateRange {
	from?: string;
	to?: string;
}
