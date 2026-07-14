---
id: ADR-0020
title: Durable workflow plan store
status: Active
date: 2026-07-14
---

# ADR-0020: Durable workflow plan store

## Decision

- Store one saved plan per project Git root and branch in `~/.pi/agent/plans/`, not in Pi session-branch entries.
- Write the plan file atomically before updating live workflow state; keep session entries as best-effort audit only.
- Bridge recall reads saved-plan context only from live `workflow-modes` state. Delete bridge-side plan caching.

## Why

- Pi session persistence can silently skip writes, so an acknowledged bridge save was not recoverable after restart.
- Bridge save/recall crosses Pi sessions; session-branch-local state cannot provide durable handoff.
- A cache can serve a cleared plan and cannot prove whether returned data is live.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/plan-store.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/claude-bridge/index.ts`

## Consequences

- Good: acknowledged plans survive Pi restarts and bridge recall reflects live clear/save state.
- Good: project+branch scoping matches cross-session bridge use without a session-persistence dependency.
- Bad/risk: plans are no longer distinct per Pi session branch; concurrent writes are last-write-wins.

## Read when

- changing workflow saved-plan persistence, loading, or clear behavior
- changing bridge `save_plan`, `recall`, or live workflow-state events
- changing plan scoping or session-persistence assumptions

## Supersedes

- None. Compatible with ADR-0001: saved plans still belong to live Pi.
