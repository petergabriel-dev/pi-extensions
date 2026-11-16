# Feature: default low-stock threshold

Make `--threshold` optional for `ledger low`, defaulting to 10. A `--threshold` that is given without a value, or with a value that is not a number, still prints `--threshold must be a number` and exits 1.

Add tests for it.
