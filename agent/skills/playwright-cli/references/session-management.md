# Browser session handling

Use a named, in-memory session for isolated review work:

```bash
playwright-cli -s=frontend-review open <url>
playwright-cli -s=frontend-review snapshot
playwright-cli -s=frontend-review close
```

`playwright-cli list` shows active sessions; `playwright-cli close-all` closes them. Close the session when verification ends. Use persistent profiles or saved storage only when explicitly needed and authorized; never save real credentials or commit browser state files.
