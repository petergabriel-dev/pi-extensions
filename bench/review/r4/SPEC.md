# Feature: balance for one month

Add `--month YYYY-MM` to `ledger balance`: only movements in that calendar month count. `--month` cannot be combined with `--from` or `--to`; doing so prints `use --month or --from/--to, not both` and exits 1.

Other commands keep their current behavior. Add a test for it.
