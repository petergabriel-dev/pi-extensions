---
id: ADR-0006
title: Chunked Persistent-Memory Reconciliation
status: Superseded
date: 2026-06-02
superseded_by: ADR-0011
---

# ADR-0006: Chunked Persistent-Memory Reconciliation

> Superseded by [ADR-0011](ADR-0011-per-candidate-persistent-memory-reconciliation.md). ADR-0011 keeps bounded work and generation-guard goals but replaces cross-cycle re-staging with per-candidate commits, terminal staging consumption, and incremental SQLite writes.

## Decision

- Persistent-memory reconciliation processes model candidates in sequential chunks instead of one unbounded careful-model prompt.
- Each chunk is applied to markdown before the next chunk, and project memory is re-read between chunks so later chunks can merge into records written by earlier chunks.
- A per-run wall-clock budget stops the loop between chunks; skipped candidates remain staged for a later run.
- Re-staging distinguishes applied refs from attempted refs: only candidates sent to the model and rejected by validation increment `reconcile_attempts`; budget-skipped and model-error/timeout chunks keep attempts unchanged.
- Background reconciliation passes a generation guard into the chunk loop so a session lifecycle change stops before the next chunk write and leaves remaining candidates staged.
- The careful-model default was re-pinned to an available authenticated model and resolution now logs the resolved careful-model id once resolution succeeds.

## Why

- A domain-heavy backlog of 224 staged candidates timed out as one careful-model call even after the timeout was raised to 180 seconds.
- Splitting work keeps each model prompt bounded while preserving candidate conservation across partial application, validation fallback, and later runs.
- Sequential apply plus re-read is required for cross-chunk deduplication; otherwise later chunks cannot see records created by earlier chunks.
- Generation-guarding the background loop avoids writing through stale lifecycle state after session replacement.
- Attempt counters must reflect validation rejection, not scheduling or model availability, or candidates can be prematurely dead-lettered without being evaluated.

## Affects

Docs:

- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0006-chunked-persistent-memory-reconciliation.md`

Code:

- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/model-resolution.ts`
- `agent/extensions/persistent-memory/test/test_chunked_reconcile.ts`
- `agent/extensions/persistent-memory/test/test_resolve_careful_model.ts`
- `agent/extensions/persistent-memory/package.json`

## Consequences

- Good: No single reconciliation model call needs to carry more than the configured chunk size.
- Good: Large staging backlogs can drain across one or more bounded runs without losing or duplicating candidates.
- Good: Cross-chunk merges are possible because later chunks see markdown records from earlier chunks.
- Good: Background reconciliation remains non-blocking and stops safely on lifecycle generation changes.
- Good: Retry/dead-letter accounting now reflects actual validation rejection only.
- Bad/risk: More careful-model calls can increase total provider cost, though bounded by chunk size and per-run budget.
- Bad/risk: Correct cross-chunk behavior depends on markdown rewrite/parse round-trips remaining faithful.

## Read when

- Changing `runReconciliation`, `reconcileCandidateSet`, staging cleanup, or dead-letter behavior.
- Troubleshooting `CarefulModelTimeoutError` during persistent-memory reconciliation.
- Modifying `PERSISTENT_MEMORY_RECONCILIATION_CHUNK_SIZE`, `PERSISTENT_MEMORY_RECONCILIATION_BUDGET_MS`, or reconciliation status UI.
- Touching lifecycle generation guards for background memory work.
- Changing persistent-memory careful-model defaults or model-resolution fallback behavior.

## Supersedes

- None.

## Superseded by

- ADR-0011
