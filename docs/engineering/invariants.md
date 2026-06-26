# Invariants

## Pi ↔ Claude Code bridge

- Claude Code side must have zero Pi internal imports. `agent/claude-bridge-client/*` uses Node stdlib/file IPC only.
- Pi bridge extension is the only Pi-coupled bridge layer and must reuse/export real sibling extension functions instead of copying logic.
- `capture_note` success requires active Pi bridge response and `widgetUpdated:true`; no silent queue or later replay is considered success.
- `capture_note` must be applied by the live `discussion-notes` extension instance through the event bus; the bridge must not import/render private discussion-notes state.
- Bridge tools fail loudly if Pi bridge is down or stale. No direct memory-file fallback is allowed.
- `.pi` marker presence is the only condition for Claude Code read-only enforcement.
- Claude Code mutation tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) are always denied in `.pi` projects.
- Claude Code Bash in `.pi` projects must not depend on bridge `policy.json` freshness, `planBashAllow`, or any Pi round-trip for allow/deny decisions.
- Claude Code Bash in `.pi` projects must deny `dangerouslyDisableSandbox`; sandbox bypass flags are not allowed in read-only bridge mode.
- When `sandbox-exec` is available, Claude Code Bash must be wrapped through `hookSpecificOutput.updatedInput.command` and allowed only through that Seatbelt sandbox.
- When `sandbox-exec` is unavailable, Claude Code Bash in `.pi` projects must deny closed; there is no unsandboxed allowlist fallback.
- Bridge requests are idempotent by UUID. Replayed request IDs return the processed response and must not duplicate notes, staging candidates, or saved plans.
- v1 supports one active Pi bridge session per project. A second active watcher must become passive/refuse rather than process the same request stream.
- `save_plan` must update live `workflow-modes` state, not only append a raw `workflow-plan` entry.
- Docs tag validation must use Pi `engineering-docs` validation logic; bare `[DOCS]` is invalid and `[DOCS:decisions]` requires an ADR action tag.

## Workflow modes read-only Bash

- Discuss/plan Bash must prefer structural sandbox wrapping over regex gating. Regex allow/deny policy is fallback only when no launcher exists or wrapping fails.
- Structural read-only Bash must deny network access and writes to the repo and `$HOME` while allowing reads, read-only interpreters, and writes under scratch `TMPDIR`.
- Scratch paths used in sandbox profiles must be resolved through real paths when they already exist, because macOS `/tmp` paths resolve under `/private/var`.
- With no sandbox launcher, `wrapCommand()` must return the original command with `wrapped:false`; callers must then apply conservative policy and must not treat this as approval.
- Behavioral sandbox tests must cover repo read, scratch write, repo write denial, network denial, and interpreter read when a real launcher is present.

## Pi subagents

- `spawn_worker` must query live workflow mode through the event bus before spawning and must refuse unless mode is `build`. This gate lives in the parent tool because worker children have coding tools.
- Child sessions must not inherit the parent workflow-modes `tool_call` hook. `runSubagent()` uses a `DefaultResourceLoader` with `noExtensions: true`, and the parent performs the worker build-mode check before child creation.
- Explorer tools are read-only by construction. `spawn_explorer` refuses agent definitions whose tools include anything outside `read`, `grep`, `find`, and `ls`.
- Only a child subagent's final structured return may enter parent context. The child transcript remains in the persisted child session and is not appended to the parent branch.
- Spawn graph is bounded to `main -> worker -> explorer`, max depth 2. Workers receive nested `spawn_explorer`; workers do not receive `spawn_worker`; explorers receive no spawn tools.
- Global subagent concurrency defaults to 3 via the default lane. Nested worker-spawned explorers use the reserved explorer lane so workers cannot deadlock waiting on default worker slots.
- Parallel worker file ownership must not overlap. `spawn_worker` refuses an overlapping `fileOwnership` request while another worker owns the same path/subtree.
- Progress widget updates must be keyed by `subagents-progress`, throttled to 250 ms, and cleared when all runs finish.
- Subagent idle timeout must measure time since the last child event, not time since spawn. `runSubagent()` must call `watchdog.touch()` for every child `AgentSessionEvent`, so `message_update` streaming and tool lifecycle activity cannot trip idle timeout while active (agent/extensions/subagents/spawn.ts:349-362).
- Subagent `maxTotalMs` is an absolute backstop and must not be reset by child events. The watchdog arms it once and only resets the idle timer from `touch()` (agent/extensions/subagents/timeout.ts:61-68).
- Legacy subagent `timeoutMs` is a backward-compatible alias for idle timeout. Effective timeout resolution must be per-call `idleTimeoutMs`, else per-call `timeoutMs`, else `subagents.idleTimeoutMs`, else default; `maxTotalMs` resolves per-call, then settings, then default (agent/extensions/subagents/spawn.ts:312-315, agent/extensions/subagents/index.ts:461-466).
- Timed-out subagent failures must preserve recoverable child text and include structured `failureKind` plus `partialWork`; `partialWork` is true once any child tool execution has started (agent/extensions/subagents/spawn.ts:60-73, agent/extensions/subagents/spawn.ts:430-440).

## Persistent-Memory Manual Write Pipeline

- **Single-writer canonical store:** Only foreground manual commands (`/memory consolidate`, `/memory reconcile`, `/memory recover`, and explicit review commands such as `/memory sweep`) may mutate canonical memory markdown or consume staging. `session_start` and `session_shutdown` must not run extraction, reconciliation, reinforcement, staging consumption, or firing-log clear.
- Lifecycle hooks may open/close `index.db`, refresh derived caches, inject retrieved memory, append telemetry, and update UI. They must not write `lessons.md`, `preferences.md`, `decisions.md`, `domain.md`, or delete/rewrite same-project staging.
- `/memory consolidate` must verify `ctx.sessionManager.getBranch()` exists, extract the current session into staging, run foreground reconciliation, apply reinforcement after successful reconcile, then clear firing telemetry only after reinforcement succeeds.
- `/memory reconcile`, `/memory consolidate`, and `/memory recover` must share the canonical-writer lock and fail fast when another canonical writer is active.
- `/memory recover` must either re-queue each valid deadletter candidate into valid staging or report it and leave the deadletter file in place. It must not duplicate candidates already present in staging.
- Reconciliation uses per-candidate monotonic acceptance: successful candidates are applied immediately to markdown files and incrementally upserted into SQLite.
- Reconciliation runs through `runReconciliation` in `agent/extensions/persistent-memory/consolidation/reconcile.ts`; empty-shortlist candidates must take the deterministic zero-model ADD path before any model adjudication.
- Lesson collision adjudication uses only the bounded verdict contract (`distinct`, `duplicate`, `supersedes`, `merge`). Host code fills all structural fields; model output must not provide ids, timestamps, refs, status flags, or supersede pointers.
- **Never-attempted means re-stage:** Budget-skipped, generation-stopped, no-model, and model-error candidates that were not genuinely attempted must remain in staging unchanged. They must not be dead-lettered and must not get `reconcile_attempts` bumped.
- **Attempted-under-cap means retry:** Attempted-but-unresolved candidates increment `reconcile_attempts` and remain staged while below retry cap 3. Attempted candidates at/over cap are dead-lettered with reason.
- Structurally malformed staging files are bounded: the loader must attempt in-process repair first, rewrite and process repairable files as valid, and move still-malformed files to `deadletter/` with preserved candidate/original content before deleting them from `staging/`. Wrong-project staging remains preserved for its owner.
- **T10 Validate-at-Write Extraction:** Each extracted candidate must be structurally validated before staging write (`sanitizeExtractionResult`). Malformed individual candidates are dropped with warnings; lessons missing/empty triggers derive triggers through `deriveLessonTriggers` without an extra model call.
- **T11 Reversible Offline Sweep:** `/memory sweep` may archive only unambiguously dead lesson records by flipping `meta.status` to `archived`; it must never delete records.
- The attempt counter travels on the candidate object (`reconcile_attempts`), never keyed by temporary candidate refs. Refs are positional diagnostics and run-log/deadletter evidence only.
- Manual reconciliation owns its SQLite connection, records bounded run-log metrics, and publishes its owned connection only through an await-free generation-guarded swap/discard block.
- Per-candidate run-log metrics must include outcome rows (`add`, `duplicate`, `supersede`, `merge`, `discard`, `parked`, `dead_lettered`) and discard/dup-rate metrics. `/memory status` must surface those metrics without using `setFooter`.
- `reinforcement_count` remains load-bearing for tier ranking/retrieval and low-signal detection. Reinforcement updates to markdown/index occur only inside `/memory consolidate`; firing telemetry spans sessions until a successful consolidate clears it.
- The mode-transition reminder is non-writing. It may inspect current branch content with `shouldSkipExtraction` and notify once per session when leaving discuss/plan/build, but it must not stage, reconcile, recover, or reinforce memory.
