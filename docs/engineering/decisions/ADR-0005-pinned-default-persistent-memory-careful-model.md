---
id: ADR-0005
title: Pinned Default Persistent-Memory Careful Model
status: Active
date: 2026-06-02
---

# ADR-0005: Pinned Default Persistent-Memory Careful Model

## Decision

- Pin the default persistent-memory careful model to `opencode-go/glm-5.1` when `PERSISTENT_MEMORY_RECONCILIATION_MODEL` or `PERSISTENT_MEMORY_EXTRACTION_MODEL` is unset or blank.
- Preserve explicit environment overrides: when either model env var is set to a resolvable, authenticated model, that model wins over the pinned default.
- Preserve graceful fallback: if the pinned default is missing from the model registry, lacks configured auth, or resolution throws, persistent memory falls back to `ctx.model` and logs the existing warning rather than failing memory work.

## Why

- Recent reconciliation work using the active session model hit `CarefulModelTimeoutError` after the 120s timeout, making memory consolidation unreliable under some chat-model choices.
- Persistent-memory consolidation should be independent from launch context and active session model drift. A code-level default avoids relying on shell profiles or inherited environment variables.
- The tradeoff is coupling this extension to one configured provider/model id. The risk is acceptable because env overrides still win and the registry/auth fallback keeps memory functional if the provider is unavailable.

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

- Good: Default extraction and reconciliation no longer silently ride the active session model.
- Good: Users can still override the careful model via `PERSISTENT_MEMORY_RECONCILIATION_MODEL` and `PERSISTENT_MEMORY_EXTRACTION_MODEL`.
- Good: Missing registry entries or missing auth degrade to the previous `ctx.model` behavior instead of hard-failing memory.
- Bad/risk: The extension now has a user/provider-specific default model id; this must be revisited if `opencode-go/glm-5.1` is removed, renamed, or becomes unsuitable.

## Read when

- Touching persistent-memory model resolution.
- Troubleshooting memory consolidation timeouts.
- Changing default providers/models or model-registry auth behavior.

## Supersedes

- None.
