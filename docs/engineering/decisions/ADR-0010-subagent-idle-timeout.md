---
id: ADR-0010
title: Global subagent idle timeout with max-total backstop
status: Active
date: 2026-08-27
decision: Use global active-time idle and max-total watchdogs, with throttled child activity heartbeats touching idle time.
why: Child tool calls do not cross IPC, so heartbeat-driven host visibility prevents read-only work from being mistaken for idleness without making silent work immortal.
affects: agent/extensions/subagents/timeout-policy.ts, agent/extensions/subagents/launch.ts, agent/extensions/subagents/timeout.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/child.ts, agent/extensions/subagents/ipc.ts, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0010-subagent-idle-timeout.md
consequences: Continuous event-driven child work can outlast the idle threshold; silent long-running tool calls remain bounded only by maxTotalMs.
readWhen: Changing subagent timeout policy, activity heartbeat, parked-child handling, or timeout debugging
supersedes: None
---

# ADR-0010: Global subagent idle timeout with max-total backstop

## Decision

- Subagent runs use an idle watchdog plus an active-time max-total watchdog, not one wall-clock timeout.
- All child roles use one global `subagents` timeout policy: 600,000ms idle and 1,200,000ms max-total by default.
- `ask_question` parks a child as `waiting`; parked time pauses both idle and max-total budgets. Answering resumes remaining active budget; cancellation, exit, disconnect, or host close releases the run.
- Timeout values are settings-only. Role tools expose no per-call timeout fields. Invalid, out-of-range, non-integer, or inverted global values fall back to the full default policy.
- Child sends a throttled `activity` heartbeat, at most once per 30 seconds, from `tool_execution_start`, `tool_execution_update`, and `message_update`; the authenticated IPC request touches the idle watchdog. No bare timer emits heartbeats.

## Why

- Child tool calls execute in the child process and never cross IPC. IPC-request-only accounting made idle equivalent to total for read-only children, so event-driven heartbeats make continuous work visible without keeping a wedged child alive.
- Per-call overrides would allow role behavior to diverge; one validated global policy keeps timing predictable across child roles and resume paths.
- Active-time accounting prevents an unanswered parent question from consuming child budget while retaining a backstop for runaway active work.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`

Code:

- `agent/extensions/subagents/timeout-policy.ts`
- `agent/extensions/subagents/launch.ts`
- `agent/extensions/subagents/timeout.ts`
- `agent/extensions/subagents/index.ts`
- `agent/extensions/subagents/child.ts`
- `agent/extensions/subagents/ipc.ts`
- Pi-owned `settings.json` resolved by `index.ts`

## Consequences

- Good: throttled event-driven child activity resets idle timing; continuously active runaways still stop at 20 minutes, while parked questions do not consume either budget.
- Good: all role-agent schemas and runtime paths share one policy without caller-selected divergence.
- Bad/risk: a silent long-running single tool call emits no activity event, so `maxTotalMs` is its only backstop; dropped heartbeat failures are swallowed. A waiting child remains resource-consuming until answered or explicitly closed.

## Read when

- changing subagent timeout policy, activity heartbeat, role-agent schemas, or timeout diagnostics
- adding a role-agent spawn path or handling timed-out child results
