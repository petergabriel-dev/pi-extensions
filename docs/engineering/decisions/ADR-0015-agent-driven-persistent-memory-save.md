---
id: ADR-0015
title: Agent-Driven Persistent-Memory Save Turn
status: Active
date: 2026-06-27
decision: The `/memory` modal Consolidate action starts a normal agent turn that should call `save_to_memory`; the tool validates candidates, writes staging, and runs deterministic foreground reconciliation under the single-writer lock. Missed tool calls get a best-effort nudge to `/memory consolidate`.
why: Saves should be visible in chat while preserving deterministic memory writes and avoiding silent data loss when extension APIs cannot force a main-agent tool call.
affects: /memory menu, save_to_memory, persistent-memory staging/reconcile, modal save-turn safety nudge, architecture/invariants/traps docs.
consequences: Agent extraction is best-effort and visible; actual writes remain deterministic; users retain `/memory consolidate` as fallback.
readWhen: changing `/memory` modal Consolidate, save_to_memory, persistent-memory write invariants, missed-tool nudges, or ADR-0013 manual consolidation flow
supersedes: none
---

# ADR-0015: Agent-Driven Persistent-Memory Save Turn

## Decision

- Bare `/memory` remains a state-aware modal. Selecting **Consolidate** no longer calls `/memory consolidate` directly; it sends a normal user-message directive that starts an agent turn.
- The directive instructs the agent to call `save_to_memory` exactly once with candidates shaped as `{ lessons, preferences, decisions, domain }`, using empty arrays for a no-op save.
- `save_to_memory` is the only write path for agent-driven saves. It normalizes/validates candidates to the staging schema, rejects malformed input before writing, writes staging, then runs foreground reconciliation under `canonical-writer.lock`.
- The agent supplies candidate content only. Host code still owns staging validation, reconciliation decisions, ids, timestamps, status flags, supersede pointers, index writes, run logs, and retry/deadletter behavior.
- Because extensions cannot force the main agent to call a tool, modal-triggered save turns are best-effort. If `turn_end`/`agent_end` occurs without a `save_to_memory` tool call, persistent-memory shows exactly one nudge pointing to deterministic `/memory consolidate`.
- Typed `/memory consolidate`, `/memory reconcile`, and `/memory recover` remain direct deterministic commands from ADR-0013.

## Why

- Users asked for “chat saves the memory”: selecting Consolidate should be visible in the transcript and narrate what was saved.
- Deterministic writes are still load-bearing. Letting the agent write markdown/SQLite directly would break ADR-0013’s single-writer and validation guarantees.
- Pi extension APIs expose normal tool registration and user-message sending, but no forced tool-choice hook for the main agent. The nudge + typed fallback prevents silent data loss.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0015-agent-driven-persistent-memory-save.md`

Code:

- `agent/extensions/persistent-memory/index.ts`
- `agent/extensions/persistent-memory/test/test_save_to_memory_tool.ts`
- `agent/extensions/persistent-memory/test/test_memory_menu.ts`

## Consequences

- Good: Manual modal save is visible in chat, including tool progress and outcomes.
- Good: Actual canonical memory writes remain deterministic, validated, indexed, logged, and single-writer locked.
- Good: Missed agent tool calls are not silent; users get a nudge to `/memory consolidate`.
- Tradeoff: A capable model is expected to follow the directive, but success is not guaranteed.
- Tradeoff: Modal Consolidate behavior differs from typed `/memory consolidate`, which remains direct deterministic extraction/reconcile.

## Read when

- Changing `/memory` modal Consolidate behavior.
- Changing `save_to_memory` parameters, validation, progress, render, or reconciliation behavior.
- Changing missed-tool-call nudges or turn/agent-end event handling.
- Changing persistent-memory write invariants from ADR-0013.

## Supersedes

- None.
