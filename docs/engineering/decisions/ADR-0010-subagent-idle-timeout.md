---
id: ADR-0010
title: Global subagent idle timeout with max-total backstop
status: Active
date: 2026-08-27
readWhen: Changing subagent timeout policy, parked-child handling, or timeout debugging
---

# ADR-0010: Global subagent idle timeout with max-total backstop

## Decision

- Subagent runs use an idle watchdog plus an active-time max-total watchdog, not one wall-clock timeout.
- All child roles use one global `subagents` timeout policy: 600,000ms idle and 1,200,000ms max-total by default.
- `ask_question` parks a child as `waiting`; parked time pauses both idle and max-total budgets. Answering resumes remaining active budget; cancellation, exit, disconnect, or host close releases the run.
- Timeout values are settings-only. Role tools expose no per-call timeout fields. Invalid, out-of-range, non-integer, or inverted global values fall back to the full default policy.

## Why

- Active children must survive IPC activity and parent questions beyond a short elapsed duration.
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
- Pi-owned `settings.json` resolved by `index.ts`

## Consequences

- Good: IPC activity resets idle timing; continuously active runaways still stop at 20 minutes, while parked questions do not consume either budget.
- Good: all role-agent schemas and runtime paths share one policy without caller-selected divergence.
- Bad/risk: silent provider waits and tools still count as idle; only IPC activity or global policy changes extend the 10-minute threshold. A waiting child remains resource-consuming until answered or explicitly closed.

## Read when

- changing subagent timeout policy, role-agent schemas, or timeout diagnostics
- adding a role-agent spawn path or handling timed-out child results
