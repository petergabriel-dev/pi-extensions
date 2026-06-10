---
id: ADR-0003
title: Non-Blocking Reason-Aware Persistent-Memory Consolidation
status: Active
date: 2026-05-30
updated: 2026-06-10
---

# ADR-0003: Non-Blocking Reason-Aware Persistent-Memory Consolidation

## Decision

To resolve the tradeoff between persistent memory consistency and interactive session startup latency, we map lifecycle events to actions based on their reasons:

1. **Reload Transitions Bypass Model Work:** When the lifecycle transition reason is `"reload"`, all careful-model LLM calls and reinforcement updates (writing markdown updates and rebuilding the SQLite index) are bypassed. Startup only reopens the SQLite database synchronously, and shutdown skips extraction and reinforcement entirely. The session firing log is preserved across reload and applied at the next real shutdown.
2. **Asynchronous Non-Blocking Starts:** For all other start reasons (`startup`, `new`, `resume`, `fork`), the extension opens the SQLite index synchronously to immediately return control to the user. Memory reconciliation runs in a non-blocking background task via `setTimeout(..., 0)`.
3. **Blocking Shutdown on Quit:** The shutdown handler blocks on extraction and reinforcement for the `"quit"` reason to prevent early process termination from cutting off file writes.
4. **Generation-Guarded Index Swaps:** To mitigate teardown races when switching/forking sessions, a module-level `lifecycleGeneration` counter is incremented on every start and shutdown handler execution. The background task works on a separate database connection and only swaps it into the live global state if the generation token is unchanged upon completion.
5. **Observability via Status Widget:** A non-blocking status indicator (`"Memory consolidating..."`) is shown using the UI setStatus widget while reconciliation is in flight, so a user recall issued before completion is explicable.
6. **Forced Tool-Call Structured Output for Careful Models:** Extraction and reconciliation register a single custom `submit_plan` tool whose TypeBox-compatible schema mirrors the prompt JSON schema, and force that tool via the provider `toolChoice` option when a resolved careful model is available. The host reads the returned `ToolCall.arguments` as the model plan. If the provider/gateway does not return a tool call, or forced tool use is unavailable, the system falls back to the existing free-text JSON plus tolerant parse/salvage path. We do not use `response_format`/JSON mode because the opencode-go `glm-5.1` path is through an OpenAI-completions-compatible adapter where tool calls are the compatible structured-output mechanism.

## The Reason Matrix

| Event | Reason | Extraction | Reconciliation | Reinforcement | Timing | Status Indicator |
|---|---|---|---|---|---|---|
| `session_start` | `reload` | N/A | None (reopen only) | N/A | Synchronous | None |
| `session_start` | `startup`, `new`, `resume`, `fork` | N/A | Full (owned connection, incremental candidate writes) | N/A | Asynchronous (`setTimeout`) | `"Memory consolidating..."` |
| `session_shutdown` | `reload` | None | N/A | None (log preserved) | Synchronous | None |
| `session_shutdown` | `new`, `resume`, `fork` | Full | N/A | Full (log cleared) | Synchronous (v1) | None |
| `session_shutdown` | `quit` | Full | N/A | Full (log cleared) | Synchronous | None |

## Why

- **Performance:** Bypassing model calls on `/reload` drops reload latency to the no-staging fast path (<50ms). Running reconciliation in the background on startup makes the session immediately interactive.
- **Reliability:** Out-of-band markdown edits are safely reconciled on the next non-reload session start. Staging leftovers are dead-lettered within a single reconciliation run (T9 terminal consumption), so no candidate is carried across cycles unresolved.
- **Safety:** Stale or closed database handle writes are prevented by the generation guard, discarding outdated background handles cleanly without crash; unresolved same-project candidates are terminalized under staging-consumption semantics rather than preserved across cycles.
- **Structured-output reliability:** Tool-call arguments avoid dependence on free-form text placement for careful-model plans, while the fallback preserves backward compatibility for gateways that omit real `tool_calls`.

## Alternatives Rejected

- **Shutdown-Reconciliation:** Running reconciliation during session shutdown. Rejected because it increases shutdown latency significantly, delaying session switching, and fails to capture manual out-of-band markdown changes made while the agent was stopped.
- **Hermes-style Model-Written Memory:** Allowing LLM models to directly edit markdown memory files. Rejected due to model hallucination risks and structure validation errors; our structured staging file and rule-based partial-batch system provide strict quality guarantees.
- **`response_format` / JSON-mode Structured Output:** Rejected for this path because the target careful model is reached through an OpenAI-completions-compatible gateway where forced tool calls are the minimal portable structured-output mechanism. We keep prompt-level JSON instructions and tolerant parsing only as fallback behavior.

## Affects

Docs:

- [architecture.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/architecture.md#L32-L43)
- [invariants.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/invariants.md#L25-L29)
- [traps.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/traps.md#L22-L25)

Code:

- [index.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L131-L157) (`session_start` hook)
- [index.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L246-L329) (`session_shutdown` hook)
- [index.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/index.ts#L391-L485) (`triggerBackgroundReconciliation` helper)
- [lifecycle.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/lifecycle.ts) (extracted lifecycle logic)
- [careful-model.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/consolidation/careful-model.ts) (forced `submit_plan` tool-call careful-model path with free-text fallback)

## Consequences

- **Good:** Fast session starts and near-instant reload latency.
- **Good:** Complete protection against closed-connection SQLite crashes during parallel transitions.
- **Bad:** A recall tool invocation made immediately after session start might miss newly consolidated staging candidates until the background swap completes (reconciled by the `"Memory consolidating..."` status indicator).
- **Neutral:** The pi-coding-agent session API exposes custom tools but not forced tool choice, so forced `submit_plan` uses the lower-level pi-ai completion API when a careful model has already been resolved; otherwise the isolated session free-text path remains the compatibility fallback.

## Probe Result

A live one-shot `opencode-go/glm-5.1` gateway probe was not run in this worker environment: the extension package typecheck stubs compile against `@mariozechner/*`, but the runtime package is not resolvable from this isolated package outside the host pi process. The implementation therefore uses conservative fallback behavior and should be empirically probed from the host runtime before relying on forced tool-call availability.

## Read when

- modifying session lifecycle events, startup, or shutdown hooks.
- changing careful-model extraction/reconciliation structured-output behavior.
- debugging SQLite database locking, closed connection, or thread/asynchronous errors.
