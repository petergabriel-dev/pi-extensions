# Architecture

## Pi ↔ Claude Code bridge

Claude Code is a read-only planning surface for existing Pi projects. Pi remains source of truth for memory, docs validation, discussion notes, and build handoff.

Flow:

1. Pi loads `agent/extensions/claude-bridge/index.ts` in an active interactive session.
2. Bridge resolves project memory from nearest `.pi/` marker via Pi memory path logic.
3. Bridge creates `<project>/.pi/memory/bridge/{requests,responses,processed}` plus `session.json` and `policy.json`.
4. Claude Code MCP client `agent/claude-bridge-client/pi-bridge-mcp.js` writes UUID request JSON files and polls matching responses for up to 2s.
5. Pi bridge handles `recall`, `capture`, `validate_tags`, and `save_plan` by reusing Pi-side extension functions.
6. Claude Code never imports Pi internals; only the Pi bridge extension imports sibling Pi extension code.

Core boundaries:

- **Pi bridge extension:** Pi-coupled layer. Reuses workflow-modes, discussion-notes, persistent-memory, and engineering-docs code.
- **Claude MCP client:** Thin file-protocol client. Node stdlib only; no Pi imports.
- **Claude PreToolUse hook:** Fail-closed read-only guard for any cwd under a `.pi` marker. It blocks mutation tools, requires a fresh Pi bridge policy for Bash, and wraps allowed Bash commands in `sandbox-exec` on macOS when available.

Bridge request protocol lives under `<project>/.pi/memory/bridge/`:

- `requests/<uuid>.json`: `{ id, type, payload, ts }`
- `responses/<uuid>.json`: `{ id, ok, result | error }`
- `processed/<uuid>.json`: idempotency cache
- `policy.json`: fresh Bash/read-only policy snapshot sourced from Pi workflow-modes exports
- `session.json`: active bridge session lock + heartbeat

`capture` and `save_plan` use the Pi event bus rather than imported extension module state. `claude-bridge` emits `discussion-notes:add`; the live `discussion-notes` extension updates its own notes array, appends the session snapshot, and redraws the Notes widget. `claude-bridge` emits `workflow-modes:save-plan`; the live `workflow-modes` extension updates its own `currentPlan`, appends `workflow-plan`, and returns `workflow-modes:save-plan-result`.

## Workflow modes read-only Bash sandbox

`agent/extensions/workflow-modes/index.ts` owns Pi-side mode prompts and discuss/plan tool gating. Prompt injection in `before_agent_start` directs subagent delegation when the subagents extension is available: Discuss keeps quick lookups inline and uses `spawn_explorer` only for genuine multi-file/symbol sweeps; Plan defaults multi-file/symbol fan-out to `spawn_explorer` while the parent synthesizes; Build uses the worker-orchestration A+B model and spawns one `spawn_worker` per substantial confirmed saved-plan Section-4 task, with the parent retaining task selection, verification, commit, and confirmation. This integration is prompt-only; structural gates remain unchanged.

Mutation tools remain blocked in discuss/plan. For Bash, the hook first tries `wrapCommand()` from `agent/extensions/workflow-modes/sandbox.ts`; when a launcher is detected, the command is rewritten in place before execution. If no launcher exists, or wrapping throws, the hook falls back to the shared regex policy from `policy.ts`.

Supported launcher paths:

- macOS: `/usr/bin/sandbox-exec`, with a Seatbelt profile denying `network*` and `file-write*`, then re-allowing writes under a scratch `TMPDIR` and `/dev/null`.
- Linux: `bwrap`, with `--unshare-net`, a read-only bind of `/`, scratch `TMPDIR`, and `PYTHONDONTWRITEBYTECODE=1`.
- No launcher: conservative read-only allowlist plus mutation/redirect denies.

Claude bridge read-only Bash uses the same policy snapshot through `getWorkflowPolicySnapshot()`. Its Node-stdlib PreToolUse hook can also return `hookSpecificOutput.updatedInput`, so macOS Claude Code Bash calls under `.pi` projects are wrapped in `sandbox-exec` when available; otherwise the hook remains fail-closed on stale/missing policy and uses the allowlist fallback.

## Pi subagents

Pi subagents live in `agent/extensions/subagents/` and run as persisted in-process child `AgentSession`s created from extension tool execution. The parent exposes `spawn_explorer` and `spawn_worker`; both call `runSubagent()` in `agent/extensions/subagents/spawn.ts`, which creates a fresh `SessionManager.create(ctx.cwd)`, disables child extension/theme/skill/context-file discovery, and captures only the final structured return for the parent.

Roles:

- **Explorer:** read-only discovery role. `spawn_explorer` validates tools are limited to `read`, `grep`, `find`, and `ls` before spawning. It works in all workflow modes and returns parsed summary/findings/files/open questions. Workflow mode prompts use it with thresholds: sparse in Discuss, default for Plan fan-out.
- **Worker:** coding role. `spawn_worker` first queries `workflow-modes:get` and refuses unless `workflow-modes:state.mode === "build"`. Worker children receive coding tools plus a nested `spawn_explorer` custom tool; they do not receive `spawn_worker`. Build-mode prompts direct sequential one-worker-per-substantial-saved-task delegation while keeping verification, commits, and confirmation in the parent.

Child sessions are persisted as normal Pi sessions, making each subagent run inspectable after completion and providing the session-file foundation for future Context Transfer branch artifacts. The child transcript is not appended to the parent branch; parent context receives only the structured result object and short tool result text.

Concurrency is managed by `agent/extensions/subagents/concurrency.ts`: a configurable default lane (default cap 3), a reserved explorer lane for nested worker→explorer calls, and a worker file-ownership overlap guard. Progress visibility is handled by `agent/extensions/subagents/progress.ts`, which renders the keyed `subagents-progress` widget at a 250 ms throttle and clears it when runs finish.

## Persistent-Memory Reason-Aware Consolidation

To minimize prompt latency and LLM cost during rapid restarts (e.g. hot reload), the persistent-memory extension relies on reason-aware scheduling:

1. **Reason Classification:** On lifecycle events (`session_start` and `session_shutdown`), the extension classifies the event reason via `classifyReason` ([index.ts#L132-L143](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L132-L143)).
2. **Reload Bypass:** When the transition reason is `"reload"`, careful-model LLM calls are skipped entirely in both start and shutdown hooks. Start-time initialization only reopens the SQLite database synchronously ([index.ts#L161-L165](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L161-L165)), and shutdown-time extraction is bypassed ([index.ts#L268-L287](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L268-L287)).
3. **Background Reconciliation:** For non-reload starts (`startup`, `new`, `resume`, `fork`), the session immediately becomes interactive by opening the existing index.db and returning control to the user. Reconciliation is deferred to a `setTimeout` background task ([index.ts#L352-L451](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L352-L451)) guarded by `reconcileInFlight`.
4. **Generation Guarding:** A module-level `lifecycleGeneration` token is incremented on every start and shutdown handler execution. When background reconciliation completes, it swaps its private, newly-rebuilt SQLite index handle to the live global state only if `lifecycleGeneration` is unchanged since it started; otherwise, it closes the handle and discards the memory state, preventing database writes on a closed or stale connection.

