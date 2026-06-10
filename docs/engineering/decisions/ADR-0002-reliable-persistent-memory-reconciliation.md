---
id: ADR-0002
title: Reliable Persistent-Memory Reconciliation
status: Superseded
date: 2026-05-30
---

# ADR-0002: Reliable Persistent-Memory Reconciliation

## Decision

- **Partial-Batch Acceptance**: Change persistent-memory reconciliation from atomic (all-or-nothing) to partial application. If a batch contains both valid and invalid actions, apply all valid actions to the codebase/index files immediately and isolate the invalid/unapplied candidate actions.
- **Re-Staging Leftovers**: Re-stage unapplied/invalid candidates back to their respective staging files (grouped by `session_id`) using `schemaVersion: 1`, preserving them for a future session instead of dropping them or crashing.
- **Single Repair Retry**: Introduce exactly one repair retry cycle. If the primary LLM call returns invalid actions, invoke the careful model once more with the specific gate-level error details appended to the prompt. If the second attempt still fails, proceed directly to partial-batch application and re-staging.
- **Model Pinned Resolution**: Add support for configuring reconciliation and extraction models independently via environment variables (`PERSISTENT_MEMORY_RECONCILIATION_MODEL` and `PERSISTENT_MEMORY_EXTRACTION_MODEL`). Resolve these using the `ModelRegistry`, verify that API authentication keys are configured (`hasConfiguredAuth`), and gracefully fall back to `ctx.model` (with logged warnings) if resolution or auth fails.
- **Bounded Retry-Cap & Dead-Lettering**: Mitigate stubborn leftovers by capping candidate re-staging attempts via environment variable `PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS` (default 3). Exceeded candidates are written to a `deadletter/` store and inspectable using `/memory deadletter`.

## Why

- **Primary Goal - Reliability**: In real-world operation, a model response that gets $N-1$ out of $N$ actions correct should result in $N-1$ applied and $1$ re-staged, never $0$ applied. Crashing or rejecting the whole batch due to a single invalid action severely degrades agent learning and user experience.
- **Model Independence**: Persistent memory writes must not silently depend on changes to the active chat model or active provider. Separating the memory consolidation model from the session chat model via environment variables enables pinned, highly capable models (e.g. Claude Sonnet/Opus) to run memory reconciliation reliably.
- **Observability**: Providing detailed, gate-level validation error messages (extra keys, coverage mismatch, missing trigger, unknown target_id) allows the user and the repair model to immediately identify what went wrong, avoiding generic "no error detail" failures.

## Affects

Docs:

- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`

Code:

- `extensions/persistent-memory/index.ts`
- `extensions/persistent-memory/consolidation/reconcile.ts`
- `extensions/persistent-memory/consolidation/staging.ts`
- `extensions/persistent-memory/types.ts`

## Consequences

- **Good**: Drastically higher persistent memory consolidation success rates.
- **Good**: Clear visibility into exact validation failures during reconciliation.
- **Good**: Better reliability via fallback mechanisms if custom models are misconfigured or lack API keys.
- **Bad/risk**: Potential accumulation of stubborn invalid leftovers in staging files is mitigated by a bounded retry cap and dead-letter store (via `PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS`, default 3). Stubborn leftovers exceeding this cap are diverted to `deadletter/` and inspectable using `/memory deadletter`.

## Read when

- Touching persistent-memory extension logic.
- Troubleshooting memory reconciliation errors or model selection.
- Modifying consolidation actions and validation rules.

## Supersedes

- None.

## Superseded by

- ADR-0011
