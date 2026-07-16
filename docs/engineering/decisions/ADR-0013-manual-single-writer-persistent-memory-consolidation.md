---
id: ADR-0013
title: Manual Single-Writer Persistent-Memory Consolidation
status: Superseded
date: 2026-06-26
decision: Persistent-memory canonical writes are manual single-writer jobs; never-attempted candidates re-stage; reinforcement runs inside /memory consolidate.
why: Prior automatic terminal behavior produced mostly attempts:0 deadletters and about 47% historical candidate loss.
affects: persistent-memory lifecycle, reconcile staging cleanup, /memory consolidate, /memory recover, reinforcement, mode reminder, engineering docs.
consequences: Lifecycle no longer updates memory automatically; users run /memory consolidate; transient candidates are preserved until genuinely attempted or retry-capped.
readWhen: changing persistent-memory lifecycle hooks, /memory consolidate/recover/reconcile, staging cleanup, dead-letter recovery, reinforcement, or mode-transition reminders
supersedes: ADR-0011
superseded_by: ADR-0016
---

# ADR-0013: Manual Single-Writer Persistent-Memory Consolidation

> Superseded by [ADR-0016](ADR-0016-memory-engineering-docs-and-personal-memory.md). Persistent-memory has been retired; project memory now lives in engineering docs and personal cross-repo memory uses indexed `~/.pi/memory/` per [ADR-0017](ADR-0017-indexed-personal-memory.md).

## Decision

Persistent-memory canonical writes move to a manual, foreground, single-writer model:

1. **No automatic canonical writes from lifecycle hooks.** `session_start` opens memory/index state and refreshes derived caches only. `session_shutdown` closes state only. Neither hook runs extraction, reconciliation, reinforcement, staging consumption, or firing-log clear.
2. **Manual consolidate is the full write job.** `/memory consolidate` verifies the current session branch exists, extracts that branch to staging, runs foreground reconciliation, applies reinforcement from accumulated firing telemetry after successful reconcile, then clears firing telemetry only after reinforcement succeeds.
3. **One canonical writer lock.** `/memory consolidate`, `/memory reconcile`, and `/memory recover` share `canonical-writer.lock` and fail fast if another canonical writer is active.
4. **Re-stage instead of terminalizing transient leftovers.** Never-attempted candidates are rewritten to staging unchanged. Attempted unresolved candidates increment `reconcile_attempts` and are re-staged while below retry cap 3. Attempted candidates at/over cap are dead-lettered with reason. Malformed staging remains dead-lettered immediately after repair fails.
5. **Recover closes the old loss hole.** `/memory recover` maps `deadletter/*.json` back into validated staging grouped by `session_id`, skips duplicates, deletes deadletters only after successful staging write, and leaves malformed deadletters in place with a report.
6. **Reminder, not automation.** Persistent-memory listens to `workflow-modes:changed`; leaving discuss/plan/build with high-value unconsolidated content shows a once-per-session reminder to run `/memory consolidate`. The reminder performs no writes.
7. **ADR amendments.** This supersedes ADR-0011's terminal staging-consumption decision, amends ADR-0003's auto-consolidation timing to manual-only canonical writes, and widens ADR-0008's connection ownership/single-flight scope from reconcile-only to all canonical memory writers.

ADR-0013 supersedes ADR-0011. ADR-0011 already superseded ADR-0002 and ADR-0006; those remain historical and superseded.

## Why

- Empirical backlog evidence showed 80 deadletter files, mostly `attempts:0`, and historical loss around 47% (114 add / 103 dead_lettered). Many candidates were never genuinely attempted; terminalizing them as deadletters silently lost useful memory.
- Automatic lifecycle writes created multiple implicit canonical writers: start-time reconcile, shutdown extraction, shutdown reinforcement, and manual commands. That violated the single-writer invariant and made failures harder to reason about.
- Manual foreground jobs provide typed success/failure reporting, visible counts, and clear user intent. Staging remains durable until the user runs a manual job.
- Re-staging never-attempted candidates prevents transient causes (generation stop, budget cap, missing model, model error before attempt) from becoming permanent loss.
- A retry cap on attempted candidates preserves ADR-0011's crash-safety goal without reintroducing infinite reprocess loops.
- Moving reinforcement into `/memory consolidate` preserves `reinforcement_count` signals while preventing shutdown-time markdown/index writes.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0003-non-blocking-reason-aware-persistent-memory-consolidation.md`
- `docs/engineering/decisions/ADR-0008-persistent-memory-reconcile-connection-ownership-observability.md`
- `docs/engineering/decisions/ADR-0011-per-candidate-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0013-manual-single-writer-persistent-memory-consolidation.md`

Code:

- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/consolidation/staging.ts`
- `agent/extensions/persistent-memory/consolidation/extract.ts`
- `agent/extensions/persistent-memory/reinforcement/tracker.ts`
- `agent/extensions/persistent-memory/retrieval/firing-log.ts`
- `agent/extensions/persistent-memory/storage/sqlite.ts`
- `agent/extensions/persistent-memory/storage/run-log.ts`
- `agent/extensions/persistent-memory/test/test_memory_consolidate.ts`
- `agent/extensions/persistent-memory/test/test_memory_recover.ts`
- `agent/extensions/persistent-memory/test/test_memory_reminder.ts`
- `agent/extensions/persistent-memory/test/test_t9_staging_consumption.ts`
- `agent/extensions/persistent-memory/test/test_per_candidate_reconcile.ts`
- `agent/extensions/persistent-memory/test/test_chunked_reconcile.ts`
- `agent/extensions/persistent-memory/test/test_t13_run_log_outcomes.ts`

## Consequences

- Good: interactive start/shutdown no longer mutate canonical memory files.
- Good: never-attempted candidates survive transient failures and stay available for a later manual run.
- Good: users get foreground, typed counts for extraction, adds, re-staged candidates, deadletters, recoveries, and reinforcement.
- Good: `reinforcement_count` remains useful for retrieval ranking and low-signal checks, but writes only during `/memory consolidate`.
- Good: recover gives a safe path to reprocess old deadletter backlogs without duplicating already staged candidates.
- Tradeoff: memory no longer updates unless the user runs `/memory consolidate`.
- Tradeoff: firing telemetry spans sessions until consolidate, so reinforcement may lag behind retrieval usage.
- Risk: stale `canonical-writer.lock` files can block manual writes until removed; this is safer than concurrent canonical writers.

## Read when

- Changing persistent-memory lifecycle hooks.
- Changing `/memory consolidate`, `/memory reconcile`, `/memory recover`, or `canonical-writer.lock`.
- Changing staging cleanup, retry cap, deadletter behavior, or recovery mapping.
- Changing reinforcement timing, firing telemetry clearing, or `reinforcement_count` consumers.
- Changing workflow-mode reminder behavior for memory consolidation.

## Supersedes

- ADR-0011
