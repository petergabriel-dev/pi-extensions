# ADR-0010: Subagent idle timeout with max-total backstop

- **Status:** Active
- **Date:** 2026-06-09
- **Decision:** Subagent runs use an idle watchdog plus an absolute max-total watchdog instead of a single wall-clock timeout.
- **Why:** A single spawn-time timeout kills healthy long-running children that continue streaming or running tools. The parent needs to abort genuinely stalled children while preserving partial output and structured failure metadata.
- **Affects:** `agent/extensions/subagents/timeout.ts`, `agent/extensions/subagents/spawn.ts`, `agent/extensions/subagents/index.ts`, subagent tool schemas/settings, orchestration handling of failed child runs.
- **Consequences:** Active children reset the idle timer on every child event; runaway children that never finish still stop at `maxTotalMs`; timed-out failures report `failureKind` and `partialWork`; silent long-running tools may need a larger idle timeout.
- **Read when:** Changing subagent timeout semantics, adding subagent call sites, handling failed subagent results, tuning long-running subagent jobs, or debugging child abort behavior.

## Context

`runSubagent()` previously used one wall-clock `timeoutMs`, which made timeout depend on time since spawn rather than time since last child activity. That conflicted with worker/explorer runs that can legitimately stream tokens or run tools for longer than the old cap.

## Decision details

- `agent/extensions/subagents/timeout.ts` exports `createSubagentWatchdog()` as a host-import-free helper. It owns an idle timer reset by `touch()` and an absolute `max_total` timer; firing is idempotent and `cancel()` clears timers (timeout.ts:28-83).
- `runSubagent()` defaults to `DEFAULT_IDLE_TIMEOUT_MS = 240000` and `DEFAULT_MAX_TOTAL_MS = 1200000`; legacy `timeoutMs` remains accepted as an idle-timeout alias (spawn.ts:19-20, spawn.ts:78-87, spawn.ts:312-315).
- The child session subscription calls `watchdog.touch()` for every `AgentSessionEvent`, including `message_update` and tool events, before event-specific bookkeeping (spawn.ts:349-362). Therefore active children are not idle-killed.
- The watchdog aborts the child and rejects with distinct human messages: `idle timeout: no activity for Ns` or `max-total timeout: exceeded Ns` (spawn.ts:384-400).
- Failed subagent results include `failureKind: "idle" | "max_total" | "error"` and `partialWork`, where `partialWork` is true after any `tool_execution_start` event (spawn.ts:60-73, spawn.ts:430-440).
- Tool schemas accept `idleTimeoutMs` and `maxTotalMs`; `timeoutMs` stays as a deprecated idle alias without the old 120000 maximum cap. Effective values resolve per-call first, then `subagents` settings, then defaults (index.ts:63-66, index.ts:461-466).
- `spawn_explorer`, nested `spawn_explorer`, `spawn_worker`, and `subagents_debug_run_agent` all pass resolved `idleTimeoutMs`/`maxTotalMs` to `runSubagent()` (index.ts:551-560, index.ts:675-684, index.ts:755-764, index.ts:925-933).

## Consequences

Positive:

- Long but active children can run beyond the idle threshold as long as they keep producing child events.
- Stalled children return structured failure information and partial output instead of only a free-text timeout.
- Tests cover the pure watchdog without importing Pi host packages.

Trade-offs:

- A tool that runs silently longer than `idleTimeoutMs` can still trip the idle timeout. Tune `subagents.idleTimeoutMs` or per-call `idleTimeoutMs` for legitimate silent work.
- `maxTotalMs` is absolute and intentionally cannot be reset by event activity.
