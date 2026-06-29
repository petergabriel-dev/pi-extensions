---
id: ADR-0005
title: Pinned Default Persistent-Memory Model Resolution
status: Superseded
date: 2026-06-02
updated: 2026-06-27
superseded_by: ADR-0016
---

# ADR-0005: Pinned Default Persistent-Memory Model Resolution

> Superseded by [ADR-0016](ADR-0016-memory-engineering-docs-and-personal-memory.md). Persistent-memory has been retired; project memory now lives in engineering docs and personal cross-repo memory lives in `~/.pi/memory.md`.

Superseded by [ADR-0014: Persistent Memory Inherits Session Model](ADR-0014-persistent-memory-inherits-session-model.md). This record is retained for historical context.

## Decision

- Pin extraction work to `opencode-go/deepseek-v4-flash` via `DEFAULT_EXTRACTION_MODEL`. Env-var: `PERSISTENT_MEMORY_EXTRACTION_MODEL`.
- Pin adjudication / reconciliation judgements to `opencode-go/deepseek-v4-flash` via `DEFAULT_ADJUDICATION_MODEL`. Env-var: `PERSISTENT_MEMORY_ADJUDICATION_MODEL`.
- Legacy reconciliation env-var `PERSISTENT_MEMORY_RECONCILIATION_MODEL` remains supported for reconciliation env resolution; `resolveCarefulModel` remains a backward-compatible test/legacy entrypoint (defaults to `opencode-go/glm-5.1`).
- Persisted per-role overrides in `agent/settings.json` at `persistentMemory.models.extraction` and `persistentMemory.models.adjudication` sit above env vars and pinned defaults.
- Effective precedence for live roles: persisted override -> env var -> pinned default -> registry/auth check -> `ctx.model` fallback.
- Preserve explicit environment overrides when no valid persisted override exists: when a model env var is set to a resolvable, authenticated model, that model wins over the pinned default.
- Preserve graceful fallback: if a persisted override or pinned/env target is missing from the model registry, lacks configured auth, or resolution throws, persistent memory falls through or falls back to `ctx.model` and logs a warning rather than failing memory work.

## Why

- Extraction (heavy analysis of conversation transcripts) benefits from a capable model; a small model risks poor extraction quality.
- Adjudication (reconciliation judgements over shortlisted candidates) is a classification task well-suited to a small, fast, cheap model, keeping consolidation latency and cost low.
- Persistent-memory consolidation should be independent from launch context and active session model drift. A code-level default avoids relying on shell profiles or inherited environment variables.
- The tradeoff is coupling this extension to configured provider/model ids. The risk is acceptable because persisted and env overrides exist and the registry/auth fallback keeps memory functional if a provider is unavailable.
- In-TUI switching avoids shell env edits and restart cycles while keeping writes scoped to Pi agent settings.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0005-pinned-default-persistent-memory-careful-model.md`

Code:

- `agent/extensions/persistent-memory/model-resolution.ts`
- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/test/test_resolve_careful_model.ts`
- `agent/extensions/persistent-memory/test/test_model_override.ts`
- `agent/extensions/persistent-memory/package.json`

## Consequences

- Good: Extraction and adjudication each have a role-appropriate pinned default, no longer silently riding the active session model.
- Good: Users can override each model independently via `/memory model`, `/memory model extraction provider/model`, `/memory model adjudication provider/model`, `PERSISTENT_MEMORY_EXTRACTION_MODEL`, and `PERSISTENT_MEMORY_ADJUDICATION_MODEL`.
- Good: Persisted overrides win over env vars/pinned defaults, making model changes immediate and restart-free for future memory runs.
- Good: Missing registry entries or missing auth degrade through the previous chain and then to `ctx.model` instead of hard-failing memory.
- Bad/risk: Persisted overrides can outlive model availability; stale entries warn and fall through, but users may need to rerun `/memory model`.
- Bad/risk: The extension still has provider-specific default model ids; these must be revisited if `opencode-go/deepseek-v4-flash` or the legacy careful default `opencode-go/glm-5.1` is removed, renamed, or becomes unsuitable.

## Read when

- Touching persistent-memory model resolution.
- Troubleshooting memory consolidation timeouts or cost.
- Changing default providers/models or model-registry auth behavior.
- Adding or changing model roles (extraction vs adjudication).
- Changing `/memory model` behavior or `settings.json` persistence shape.

## Superseded by

- ADR-0014

## Supersedes

- None.
