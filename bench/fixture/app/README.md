# stock-ledger

A small stock ledger. It reads a CSV file of stock movements and reports what is on hand.

No dependencies: Node 22.19 or later runs the TypeScript sources directly.

## CSV format

```
date,sku,qty,note
2026-01-02,ABC-1,40,first delivery
2026-01-09,ABC-1,-3,order 1001
```

- `date` is `YYYY-MM-DD`.
- `qty` is positive for stock received and negative for stock shipped.
- `note` is optional and may contain commas.

## CLI

```
npm run ledger -- balance examples/stock.csv [--from YYYY-MM-DD] [--to YYYY-MM-DD]
npm run ledger -- history examples/stock.csv <sku> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
npm run ledger -- low examples/stock.csv --threshold <n>
```

Date ranges include both end dates.

## Layout

- `src/types.ts` — shared types
- `src/parse.ts` — CSV parsing
- `src/dates.ts` — date helpers
- `src/ledger.ts` — balances, history, low-stock checks
- `src/report.ts` — text output
- `src/cli.ts` — command-line entry point

## Tests

```
npm test
```
