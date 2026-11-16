# Change: report bad CSV lines instead of skipping them

Today `parseCsv` silently drops lines it cannot read, so a typo quietly changes stock totals. Make every problem visible.

## Requirements

- **R1** — `parseCsv(text)` returns `{ movements, errors }` instead of an array. `movements` is the list of `Movement`s, as before. `errors` is a list of `ParseError` objects, `{ line: number; message: string }`, where `line` is the 1-based line number in the input text (the header, when present, is line 1). Export the `ParseError` type from `src/types.ts`. Blank lines and the header line are skipped without an error, as today.
- **R2** — A non-blank line is an error, and produces no movement, when it has fewer than three fields, when its date is not a real calendar date written `YYYY-MM-DD`, when its item code is empty, or when its quantity is not a non-zero whole number. Each bad line gives exactly one error with a non-empty message.
- **R3** — Good lines are still returned, in input order, when other lines have errors.
- **R4** — Every caller of `parseCsv` in `src/` uses the new return value, and every CLI command keeps working on valid files.
- **R5** — When the file has any errors, the CLI exits with code 2, prints nothing to stdout, and prints one line per error to stderr in the form `line <n>: <message>`, in line order.
- **R6** — A new CLI flag, `--lenient`, accepted by every command, still prints the errors to stderr in the same form, but the command's normal output goes to stdout and the exit code is 0.

## Acceptance criteria

- All six requirements hold.
- Existing tests are updated to the new return value, new tests cover the new behavior, and `npm test` passes.
