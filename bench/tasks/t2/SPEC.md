# Feature: monthly totals

Planners want to see how much stock came in and went out each month.

## Requirements

- **R1** — `src/ledger.ts` exports `monthlyTotals(movements, sku?)`. It returns one entry per calendar month that has movements, oldest month first. Each entry has exactly these fields:
  - `month` — `YYYY-MM`
  - `received` — the sum of positive quantities
  - `shipped` — the sum of negative quantities, as a positive number
  - `net` — `received - shipped`
- **R2** — When `sku` is given, only that item's movements count. The item code matches regardless of letter case or surrounding spaces.
- **R3** — A new CLI command, `ledger monthly <file> [--sku <sku>]`, prints one line per month in the form `YYYY-MM  +<received>  -<shipped>  <net>`, with two spaces between columns. Quantities use the same thousands separators as the other commands. `received` and `shipped` always carry their `+` or `-` sign, even when zero; `net` shows a `-` only when negative. Example: `2026-01  +1,504  -200  1,304`. With no movements, it prints nothing and exits 0. Add the command to the usage text.
- **R4** — Add tests for `monthlyTotals` and for the `monthly` command to the test suite in `test/`. `npm test` must pass.

## Acceptance criteria

- All four requirements hold.
- Existing commands, functions, and tests behave as before.
