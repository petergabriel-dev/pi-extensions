## Conventions

- **TUI surfaces use live command/session context.** Use `ctx.ui` for status/widget UI and gate those calls with `ctx.hasUI`; do not use host `pi.ui` for `setStatus`/`setWidget`.
- **Detached UI work captures a live context at trigger time and clears it in `finally`.** Subagent progress keeps a current context for scheduled redraws and drops stale contexts on render failure ([progress.ts#L22-L55](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/progress.ts#L22-L55)); long-running extension UI should follow the same pattern instead of retaining stale contexts.
- **Personal memory recall is index-first.** Inject or bridge-return `~/.pi/memory/MEMORY.md` by default, then fetch full slug files only through `recall_memory_entry` / bridge `recall_entry` when needed.
- **Personal memory saves go through the store.** Use `writeMemoryFact` so one slug file is written and `MEMORY.md` is regenerated; do not hand-append new formats to `~/.pi/memory.md`.
