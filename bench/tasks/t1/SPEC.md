# Bug: letter case splits one item into several

Warehouse staff type item codes in any letter case, so the same item appears as `abc-1`, `ABC-1`, or ` Abc-1 `. The ledger treats these as different items: balances are split across them, and looking up an item's history misses most of its movements.

Item codes must be case-insensitive everywhere.

## Requirements

- **R1** — Balances count every letter-case variant of an item code toward one item, shown in upper case (`ABC-1`). Surrounding spaces are ignored, as they are today.
- **R2** — `history` returns all of an item's movements, whatever letter case the CSV or the requested item code uses.
- **R3** — Every item code the CLI prints (`balance`, `history`, `low`) is upper case.

## Acceptance criteria

- The three requirements hold for CSV input and for the CLI.
- Existing tests still pass (`npm test`).
