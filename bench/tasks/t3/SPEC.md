# Refactor: one quantity formatter

`formatQty` is copied in both `src/report.ts` and `src/cli.ts`. Keep a single copy.

## Requirements

- **R1** — A new module, `src/format.ts`, exports `formatQty(qty: number): string` with today's behavior: `,` thousands separators, a leading `-` for negative numbers, and no sign for zero or positive numbers.
- **R2** — `src/report.ts` and `src/cli.ts` import `formatQty` from `./format.ts`. No other file in `src/` defines its own `formatQty`.
- **R3** — No behavior change: every CLI command and report function gives exactly the same output as before for the same input.

## Acceptance criteria

- Existing tests pass without being edited (`npm test`).
- No new dependencies.
