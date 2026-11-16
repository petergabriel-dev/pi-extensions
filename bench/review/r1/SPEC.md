# Feature: total shipped

Add `totalShipped(movements, sku?)` to `src/ledger.ts`. It returns the total quantity shipped (the sum of negative quantities) as a positive number. When `sku` is given, only that item counts; item codes match regardless of letter case.

Add tests for it.
