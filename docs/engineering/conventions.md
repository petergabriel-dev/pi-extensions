# Conventions

## Paths and package resources

- **Use repository-relative paths in source and docs.** Never commit user-home absolute paths, file-URL paths, host-specific home paths, or paths into an active `~/.pi` source checkout.
- **Resolve shipped assets from module/script location.** TypeScript uses `new URL("./asset", import.meta.url)` plus `fileURLToPath` when a filesystem path is required. Shell launchers derive root from `${BASH_SOURCE[0]}`. Do not use current working directory for package-owned assets.
- **Treat `~/.pi` only as a documented runtime location.** Literal `~/.pi` is valid when describing Pi-owned user data; it is not a source dependency.
- **Declare resources explicitly.** New extensions or skills require `package.json` manifest updates plus `scripts/check-workspace.mjs` inventory updates. New project agents require `agent/agents/` and integrity-check updates.
- **Keep project links internal.** Versioned symlinks must resolve inside repository. `.pi/agents` points to `agent/agents`; external skill/config symlinks are not package resources.

## Source and runtime separation

- Version source/config/docs only. Ignore credentials, settings snapshots, sessions, plans, personal memory, bridge IPC, caches, DBs, logs, dependency trees, and CCC indexes.
- Pi host owns auth, settings, model catalogs, and session persistence. Extensions resolve those through host APIs such as `getAgentDir()` or host defaults; do not copy them into repository.
- Project truth belongs in `docs/engineering/` and ADRs. Session discussion notes are handoff context. User-global preferences/lessons belong in indexed personal memory. Do not substitute one store for another.
- Generated docs spokes/indexes are extension-owned outputs. Edit canonical docs or ADR inputs, then regenerate; do not hand-maintain generated summaries.

## Extension state and interoperability

- **One live owner per mutable state domain.** `workflow-modes` owns workflow/plan/Caveman state; `discussion-notes` owns active notes; `personal-memory/store.ts` owns personal-memory files.
- Cross-extension mutation uses namespaced `pi.events` request/result pairs with a correlation ID, bounded wait, explicit error, and live owner response. Do not import another extension’s mutable module state.
- Direct cross-extension imports are limited to pure logic or explicit stores: prompt composition, validation, and personal-memory persistence helpers.
- Branch-local state is appended with `pi.appendEntry()` and reconstructed from `ctx.sessionManager.getBranch()` on both `session_start` and `session_tree`.
- Update durable branch entry before reporting a manual/event-driven state change as successful. If persistence fails, restore in-memory/UI state and return an error.
- Use namespaced custom-entry and event names (`workflow-*`, `discussion-notes:*`, `filechanges:*`, `engineering-docs:*`) to avoid collisions.

## Tool and lifecycle handling

- Validate all tool, bridge, hook, frontmatter, path, and settings input at its trust boundary. Bound strings, arrays, pagination, timeouts, and output where applicable.
- Prefer structural APIs over shell interpolation. External commands use `execFile` with fixed argv; untrusted query text never enters a shell command.
- For mutation tracking, capture preimages on `tool_call` but commit state only after a matching successful `tool_result`. Key pending work by tool-call ID.
- Reconstruct selected-branch state after session/tree navigation instead of trusting stale module globals.
- Read-only client guards fail closed on malformed/unknown input. State-changing harness operations route through active Pi bridge, not direct file writes.

## UI

- TUI surfaces use live command/session context. Use `ctx.ui` for status/widgets and guard UI-only behavior with `ctx.hasUI`; do not use host `pi.ui` for `setStatus` or `setWidget`.
- Detached UI work captures live context at trigger time and clears stale context on completion/failure. Subagent progress follows this pattern in `agent/extensions/subagents/progress.ts`.
- Widget/status keys are stable and extension-specific so redraw/clear operations replace owned UI only.
- Non-interactive commands must either produce usable text output or fail with an explicit instruction; never assume overlay/confirmation UI exists.

## Personal memory

- Personal-memory recall is index-first. Inject or bridge-return `~/.pi/memory/MEMORY.md`, then fetch one full slug only through `recall_memory_entry` / bridge `recall_entry`.
- Saves go through `writeMemoryFact` so one slug file is written and `MEMORY.md` is regenerated. Do not append new data to legacy `~/.pi/memory.md`.
- Slugs are validated identifiers, never paths. Callers pass slug without `.md`.

## Dependencies and checks

- Published runtime dependencies belong in the root package: `diff` is a production dependency, while `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are `"*"` peers. Keep nested extension packages, manifests, and locks for development bootstrap only; install them with `npm run bootstrap` rather than treating them as published package boundaries.
- Prefer Node standard library for bridge clients, hooks, launchers, and integrity checks when it meets requirements.
- Non-trivial policy/state logic keeps one focused runnable test. Root checks aggregate package tests/typechecks without duplicating their assertions.
- Tests must isolate temporary runtime state and remove spawned processes/files when complete.
