---
id: ADR-0010
title: Global subagent idle timeout with max-total backstop
status: Active
date: 2026-07-15
readWhen: Changing subagent timeout policy, role-agent schemas, or timeout debugging
---

# ADR-0010: Global subagent idle timeout with max-total backstop

## Decision

- Subagent runs use an idle watchdog plus an absolute max-total watchdog, not one wall-clock timeout.
- Explorer, nested explorer, worker, and debug-run use only one global `subagents` timeout policy: 600,000ms idle and 1,200,000ms max-total by default.
- Role-agent tools expose no per-call timeout fields. Invalid, out-of-range, non-integer, or inverted global values fall back to the full default policy.

## Why

- Active children must survive streaming and tool activity beyond a short elapsed duration.
- Per-call overrides allowed role behavior to diverge; an explorer was explicitly given a 180-second idle threshold and aborted during a silent wait.
- One validated global policy makes timing predictable across all role-agent paths.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`

Code:

- `agent/extensions/subagents/timeout-policy.ts`
- `agent/extensions/subagents/spawn.ts`
- `agent/extensions/subagents/index.ts`
- `agent/settings.json`

## Consequences

- Good: active children reset only idle timing; continuously active runaways still stop at 20 minutes.
- Good: all role-agent schemas and runtime paths share one policy without caller-selected divergence.
- Bad/risk: silent provider waits and tools still count as idle; only global policy changes can extend the 10-minute threshold.

## Read when

- changing subagent timeout policy, role-agent schemas, or timeout diagnostics
- adding a role-agent spawn path or handling timed-out child results
