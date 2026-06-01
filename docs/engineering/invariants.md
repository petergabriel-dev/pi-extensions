# Invariants

## Pi ↔ Claude Code bridge

- Claude Code side must have zero Pi internal imports. `agent/claude-bridge-client/*` uses Node stdlib/file IPC only.
- Pi bridge extension is the only Pi-coupled bridge layer and must reuse/export real sibling extension functions instead of copying logic.
- `capture_note` success requires active Pi bridge response and `widgetUpdated:true`; no silent queue or later replay is considered success.
- `capture_note` must be applied by the live `discussion-notes` extension instance through the event bus; the bridge must not import/render private discussion-notes state.
- Bridge tools fail loudly if Pi bridge is down or stale. No direct memory-file fallback is allowed.
- `.pi` marker presence is the only condition for Claude Code read-only enforcement.
- Claude Code mutation tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) are always denied in `.pi` projects.
- Claude Code Bash in `.pi` projects must read a fresh bridge `policy.json`; missing/stale policy denies closed.
- Bridge requests are idempotent by UUID. Replayed request IDs return the processed response and must not duplicate notes, staging candidates, or saved plans.
- v1 supports one active Pi bridge session per project. A second active watcher must become passive/refuse rather than process the same request stream.
- `save_plan` must update live `workflow-modes` state, not only append a raw `workflow-plan` entry.
- Docs tag validation must use Pi `engineering-docs` validation logic; bare `[DOCS]` is invalid and `[DOCS:decisions]` requires an ADR action tag.

## Pi subagents

- `spawn_worker` must query live workflow mode through the event bus before spawning and must refuse unless mode is `build`. This gate lives in the parent tool because worker children have coding tools.
- Child sessions must not inherit the parent workflow-modes `tool_call` hook. `runSubagent()` uses a `DefaultResourceLoader` with `noExtensions: true`, and the parent performs the worker build-mode check before child creation.
- Explorer tools are read-only by construction. `spawn_explorer` refuses agent definitions whose tools include anything outside `read`, `grep`, `find`, and `ls`.
- Only a child subagent's final structured return may enter parent context. The child transcript remains in the persisted child session and is not appended to the parent branch.
- Spawn graph is bounded to `main -> worker -> explorer`, max depth 2. Workers receive nested `spawn_explorer`; workers do not receive `spawn_worker`; explorers receive no spawn tools.
- Global subagent concurrency defaults to 3 via the default lane. Nested worker-spawned explorers use the reserved explorer lane so workers cannot deadlock waiting on default worker slots.
- Parallel worker file ownership must not overlap. `spawn_worker` refuses an overlapping `fileOwnership` request while another worker owns the same path/subtree.
- Progress widget updates must be keyed by `subagents-progress`, throttled to 250 ms, and cleared when all runs finish.

## Persistent-Memory Reconciliation

- Reconciliation uses partial-batch acceptance; valid actions are applied immediately to markdown files/index db, and leftover/offending candidates are re-staged back to staging files under the project memory directory, grouped by `session_id` using `schemaVersion: 1`.
- Reconciliation/extraction custom models (configured via `PERSISTENT_MEMORY_RECONCILIATION_MODEL` and `PERSISTENT_MEMORY_EXTRACTION_MODEL` environment variables) must be resolved via the `ModelRegistry` and verified using `hasConfiguredAuth` to ensure valid credentials/keys are configured before use, falling back to `ctx.model` on any resolution or auth failure.
- Exactly one repair retry attempt with gate-level error details appended is made if the model produces malformed or invalid actions, before falling back to partial-batch application.
- Leftover candidates from partial-mode reconciliation are bounded by a configurable max attempt count (default 3); every leftover is exactly either re-staged (with incremented attempts) or dead-lettered, guaranteeing no candidate is dropped, duplicated, or re-staged indefinitely.
- The attempt counter travels on the candidate object (`reconcile_attempts`), never keyed by temporary candidate references (refs), ensuring stability across array re-indexing during staging updates.
- **Reload Skips All Memory Work:** When `event.reason === "reload"`, start-time reconciliation, shutdown-time extraction, and shutdown-time reinforcement (markdown write and SQLite index rebuild) are completely skipped. The session firing log is preserved (not cleared) across a reload so reinforcement bumps apply at the next real shutdown ([index.ts#L143-L147](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L143-L147), [index.ts#L250](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L250), [index.ts#L304](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L304), and [index.ts#L324-L326](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L324-L326)).
- **Session Starts Never Block:** The `session_start` event handler for `"startup"`, `"new"`, `"resume"`, and `"fork"` must return immediately after reopening index.db, scheduling reconciliation in a non-blocking background task so the prompt is interactive without awaiting LLM calls ([index.ts#L131-L157](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L131-L157)).
- **Quit Stays Blocking:** The `session_shutdown` handler for `"quit"` must block until extraction and reinforcement are completed to ensure that candidates are saved to disk before the Node process exits ([index.ts#L246-L329](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L246-L329)).
- **Generation-Guarded Non-Lossy Swap:** Background reconciliation must only swap the rebuilt SQLite db index connection to the active state if `lifecycleGeneration` remains identical to when the task started. If a mismatch is detected, the database connection is closed and discarded without writing, relying on persisted markdown and staging files which remain preserved and non-lossy for the next run ([index.ts#L391-L485](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L391-L485)).
- **Synchronous Snapshot and Context Capture Before Shutdown Return:** During session replacements (`new`, `resume`, `fork`), the shutdown handler must synchronously snapshot the branch history, clone memory paths, and capture all `ctx`-derived values (such as `cwd`, `model`, `modelRegistry`, and `thinkingLevel` via `captureCtx`) before returning control or allowing session disposal. The deferred background task must reference zero properties of the live `ctx` object, ensuring it runs against a stable, detached copy of the transcript and context values without throwing stale context errors ([index.ts#L252-L262](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L252-L262), [lifecycle.ts#L62-L76](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/lifecycle.ts#L62-L76)).



