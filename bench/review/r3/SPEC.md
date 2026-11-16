# Feature: balance across several files

`ledger balance` accepts more than one file:

```
ledger balance <file> [<file>...] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

Balances combine the movements from all files. If any file cannot be read, print `cannot read <file>` and exit 1, as happens today for a single file.

Add a test for it.
