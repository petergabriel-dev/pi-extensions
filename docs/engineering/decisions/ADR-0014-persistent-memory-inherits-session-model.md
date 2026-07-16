---
id: ADR-0014
title: Persistent Memory Inherits Session Model
status: Superseded
date: 2026-06-27
decision: Persistent-memory extraction and reconciliation use the active session model from `ctx.model`; there is no picker, persisted override, env override, pinned default, or fallback model.
why: Memory consolidation is manual/on-demand and should match the agent turn that requested it; removed model-resolution surface was extra state, drift, and failure behavior.
affects: persistent-memory model calls, /memory consolidate, /memory reconcile, save_to_memory, /memory menu, engineering decisions index.
consequences: Memory quality/cost follows current chat model; missing `ctx.model` fails clearly instead of silently falling back.
readWhen: changing persistent-memory model calls, save_to_memory, /memory consolidate/reconcile, model selection, settings persistence, or ADR-0005 history
supersedes: ADR-0005
superseded_by: ADR-0016
---

# ADR-0014: Persistent Memory Inherits Session Model

> Superseded by [ADR-0016](ADR-0016-memory-engineering-docs-and-personal-memory.md). Persistent-memory has been retired; project memory now lives in engineering docs and personal cross-repo memory uses indexed `~/.pi/memory/` per [ADR-0017](ADR-0017-indexed-personal-memory.md).

## Decision

- Persistent-memory model work uses the live agent/session model from `ctx.model`.
- `/memory consolidate` extraction passes `ctx.model` to the careful model call.
- `/memory reconcile` and `save_to_memory` reconciliation pass `ctx.model` to reconciliation/adjudication model calls.
- Remove model selection: no `/memory model`, no persisted `persistentMemory.models`, no `PERSISTENT_MEMORY_EXTRACTION_MODEL`, no `PERSISTENT_MEMORY_ADJUDICATION_MODEL`, no legacy `PERSISTENT_MEMORY_RECONCILIATION_MODEL`, no pinned provider/model defaults.
- If `ctx.model` is unavailable at a memory model-call boundary, fail with a clear error instead of choosing a fallback.

## Why

- The new agent-driven save flow is one visible agent turn plus deterministic reconciliation. Model behavior should match the user’s active session model, not hidden memory-specific state.
- Pinned defaults and overrides added configuration surface, stale settings risk, and divergent behavior between chat and memory work.
- Manual/on-demand consolidation keeps cost under user control without a separate model picker.

## Affects

Docs:

- `docs/engineering/decisions/ADR-0005-pinned-default-persistent-memory-careful-model.md`
- `docs/engineering/decisions/ADR-0014-persistent-memory-inherits-session-model.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/package.json`
- `agent/extensions/persistent-memory/model-resolution.ts` (deleted)
- `agent/extensions/persistent-memory/test/test_resolve_careful_model.ts` (deleted)
- `agent/extensions/persistent-memory/test/test_model_override.ts` (deleted)
- `agent/extensions/persistent-memory/test/test_memory_consolidate.ts`

## Consequences

- Good: Memory work is predictable: it uses the same model as the current session/agent turn.
- Good: Removed stale persisted overrides, env-var overrides, pinned defaults, and `/memory model` UI/command complexity.
- Good: Missing model state is explicit and fail-fast, not hidden fallback behavior.
- Tradeoff: Users cannot route memory extraction/adjudication to a cheaper or specialized model independently of the chat model.
- Tradeoff: Memory consolidation cost/quality now varies with the active session model.

## Read when

- Changing persistent-memory extraction, reconciliation, or `save_to_memory` model calls.
- Reintroducing model selection, model env vars, persisted model settings, or fallback behavior.
- Troubleshooting memory consolidation cost, latency, or model quality.
- Reading why ADR-0005 was superseded.

## Supersedes

- ADR-0005
