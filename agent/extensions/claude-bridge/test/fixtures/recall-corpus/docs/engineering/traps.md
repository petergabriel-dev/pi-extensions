# Traps

## Bridge IPC

- The request watcher uses fs.watch. Missed watch events used to become client timeouts; a 500 ms poll now backs it up.
- Never add a direct client-side plan-file fallback.

Example of a fenced block that must not split sections:

```markdown
## fake heading inside a fence
- not a real section
```

## Subagents

- Child processes run with exactly one extension path; stderr goes to the diagnostics log only.
- Watchdog timeout fails the run and releases the concurrency slot.

## Résumé of encoding traps

- Paths may contain non-ASCII characters such as é, ü and 漢字; byte budgets count UTF-8 bytes.
