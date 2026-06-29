---
id: ADR-0016
title: Memory = engineering-docs plus user-global personal memory
status: Active
date: 2026-06-29
decision: Project memory lives in engineering docs; small cross-repo personal memory lives in ~/.pi/memory.md; no persistent-memory extraction/reconcile system ships.
why: E2E showed agent-driven tool use is not reliable on gpt-5.5, and model extraction/reconciliation created too much code, state, and failure surface for memory capture.
affects: agent/extensions/personal-memory, agent/extensions/claude-bridge, docs/engineering, ~/.pi/memory.md, deleted agent/extensions/persistent-memory
consequences: Memory capture/recall no longer depends on model obedience; persistent-memory staging, sqlite, reconciliation, reinforcement, and /memory machinery are retired.
readWhen: changing memory capture or recall, bridge recall/capture behavior, personal memory injection, engineering-docs memory boundaries, or reading persistent-memory history
supersedes:
  - ADR-0002
  - ADR-0003
  - ADR-0005
  - ADR-0006
  - ADR-0008
  - ADR-0009
  - ADR-0011
  - ADR-0013
  - ADR-0014
  - ADR-0015
---

# ADR-0016: Memory = engineering-docs plus user-global personal memory

## Decision

- Project memory is engineering docs: architecture, workflows, conventions, invariants, traps, and ADRs under `docs/engineering/`.
- Personal cross-repo memory is one small user-global markdown file at `~/.pi/memory.md`.
- `agent/extensions/personal-memory` owns `/remember <text>` and full-file recall injection via `before_agent_start`.
- `claude-bridge` no longer depends on persistent-memory internals. `capture_note` updates live discussion notes only; `recall_memory` returns engineering docs plus `~/.pi/memory.md`.
- `agent/extensions/persistent-memory/` is deleted. Its extraction, reconciliation, staging, SQLite index, reinforcement, codebase map, `/memory` UI, and `save_to_memory` tool are retired.

## Why

- Manual E2E disproved the agent-driven save requirement: gpt-5.5 can skip `save_to_memory` despite visible instructions.
- Reliable capture must be host-owned: `/remember` is a file append and recall is a file read, with no model choosing whether to comply.
- Most project knowledge belongs in durable repo docs readable by humans and other tools, not private Pi metadata stores.
- The persistent-memory subsystem had grown into a large, fragile write pipeline: model extraction, staging, reconciliation, retry/deadletter logic, SQLite indexing, lifecycle hooks, and bridge coupling.
- A tiny personal file plus engineering docs meets the actual need with less code and fewer failure modes.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0002-reliable-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0003-non-blocking-reason-aware-persistent-memory-consolidation.md`
- `docs/engineering/decisions/ADR-0005-pinned-default-persistent-memory-careful-model.md`
- `docs/engineering/decisions/ADR-0006-chunked-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0008-persistent-memory-reconcile-connection-ownership-observability.md`
- `docs/engineering/decisions/ADR-0009-bridge-staging-validity-malformed-quarantine.md`
- `docs/engineering/decisions/ADR-0011-per-candidate-persistent-memory-reconciliation.md`
- `docs/engineering/decisions/ADR-0013-manual-single-writer-persistent-memory-consolidation.md`
- `docs/engineering/decisions/ADR-0014-persistent-memory-inherits-session-model.md`
- `docs/engineering/decisions/ADR-0015-agent-driven-persistent-memory-save.md`

Code:

- `agent/extensions/personal-memory/index.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/persistent-memory/` (deleted)
- `~/.pi/memory.md`

## Consequences

- Good: Memory capture and recall no longer depend on model tool-call compliance.
- Good: Large persistent-memory dependency surface is removed.
- Good: Project truth is pushed into engineering docs where humans and non-Pi agents can read it.
- Good: Claude bridge can keep Notes widget behavior without staging/reconciliation coupling.
- Risk: `~/.pi/memory.md` is fully injected, so the user must prune it and keep it small.
- Tradeoff: There is no automatic semantic memory extraction or tiered retrieval; explicit `/remember` and engineering docs replace it.

## Read when

- Changing `/remember`, personal-memory injection, or `~/.pi/memory.md` handling.
- Changing bridge `capture_note` or `recall_memory`.
- Deciding where new project memory belongs.
- Reading historical persistent-memory ADRs.

## Supersedes

- ADR-0002
- ADR-0003
- ADR-0005
- ADR-0006
- ADR-0008
- ADR-0009
- ADR-0011
- ADR-0013
- ADR-0014
- ADR-0015
