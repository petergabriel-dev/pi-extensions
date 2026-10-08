---
id: ADR-0010
title: Global subagent idle timeout with max-total backstop
status: Active
date: 2026-10-08
decision: Use global active-time idle and max-total watchdogs; RPC events touch idle, open tool IDs pause only idle while max-total keeps running, and parent questions pause both timers.
why: RPC event monitoring makes child activity visible to the parent; open tool IDs prevent long silent calls from hitting idle timeout without allowing a wedged run to outlive max-total.
affects: agent/extensions/subagents/timeout-policy.ts, agent/extensions/subagents/launch.ts, agent/extensions/subagents/timeout.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/child.ts, agent/extensions/subagents/rpc.ts, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0010-subagent-idle-timeout.md, docs/engineering/decisions/ADR-0038-rpc-mode-subagent-transport.md
consequences: Open tools are not idle-killed; maxTotalMs remains hard backstop, including for tools that emit no further RPC events; parked questions pause both budgets.
readWhen: Changing subagent RPC event activity, tool-open idle handling, parked-child policy, timeout settings, or timeout debugging
supersedes: None
---

# ADR-0010: Global subagent idle timeout with max-total backstop

## Decision

- Subagent runs use an idle watchdog plus an active-time max-total watchdog, not one wall-clock timeout. All child roles share settings-only defaults of 600,000ms idle and 1,200,000ms max-total.
- Every supported RPC event received by the host touches idle time. `tool_execution_start` and `tool_execution_end` track open tool-call IDs; while any tool remains open, idle is paused and max-total continues. Ending the last tool re-arms idle; duplicate or unknown end IDs do not change the set.
- `ask_question` parks a child as `waiting`; parked time pauses both idle and max-total budgets. Answering resumes remaining active budget; cancellation, process exit, or host close releases the run. Optional side-channel disconnect does not fail the run.
- Invalid, out-of-range, non-integer, or inverted global timeout settings fall back to the full default policy. Role tools expose no per-call timeout fields.

## Why

- The RPC event stream exposes child tool and assistant activity to the parent. Updating the watchdog from those events avoids treating active child work as idle without a separate activity IPC protocol.
- A tool may remain silent while executing. Tracking open tool IDs pauses only idle during that call; max-total still bounds a hung tool and the complete run.
- Per-call overrides would allow role behavior to diverge; one validated global policy keeps timing predictable across child roles and resume paths. Active-time accounting keeps an unanswered parent question from consuming either budget.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0038-rpc-mode-subagent-transport.md`

Code:

- `agent/extensions/subagents/timeout-policy.ts`
- `agent/extensions/subagents/launch.ts`
- `agent/extensions/subagents/timeout.ts`
- `agent/extensions/subagents/rpc.ts`
- `agent/extensions/subagents/index.ts`
- `agent/extensions/subagents/child.ts`
- Pi-owned `settings.json` resolved by `index.ts`

## Consequences

- Good: live RPC events reset idle timing; a long-running open tool is not idle-killed, while continuously active or hung work still stops at configured `maxTotalMs` (20 minutes by default).
- Good: all role-agent schemas and runtime paths share one policy without caller-selected divergence; parked questions consume neither budget.
- Bad/risk: if a tool-end event is lost, idle remains paused until `clearTools()` or the max-total deadline. A waiting child remains resource-consuming until answered or explicitly closed.

## Read when

- changing subagent RPC activity, open-tool idle handling, timeout policy, or timeout diagnostics
- adding a role-agent spawn path, changing question-wait semantics, or handling timed-out child results
