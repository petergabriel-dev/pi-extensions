---
id: ADR-0005
title: Pinned Default Persistent-Memory Model Resolution
status: Active
date: 2026-06-02
---

# ADR-0005: Pinned Default Persistent-Memory Model Resolution

## Decision

- Pin extraction work to `opencode-go/deepseek-v4-flash` via `DEFAULT_EXTRACTION_MODEL`. Env-var: `PERSISTENT_MEMORY_EXTRACTION_MODEL`.
- Pin adjudication / reconciliation judgements to `opencode-go/deepseek-v4-flash` via `DEFAULT_ADJUDICATION_MODEL`. Env-var: `PERSISTENT_MEMORY_ADJUDICATION_MODEL`.
- Legacy reconciliation env-var `PERSISTENT_MEMORY_RECONCILIATION_MODEL` remains supported via the backward-compatible `resolveCarefulModel` entrypoint (defaults to `opencode-go/glm-5.1`).
- Preserve explicit environment overrides: when a model env var is set to a resolvable, authenticated model, that model wins over the pinned default.
- Preserve graceful fallback: if the pinned default is missing from the model registry, lacks configured auth, or resolution throws, persistent memory falls back to `ctx.model` and logs the existing warning rather than failing memory work.

## Why

- Extraction (heavy analysis of conversation transcripts) benefits from a capable model; a small model risks poor extraction quality.
- Adjudication (reconciliation judgements over shortlisted candidates) is a classification task well-suited to a small, fast, cheap model, keeping consolidation latency and cost low.
- Persistent-memory consolidation should be independent from launch context and active session model drift. A code-level default avoids relying on shell profiles or inherited environment variables.
- The tradeoff is coupling this extension to configured provider/model ids. The risk is acceptable because env overrides still win and the registry/auth fallback keeps memory functional if a provider is unavailable.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0005-pinned-default-persistent-memory-careful-model.md`

Code:

- `agent/extensions/persistent-memory/model-resolution.ts`
- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/test/test_resolve_careful_model.ts`
- `agent/extensions/persistent-memory/package.json`

## Consequences

- Good: Extraction and adjudication each have a role-appropriate pinned default, no longer silently riding the active session model.
- Good: Users can override each model independently via `PERSISTENT_MEMORY_EXTRACTION_MODEL` and `PERSISTENT_MEMORY_ADJUDICATION_MODEL`.
- Good: Missing registry entries or missing auth degrade to the previous `ctx.model` behavior instead of hard-failing memory.
- Bad/risk: The extension now has provider-specific default model ids; these must be revisited if `opencode-go/deepseek-v4-flash` or the legacy careful default `opencode-go/glm-5.1` is removed, renamed, or becomes unsuitable.

## Read when

- Touching persistent-memory model resolution.
- Troubleshooting memory consolidation timeouts or cost.
- Changing default providers/models or model-registry auth behavior.
- Adding or changing model roles (extraction vs adjudication).

## Supersedes

- None.
