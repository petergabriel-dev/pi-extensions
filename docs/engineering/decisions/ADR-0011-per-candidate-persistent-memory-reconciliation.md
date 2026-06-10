---
id: ADR-0011
title: Per-Candidate Persistent-Memory Reconciliation
status: Active
date: 2026-06-10
updated: 2026-06-10
supersedes:
  - ADR-0002
  - ADR-0006
---

# ADR-0011: Per-Candidate Persistent-Memory Reconciliation

## Decision

Persistent-memory reconciliation uses a deterministic, per-candidate write pipeline instead of whole-run or chunk-level all-or-nothing reconciliation:

1. **Validate before staging.** Extraction validates every candidate before writing `staging/`. Malformed candidates are dropped, and lesson candidates missing/empty triggers are repaired with deterministic `deriveLessonTriggers(...)` so the ADR-0009 trigger invariant holds at write time.
2. **Shortlist before model calls.** Reconciliation computes a pure lexical shortlist over same-scope records. Candidates with an empty shortlist follow the zero-model deterministic ADD path.
3. **Host-owned structure.** Code fills ids, timestamps, scopes, refs, triggers, status flags, and supersede pointers. Models emit only bounded verdicts.
4. **Small-model lesson adjudication.** Lesson collisions are adjudicated with a constrained verdict contract: `distinct`, `duplicate`, `supersedes`, or `merge`. Parser failures park/terminalize only affected candidates.
5. **Atomic per-candidate progress.** Each successful candidate/batch writes markdown and incrementally upserts changed SQLite rows through the reconcile-owned connection. Candidate-processing paths do not run a final whole-index rebuild-and-swap.
6. **Terminal staging consumption.** Every same-project staging file reaches a terminal state in one run: consumed or dead-lettered. Wrong-project files are terminal for the current project and remain for their owner. No same-project candidate is re-staged across cycles.
7. **Reversible memory state.** Duplicate reinforces; supersede/merge flips status and pointers or creates a replacement. Records are never deleted. Offline sweep only flags/archives via reversible status/metadata.
8. **Bounded observability.** The append-only bounded run-log records per-candidate outcomes and discard/dup-rate metrics, surfaced by `/memory status`.

ADR-0011 supersedes ADR-0002 and ADR-0006. ADR-0003 remains the lifecycle home, ADR-0005 the model-role home, ADR-0008 the connection/observability home, and ADR-0009 the staging validity/trigger home.

## Why

- Whole-run and chunk-level failure made saving/reconciliation feel like a coinflip: one bad candidate or one model timeout could preserve a backlog indefinitely.
- Most candidates can be safely added without model involvement when lexical shortlist finds no plausible collision.
- Candidate-level commits make progress monotonic: process death loses at most in-flight work, not already-committed candidates.
- Deterministic structure plus bounded model verdicts improves reliability and makes failures auditable.
- Terminal staging semantics make backlog health measurable: files drain, dead letters explain unresolved candidates, and run-log metrics expose duplicate/discard pressure.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0002-reliable-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0003-non-blocking-reason-aware-persistent-memory-consolidation.md`
- `docs/engineering/decisions/ADR-0005-pinned-default-persistent-memory-careful-model.md`
- `docs/engineering/decisions/ADR-0006-chunked-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0008-persistent-memory-reconcile-connection-ownership-observability.md`
- `docs/engineering/decisions/ADR-0009-bridge-staging-validity-malformed-quarantine.md`
- `docs/engineering/decisions/ADR-0011-per-candidate-persistent-memory-reconciliation.md`

Code:

- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/consolidation/shortlist.ts`
- `agent/extensions/persistent-memory/consolidation/adjudication.ts`
- `agent/extensions/persistent-memory/consolidation/verdict-apply.ts`
- `agent/extensions/persistent-memory/consolidation/extract.ts`
- `agent/extensions/persistent-memory/consolidation/sweep.ts`
- `agent/extensions/persistent-memory/storage/sqlite.ts`
- `agent/extensions/persistent-memory/storage/run-log.ts`
- `agent/extensions/persistent-memory/index.ts`

## Consequences

- Good: Non-colliding candidates commit with zero model calls.
- Good: A failing candidate cannot abort or roll back unrelated committed candidates.
- Good: Staging drains to a terminal state; no same-project file is preserved across cycles unresolved.
- Good: SQLite updates are incremental on the owned connection, preserving ADR-0008 connection ownership and generation-guard behavior.
- Good: Per-candidate outcomes and discard/dup-rate metrics make future extraction-volume and embedding decisions evidence-based.
- Good: Existing markdown/dead-letter formats remain readable; new metadata fields are optional/backward-compatible.
- Tradeoff: Collision adjudication is rich for lessons first; non-lesson collision candidates without a model callback are conservatively dead-lettered under terminal staging semantics.
- Tradeoff: Terminal dead-lettering favors bounded drains over indefinite retry. Forensic content remains in `deadletter/`.

## Read when

- Changing `runReconciliation`, shortlist routing, adjudication, staging cleanup, or dead-letter behavior.
- Debugging staged candidates that appear not to drain.
- Modifying persistent-memory write-path crash safety, SQLite indexing, run-log metrics, or model-verdict contracts.
- Changing extraction staging validity, lesson trigger requirements, or offline sweep behavior.

## Supersedes

- ADR-0002
- ADR-0006
