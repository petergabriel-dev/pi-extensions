---
id: ADR-0011
title: Per-Candidate Persistent-Memory Reconciliation
status: Active
date: 2026-06-10
---

# ADR-0011: Per-Candidate Persistent-Memory Reconciliation

## Decision

- Reconcile staged memory candidates with monotonic per-candidate progress: normalize/prepare, shortlist, deterministic add when no collision exists, adjudicate collisions, then commit successful candidates without waiting for unrelated candidates.
- Treat an empty shortlist as a deterministic ADD path with host-filled ids, timestamps, scopes, triggers, refs, and per-candidate markdown/SQLite writes.
- Treat lesson shortlist collisions through bounded adjudication verdicts (`distinct`, `duplicate`, `supersedes`, `merge`) whose model output contains no host-owned structural fields.
- Isolate failures to the affected candidate or adjudication batch: failed/invalid candidates are dead-lettered immediately with `reconcile_attempts` tracked for forensic audit; no candidate is re-staged for a future reconciliation cycle (T9 terminal staging consumption). Unattempted candidates (no model, budget exhausted, generation stopped) are also dead-lettered with unchanged attempts.
- Keep records reversible: duplicate reinforces, supersede/merge mark old lessons superseded and create/keep records rather than deleting.
- Supersede ADR-0002 and ADR-0006 as the active reconciliation design; their partial-acceptance, retry, dead-letter, and bounded-work goals are preserved under per-candidate orchestration.

## Why

- Whole-run and chunk-level failure still allowed one bad candidate or one model failure to make reconciliation feel like a coinflip.
- Most staged candidates are distinct enough to add without a model call once lexical shortlist finds no plausible collision.
- Candidate-level commits make crashes monotonic: process death loses at most in-flight work, not already-committed candidates.
- Keeping the model verdict bounded preserves the determinism boundary and makes failures parkable rather than destructive.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0002-reliable-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0006-chunked-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0011-per-candidate-persistent-memory-reconciliation.md`

Code:

- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/consolidation/shortlist.ts`
- `agent/extensions/persistent-memory/consolidation/adjudication.ts`
- `agent/extensions/persistent-memory/consolidation/verdict-apply.ts`
- `agent/extensions/persistent-memory/test/test_per_candidate_reconcile.ts`

## Consequences

- Good: Non-colliding candidates commit with zero model calls.
- Good: A failing candidate parks or dead-letters without rolling back deterministic adds or successful supersedes.
- Good: Reconciliation has clearer per-candidate conservation and terminal semantics (T9: every candidate consumed or dead-lettered, no cross-cycle preservation).
- Bad/risk: Some compatibility code remains for non-lesson legacy reconciliation until later tasks finish replacing every category path.
- Bad/risk: Lesson adjudication is currently richer than preference/decision/domain adjudication because only lessons have status/supersede metadata.

## Read when

- Changing `runReconciliation`, shortlist routing, adjudication, staging cleanup, or dead-letter behavior.
- Debugging staged candidates that park, dead-letter, or appear not to drain.
- Modifying persistent-memory write-path crash safety or model-verdict contracts.

## Supersedes

- ADR-0002
- ADR-0006
