---
id: ADR-0016
title: Memory = engineering-docs plus user-global personal memory
status: Active
date: 2026-06-29
updated: 2026-07-30
decision: Project memory lives in engineering docs and cross-repo personal memory uses ADR-0017's indexed store; explicit commands may use the visible current session to curate lessons, but no hidden/background persistent-memory extraction or reconciliation system ships.
why: Hidden model extraction/tool compliance proved unreliable and the retired reconciliation system created excessive state; explicit visible curation preserves user intent and observability while deterministic tools remain the only persistence layer.
affects: agent/extensions/discussion-notes.ts, agent/extensions/personal-memory, agent/extensions/claude-bridge, docs/engineering, ~/.pi/memory/, legacy ~/.pi/memory.md, deleted agent/extensions/persistent-memory
consequences: Project/global destinations remain separate; semantic curation is visible and model-behavioral, persistence requires tool-result evidence, and persistent-memory staging, sqlite, reconciliation, reinforcement, and /memory machinery remain retired.
readWhen: changing /notes promote, /remember, memory capture or recall, bridge recall/capture behavior, personal-memory injection, engineering-docs memory boundaries, or persistent-memory history
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

> Personal-memory storage was amended by [ADR-0017](ADR-0017-indexed-personal-memory.md). This record remains Active for the broader project-memory versus user-memory boundary.

## Decision

- Project memory is engineering docs: architecture, workflows, conventions, invariants, traps, and ADRs under `docs/engineering/`.
- Personal cross-repo memory uses slugged markdown entries plus generated `~/.pi/memory/MEMORY.md` index, as amended by ADR-0017.
- `discussion-notes` owns explicit `/notes promote`: it packages active lesson notes as untrusted data for a visible current-session turn that targets only current-project engineering docs. Build/Off may edit; read-only modes propose changes.
- `agent/extensions/personal-memory` owns guided bare/prefilled `/remember`, index injection via `before_agent_start`, deterministic `remember` persistence, and fetch-on-demand full entries. Its first curation response asks what to retain and saves nothing.
- Visible command turns may use the current session model to classify, deduplicate, and merge. Only successful `remember` or edit/write tool results prove persistence; no lifecycle/background model call exists.
- `claude-bridge` no longer depends on persistent-memory internals. `capture_note` updates live discussion notes only; `recall_memory` returns engineering docs plus compact personal-memory index.
- `agent/extensions/persistent-memory/` is deleted. Its extraction, reconciliation, staging, SQLite index, reinforcement, codebase map, `/memory` UI, and `save_to_memory` tool remain retired.

## Why

- Manual E2E showed a model can skip a requested persistence tool, so chat text alone must never count as a successful save.
- Users still benefit from semantic consolidation when it is explicitly requested, visible in the current chat, and backed by deterministic persistence tools whose results remain observable.
- Most project knowledge belongs in durable repo docs readable by humans and other tools, not private Pi metadata stores; Pi-wide preferences and lessons belong in indexed personal memory.
- The retired persistent-memory subsystem had grown into a large, fragile pipeline: hidden extraction, staging, reconciliation, retry/deadletter logic, SQLite indexing, lifecycle hooks, and bridge coupling.
- Two explicit command prompts plus existing deterministic stores meet the curation need without reviving that pipeline.

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

- `agent/extensions/discussion-notes.ts`
- `agent/extensions/personal-memory/curation.ts`
- `agent/extensions/personal-memory/index.ts`
- `agent/extensions/personal-memory/store.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/persistent-memory/` (deleted)
- `~/.pi/memory/`
- `~/.pi/memory.md` (legacy migration source)

## Consequences

- Good: Promotion is explicit, scoped, visible, and uses existing deterministic write paths.
- Good: Large persistent-memory dependency surface remains removed; no hidden extraction or reconciliation returns.
- Good: Project truth is pushed into engineering docs where humans and non-Pi agents can read it; Pi-wide lessons remain user-global.
- Good: Claude bridge can keep Notes widget behavior without staging/reconciliation coupling.
- Risk: semantic classification and merging depend on current-session model behavior; tool-result evidence is required to distinguish persistence from prose.
- Risk: generated `MEMORY.md` index is injected by default, so entry names/descriptions must remain concise.
- Tradeoff: There is no automatic semantic extraction or tiered retrieval; users invoke `/notes promote` or `/remember` when curation is wanted.

## Read when

- Changing `/notes promote`, `/remember`, personal-memory index injection, entry fetch, or legacy `~/.pi/memory.md` migration.
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
