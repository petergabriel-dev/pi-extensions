# Architecture

## Pi ↔ Claude Code bridge

Claude Code is a read-only planning surface for existing Pi projects. Pi remains source of truth for memory, docs validation, discussion notes, and build handoff.

Flow:

1. Pi loads `agent/extensions/claude-bridge/index.ts` in an active interactive session.
2. Bridge resolves project memory from nearest `.pi/` marker via Pi memory path logic.
3. Bridge creates `<project>/.pi/memory/bridge/{requests,responses,processed}` plus `session.json` and `policy.json`.
4. Claude Code MCP client `agent/claude-bridge-client/pi-bridge-mcp.js` writes UUID request JSON files and polls matching responses for up to 2s.
5. Pi bridge handles `recall`, `capture`, `validate_tags`, and `save_plan` by reusing Pi-side extension functions.
6. Bridge recall responses include `prompts.discussPrompt`, `prompts.planPrompt`, and `prompts.buildPrompt` sourced from workflow-modes constants; Claude commands treat those strings as authoritative mode behavior instead of duplicating them.
7. Claude Code never imports Pi internals; only the Pi bridge extension imports sibling Pi extension code.

Core boundaries:

- **Pi bridge extension:** Pi-coupled layer. Reuses workflow-modes, discussion-notes, persistent-memory, and engineering-docs code.
- **Claude MCP client:** Thin file-protocol client. Node stdlib only; no Pi imports.
- **Claude PreToolUse hook:** Fail-closed read-only guard for any cwd under a `.pi` marker. It blocks mutation tools and `dangerouslyDisableSandbox`. On macOS with `/usr/bin/sandbox-exec`, Bash is allowed only by rewriting the command through a Seatbelt sandbox. If that sandbox is unavailable, Bash denies closed rather than using an unsandboxed regex allowlist.

Bridge request protocol lives under `<project>/.pi/memory/bridge/`:

- `requests/<uuid>.json`: `{ id, type, payload, ts }`
- `responses/<uuid>.json`: `{ id, ok, result | error }`
- `processed/<uuid>.json`: idempotency cache
- `policy.json`: fresh Bash/read-only policy snapshot sourced from Pi workflow-modes exports
- `session.json`: active bridge session lock + heartbeat

`capture` and `save_plan` use the Pi event bus rather than imported extension module state. `claude-bridge` emits `discussion-notes:add`; the live `discussion-notes` extension updates its own notes array, appends the session snapshot, and redraws the Notes widget. `claude-bridge` emits `workflow-modes:save-plan`; the live `workflow-modes` extension updates its own `currentPlan`, appends `workflow-plan`, and returns `workflow-modes:save-plan-result`.

## Workflow modes read-only Bash sandbox

`agent/extensions/workflow-modes/index.ts` owns Pi-side mode prompts and discuss/plan tool gating. Mode prompt constants are also the single source of truth for the ponytail lazy-senior-dev reflex: Build carries the full minimal-code ruleset, while Discuss and Plan carry the scope-time subset that questions need, separates required behavior from nice-to-haves, and preserves non-negotiable correctness guardrails. Prompt injection in `before_agent_start` directs subagent delegation when the subagents extension is available: Discuss keeps quick lookups inline and uses `spawn_explorer` only for genuine multi-file/symbol sweeps; Plan defaults multi-file/symbol fan-out to `spawn_explorer` while the parent synthesizes; Build uses the worker-orchestration A+B model and spawns one `spawn_worker` per substantial confirmed saved-plan Section-4 task, with the parent retaining task selection, verification, commit, and confirmation. This integration is prompt-only; structural gates remain unchanged.

Mutation tools remain blocked in discuss/plan. For Bash, the hook first tries `wrapCommand()` from `agent/extensions/workflow-modes/sandbox.ts`; when a launcher is detected, the command is rewritten in place before execution. If no launcher exists, or wrapping throws, the hook falls back to the shared regex policy from `policy.ts`.

Supported launcher paths:

- macOS: `/usr/bin/sandbox-exec`, with a Seatbelt profile denying `network*` and `file-write*`, then re-allowing writes under a scratch `TMPDIR` and `/dev/null`.
- Linux: `bwrap`, with `--unshare-net`, a read-only bind of `/`, scratch `TMPDIR`, and `PYTHONDONTWRITEBYTECODE=1`.
- No launcher: conservative read-only allowlist plus mutation/redirect denies.

The Pi bridge still writes `policy.json` snapshots for clients and compatibility, but Claude bridge read-only Bash no longer depends on policy freshness or `planBashAllow` gating. Its Node-stdlib PreToolUse hook returns `hookSpecificOutput.updatedInput` so macOS Claude Code Bash calls under `.pi` projects are wrapped in `sandbox-exec` whenever available. Missing, stale, or expired bridge policy does not block sandboxed Bash; absence of `sandbox-exec` blocks Bash entirely.

## Pi subagents

Pi subagents live in `agent/extensions/subagents/` and run as persisted in-process child `AgentSession`s created from extension tool execution. The parent exposes `spawn_explorer` and `spawn_worker`; both call `runSubagent()` in `agent/extensions/subagents/spawn.ts`, which creates a fresh `SessionManager.create(ctx.cwd)`, disables child extension/theme/skill/context-file discovery, and captures only the final structured return for the parent.

Roles:

- **Explorer:** read-only discovery role. `spawn_explorer` validates tools are limited to `read`, `grep`, `find`, and `ls` before spawning. It works in all workflow modes and returns parsed summary/findings/files/open questions. Workflow mode prompts use it with thresholds: sparse in Discuss, default for Plan fan-out.
- **Worker:** coding role. `spawn_worker` first queries `workflow-modes:get` and refuses unless `workflow-modes:state.mode === "build"`. Worker children receive coding tools plus a nested `spawn_explorer` custom tool; they do not receive `spawn_worker`. Build-mode prompts direct sequential one-worker-per-substantial-saved-task delegation while keeping verification, commits, and confirmation in the parent.

Child sessions are persisted as normal Pi sessions, making each subagent run inspectable after completion and providing the session-file foundation for future Context Transfer branch artifacts. The child transcript is not appended to the parent branch; parent context receives only the structured result object and short tool result text.

Concurrency is managed by `agent/extensions/subagents/concurrency.ts`: a configurable default lane (default cap 3), a reserved explorer lane for nested worker→explorer calls, and a worker file-ownership overlap guard. Progress visibility is handled by `agent/extensions/subagents/progress.ts`, which renders the keyed `subagents-progress` widget at a 250 ms throttle and clears it when runs finish.

Subagent timeouts are idle-based with an absolute backstop. `agent/extensions/subagents/timeout.ts` provides a host-import-free watchdog with `touch()` resetting only the idle timer and `maxTotalMs` remaining absolute (timeout.ts:28-83). `runSubagent()` touches the watchdog on every child `AgentSessionEvent`, so streaming `message_update` events and tool lifecycle events keep an active child alive while silence past `idleTimeoutMs` aborts as `failureKind: "idle"` (spawn.ts:349-362, spawn.ts:384-400). `maxTotalMs` aborts continuously active runaway children as `failureKind: "max_total"`; timeout failures preserve partial output and include `partialWork` (spawn.ts:60-73, spawn.ts:430-440). `spawn_explorer`, nested explorer, `spawn_worker`, and `subagents_debug_run_agent` resolve `idleTimeoutMs`/`maxTotalMs` from per-call params, then `subagents` settings, then defaults; deprecated `timeoutMs` maps to idle timeout (index.ts:63-66, index.ts:461-466, index.ts:551-560, index.ts:675-684, index.ts:755-764, index.ts:925-933).

## Persistent-Memory Write Pipeline

Persistent memory is local-first markdown plus SQLite indexing under `<project>/.pi/memory/`. The write path is split into extraction, staging, reconciliation, indexing, observability, and sweep/review phases.

1. **Reason-aware lifecycle:** `session_start`/`session_shutdown` reasons are classified via `classifyReason`. Reload bypasses model work and reinforcement; non-reload starts open `index.db` synchronously and schedule reconciliation in a non-blocking background task; `quit` blocks on extraction/reinforcement so candidates are saved before process exit.
2. **Validate-at-write extraction:** Extraction parses careful-model output, sanitizes each candidate before staging, drops malformed individual candidates, and derives lesson triggers deterministically when missing/empty. Malformed candidates should not enter `staging/`.
3. **Terminal staging queue:** Same-project staging files are consumed in one reconciliation run. Successfully committed candidates are removed with their file; unresolved candidates are written to `deadletter/`; wrong-project files are terminal for the current project and left for their owner.
4. **Per-candidate reconciliation:** `runReconciliation` prepares refs, pre-filters exact duplicates, shortlists same-scope lexical collisions, deterministically adds empty-shortlist candidates with zero model calls, and adjudicates lesson collisions through a bounded verdict contract (`distinct`, `duplicate`, `supersedes`, `merge`).
5. **Deterministic state transitions:** Code owns ids, timestamps, scopes, refs, trigger preservation/derivation, reinforcement counts, status flags, and supersede pointers. Models do not emit structural fields. Supersede/merge are reversible status/pointer transitions and records are never deleted.
6. **Incremental SQLite writes:** Reconcile owns a dedicated SQLite connection. After each successful candidate/batch markdown commit, changed records are upserted into that connection; candidate-processing paths do not perform a final whole-index rebuild-and-swap. Generation guards prevent stale owned connections from replacing the active handle.
7. **Run-log observability:** The bounded append-only run-log records run counts, per-candidate outcomes, and discard/dup-rate metrics. `/memory status` surfaces recent runs without using `setFooter`.
8. **Offline sweep/review:** `/memory sweep` archives only unambiguously dead lessons by reversible status flag, flags low-signal lessons for review, and queues suspected contradiction groups without auto-resolving them.

