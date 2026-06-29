---
id: ADR-0003
title: Non-Blocking Reason-Aware Persistent-Memory Consolidation
status: Superseded
date: 2026-05-30
updated: 2026-06-18
superseded_by: ADR-0016
---

# ADR-0003: Non-Blocking Reason-Aware Persistent-Memory Consolidation

> Superseded by [ADR-0016](ADR-0016-memory-engineering-docs-and-personal-memory.md). Persistent-memory has been retired; project memory now lives in engineering docs and personal cross-repo memory lives in `~/.pi/memory.md`.

> Amended by [ADR-0013](ADR-0013-manual-single-writer-persistent-memory-consolidation.md). Persistent-memory canonical writes are now manual-only: lifecycle hooks no longer run start-time reconciliation or shutdown extraction/reinforcement.

## T12 Sweep Home — Low-Signal Flagging + Contradiction Detection

As of 2026-06-10, the offline sweep (`/memory sweep`) runs three non-destructive phases:

1. **Archival (T11):** Fully-superseded chains and expired session-scoped lessons are archived (status change only, reversible).
2. **Low-Signal Flagging (T12):** Active lessons with old `last_seen_at`, low `reinforcement_count`, and no presence in the firing log are flagged `low_signal: true`. Flagged records remain active; they are surfaced for human review, never deleted or archived.
3. **Contradiction Detection (T12):** Pairs of active lessons sharing at least one trigger (same type, value, and pattern) are identified as suspected contradictions and assigned a shared `contradiction_group` id. Contradictions are queued for adjudication, never auto-resolved.

Both low-signal flags and contradiction groups are surfaced via `/memory` (list view and dedicated subcommands `/memory lowsignal`, `/memory contradictions`). All flags are reversible: `unflagLowSignalLessons` clears the `low_signal` flag, `clearContradictionGroups` removes the `contradiction_group` assignment.

### Conservative Defaults

- Low-signal age threshold: 30 days (configurable via `lowSignalAgeMs`).
- Low-signal reinforcement threshold: `< 1` (configurable via `lowSignalMaxReinforcement`).
- Firing log presence: derived from `firings.jsonl` lesson_id entries.
- Contradictions: detected purely heuristically (shared triggers); no LLM involved.

## Decision

To resolve the tradeoff between persistent memory consistency and interactive session startup latency, we map lifecycle events to actions based on their reasons:

1. **Reload Transitions Bypass Model Work:** When the lifecycle transition reason is `"reload"`, all careful-model LLM calls and reinforcement updates (writing markdown updates and rebuilding the SQLite index) are bypassed. Startup only reopens the SQLite database synchronously, and shutdown skips extraction and reinforcement entirely. The session firing log is preserved across reload and applied at the next real shutdown.
2. **Asynchronous Non-Blocking Starts:** For all other start reasons (`startup`, `new`, `resume`, `fork`), the extension opens the SQLite index synchronously to immediately return control to the user. Memory reconciliation runs in a non-blocking background task via `setTimeout(..., 0)`.
3. **Blocking Shutdown on Quit:** The shutdown handler blocks on extraction and reinforcement for the `"quit"` reason to prevent early process termination from cutting off file writes.
4. **Generation-Guarded Index Swaps:** To mitigate teardown races when switching/forking sessions, a module-level `lifecycleGeneration` counter is incremented on every start and shutdown handler execution. The background task works on a separate database connection and only swaps it into the live global state if the generation token is unchanged upon completion.
5. **Observability via Status Widget:** A non-blocking status indicator (`"Memory consolidating..."`) is shown using the UI setStatus widget while reconciliation is in flight, so a user recall issued before completion is explicable.
6. **Capability-Gated Forced Tool-Call Structured Output for Careful Models:** Extraction and reconciliation register a single custom `submit_plan` tool whose TypeBox-compatible schema mirrors the prompt JSON schema. The lower-level pi-ai one-shot path forces that tool only when `model.api` supports forced tool choice: OpenAI-completions/Mistral use `{type:"function",function:{name}}`, Anthropic/Bedrock use `{type:"tool",name}`, and Google/Vertex use `"any"` with the single registered tool. Responses APIs (`openai-responses`, `azure-openai-responses`, `openai-codex-responses`) and unknown APIs skip the forced attempt and go straight to the existing free-text JSON plus tolerant parse/salvage path. Provider `stopReason === "error"` responses are logged with `errorMessage` before fallback.

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
- **Structured-output reliability:** Tool-call arguments avoid dependence on free-form text placement for careful-model plans on APIs that can force tools, while capability gating avoids wasted calls and warning noise on Responses APIs that cannot force `submit_plan`. The fallback preserves backward compatibility for gateways that omit real `tool_calls` or return provider errors.

## Alternatives Rejected

- **Shutdown-Reconciliation:** Running reconciliation during session shutdown. Rejected because it increases shutdown latency significantly, delaying session switching, and fails to capture manual out-of-band markdown changes made while the agent was stopped.
- **Hermes-style Model-Written Memory:** Allowing LLM models to directly edit markdown memory files. Rejected due to model hallucination risks and structure validation errors; our structured staging file and rule-based partial-batch system provide strict quality guarantees.
- **`response_format` / JSON-mode Structured Output:** Rejected for this path because supported careful models are reached through mixed provider APIs and not all expose a portable JSON-mode option. Forcing tools is used where `model.api` supports it; Responses APIs are explicitly un-forceable for this path and rely on prompt-level JSON instructions plus tolerant parsing.

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
- [careful-model.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/consolidation/careful-model.ts) (`forcedToolChoiceForApi`, TypeBox `submit_plan` schemas, provider-error logging, and free-text fallback)
- [sweep.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/consolidation/sweep.ts) (T11 archival + T12 low-signal flagging + contradiction detection)
- [markdown.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/storage/markdown.ts) (T12 optional field parsing: `low_signal`, `contradiction_group`)
- [types.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/persistent-memory/types.ts) (T12 `LessonMeta` optional fields)

## Consequences

- **Good:** Fast session starts and near-instant reload latency.
- **Good:** Complete protection against closed-connection SQLite crashes during parallel transitions.
- **Bad:** A recall tool invocation made immediately after session start might miss newly consolidated staging candidates until the background swap completes (reconciled by the `"Memory consolidating..."` status indicator).
- **Neutral:** The pi-coding-agent session API exposes custom tools but not forced tool choice, so forced `submit_plan` uses the lower-level pi-ai completion API only for forcing-capable `model.api` values when a careful model has already been resolved; otherwise the isolated session free-text path remains the compatibility fallback.

## Probe Result

A live one-shot `opencode-go/deepseek-v4-flash` gateway probe should be run from the host Pi runtime before relying on forced tool-call availability. `openai-codex/*` careful models use `openai-codex-responses`, which cannot force `submit_plan`; this is expected to skip directly to free-text. The extension keeps conservative fallback behavior for gateways that omit tool calls, return invalid schema, or surface provider errors.

## Read when

- modifying session lifecycle events, startup, or shutdown hooks.
- changing careful-model extraction/reconciliation structured-output behavior.
- debugging SQLite database locking, closed connection, or thread/asynchronous errors.
- running or modifying the sweep pipeline (`/memory sweep`): archival, low-signal flagging, or contradiction detection.
- tuning low-signal thresholds (`lowSignalAgeMs`, `lowSignalMaxReinforcement`).
- adding new lesson metadata fields (ensure backward-compatible optional parsing in markdown.ts).
