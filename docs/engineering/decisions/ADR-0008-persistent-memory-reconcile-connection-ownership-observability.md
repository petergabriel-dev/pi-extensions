---
id: ADR-0008
title: Persistent-memory reconcile connection ownership and observability
status: Active
date: 2026-06-03
updated: 2026-06-10
---

# ADR-0008: Persistent-memory reconcile connection ownership and observability

## Decision

- Manual `/memory reconcile` owns a dedicated SQLite connection for the full run instead of using the module-level active `db`.
- Manual and background reconciliation share `reconcileInFlight`; manual reconcile rejects while a reconcile is already active.
- Manual reconcile publishes its owned SQLite connection only through a generation-guarded, await-free `shouldSwap(...)` to `swapActiveMemory(...)` block; stale runs close their owned connection.
- Reconcile observability is recorded in a bounded append-only project run-log, surfaced by `/memory status` and a hybrid UI meter (`setStatus` plus temporary `setWidget`). The run-log includes per-candidate outcome rows (`add`, `duplicate`, `supersede`, `merge`, `discard`, `parked`, `dead_lettered`) plus a discard/dup-rate metric so extraction volume and duplicate pressure can be judged without inspecting staging files.
- Persistent-memory metering must not use `setFooter`.
- **Incremental per-candidate sqlite writes** replace the final whole-index rebuild-and-swap after candidate commits. Each deterministic add and each adjudication batch writes new and changed records (including superseded status transitions and reinforcement bumps) directly into the owned connection via `INSERT OR REPLACE`. A full `rebuildIndex` is still permitted for the `rebuildOnNoop` early-return paths when no staging exists, but candidate processing paths no longer trigger it. The `indexRebuilt` result flag is `false` when only incremental writes were used. A generation change detected mid-run via `shouldContinue` stops further writes, leaving the index consistent with already-committed candidates while keeping later candidates staged.

## Why

- A manual reconcile previously operated on the shared module `db`; a concurrent lifecycle/background swap could close that handle while reconciliation awaited the careful model, causing `better-sqlite3` closed-connection errors.
- Connection ownership fixes the stale-handle class directly; single-flight reduces duplicate writers but is not the primary correctness mechanism.
- A bounded run-log and visible meter make failures diagnosable without depending on console output.

## Affects

Docs:

- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`

Code:

- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/storage/run-log.ts`
- `agent/extensions/persistent-memory/storage/sqlite.ts`
- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/test/test_reconcile_run_log.ts`
- `agent/extensions/persistent-memory/test/test_t13_run_log_outcomes.ts`
- `agent/extensions/persistent-memory/test/test_incremental_index_writes.ts`

## Consequences

- Good: lifecycle db closes can no longer invalidate an in-flight manual reconcile connection.
- Good: users can inspect staging depth, in-flight state, recent reconcile outcomes, and failure reasons.
- Good: the generated SQLite index remains a replaceable cache; stale run indexes are discarded while markdown/staging remain source of truth.
- Risk: reinforcement during shutdown is still outside `reconcileInFlight` and can interleave with manual reconcile markdown writes; documented as a trap and left for a separate change.

## Read when

- touching persistent-memory reconciliation entrypoints or SQLite lifecycle handling
- changing `/memory` commands, reconcile status UI, per-candidate outcome metrics, or run-log storage
- debugging closed SQLite connection, stale swap, or missing reconciliation observability issues
- working on incremental vs full index rebuild behavior, or per-candidate sqlite writes

## Supersedes

- None. ADR-0002 and ADR-0006 still govern partial-batch and chunked reconciliation behavior.
