---
id: ADR-0021
title: Session-branch workflow plans
status: Active
date: 2026-07-15
---

# ADR-0021: Session-branch workflow plans

## Decision

- Store plan save and clear events only as `workflow-plan` custom entries in Pi session history.
- Resolve live plan state from the selected entry's ancestry; forks inherit only events before their fork point.
- Keep bridge save and recall routed through live `workflow-modes` state. Do not read or write repository-, Git-branch-, or bridge-scoped plan files.

## Why

- Repository and Git-branch keys leak plans across unrelated Pi sessions.
- Pi custom entries already carry stable tree ancestry, persist with saved sessions, and restore on session start or tree navigation.
- Branch chronology matches user intent: rewinding before a save removes that plan, while returning to its descendant branch restores it.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0020-durable-workflow-plan-store.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/plan-state.ts`
- `agent/extensions/workflow-modes/test/test_plan_state.ts`

## Consequences

- Good: unrelated sessions cannot inherit each other's plans.
- Good: forks and tree navigation restore plan state from exact selected ancestry.
- Good: no shared mutable plan files or Git-branch locking remain.
- Bad/risk: ephemeral sessions and persisted sessions with no flushed session file cannot promise restart restoration.
- Bad/risk: legacy files under `~/.pi/agent/plans/` become unused but remain on disk until users remove them.

## Read when

- changing workflow plan save, clear, restore, fork, or tree-navigation behavior
- changing bridge `save_plan`, recall, or session-persistence assumptions

## Supersedes

- ADR-0020
