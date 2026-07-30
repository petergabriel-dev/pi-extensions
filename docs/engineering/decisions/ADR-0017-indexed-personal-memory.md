---
id: ADR-0017
title: Indexed user-global personal memory
status: Active
date: 2026-06-30
updated: 2026-07-30
decision: User-global personal memory is an indexed frontmatter-conforming Markdown directory; guided /remember curates visibly, and deterministic saves may target an existing validated slug before regenerating MEMORY.md.
why: Index-first retrieval bounds default context, while explicit slug upsert lets visible curation merge stale/duplicate entries without restoring hidden extraction or reconciliation.
affects: agent/extensions/personal-memory/curation.ts, agent/extensions/personal-memory/store.ts, agent/extensions/personal-memory/index.ts, agent/extensions/personal-memory/test/test_personal_memory.ts, agent/extensions/discussion-notes.ts, agent/extensions/claude-bridge, agent/claude-bridge-client/pi-bridge-mcp.js, ~/.pi/memory/, ~/.pi/memory.md
consequences: Agents see a compact index, fetch relevant entries on demand, and can replace an exact slug; first-response curation saves nothing, tool results prove persistence, and process-local writes serialize around MEMORY.md.
readWhen: changing personal-memory storage, guided /remember, remember slug upsert, recall_memory, recall_memory_entry, save_memory, or legacy ~/.pi/memory.md migration
supersedes: ADR-0016 personal-memory flat-file storage detail
---

# ADR-0017: Indexed user-global personal memory

## Decision

- User-global personal memory now lives under `~/.pi/memory/` as individual markdown entries plus generated `MEMORY.md` index.
- Startup prompt injection includes only the compact `MEMORY.md` index, not full entry bodies.
- Full entry bodies are fetched on demand with `recall_memory_entry(slug)` / bridge `recall_entry`.
- Bare or prefilled `/remember` starts a visible two-turn curation flow. It lists session lesson candidates and asks what to retain before any save.
- The `remember` tool accepts concise text plus an optional validated existing slug. New entries derive a slug; targeted updates replace that exact file and rebuild the index.
- `writeMemoryFact` serializes in-process mutations around the index path; bridge `save_memory` and MCP `save_memory` continue using the same store.
- Legacy `~/.pi/memory.md` migrates once into indexed entries, then moves to `memory.md.bak`; that backup rename is the migration completion signal.
- A pre-existing `~/.pi/memory/` directory does not skip migration.
- Index rebuild includes only markdown entries with conforming `---` frontmatter containing `name`, `description`, and `metadata.type`.
- Non-conforming legacy files under `~/.pi/memory/` are ignored and preserved in place.

## Why

- Full-file injection does not scale as personal memory grows.
- Index-first recall keeps default context small while preserving durable cross-session memory.
- Slugged markdown entries are easy to inspect, edit, delete, and fetch explicitly.
- Bridge/MCP clients need explicit entry fetch and save APIs instead of receiving all personal memory in every recall payload.
- Explicit slug targeting lets current-session curation update a relevant recalled entry instead of deriving a second slug from rewritten text.
- The design keeps ADR-0016's split: project truth stays in engineering docs; personal cross-repo facts stay user-global.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0017-indexed-personal-memory.md`

Code:

- `agent/extensions/personal-memory/curation.ts` (global prompt, pagination, dispatch)
- `agent/extensions/personal-memory/store.ts` (`writeMemoryFact`, `validateSlug`, migration and index helpers)
- `agent/extensions/personal-memory/index.ts` (`/remember`, `remember`, `writeRememberText`)
- `agent/extensions/discussion-notes.ts` (filtered lesson listing)
- `agent/extensions/personal-memory/test/test_personal_memory.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `~/.pi/memory/`
- `~/.pi/memory.md` legacy migration source

## Consequences

- Good: default memory injection is bounded to the index.
- Good: agents can fetch only relevant full entries.
- Good: bridge and MCP have matching recall/save protocol for personal memory.
- Good: users can manage memory as plain markdown files.
- Good: explicit validated slug upsert supports deterministic merge/replacement without breaking legacy text-only saves.
- Risk: duplicate or stale facts can still happen when the session model chooses the wrong existing slug or creates a new entry.
- Risk: write serialization is process-local; multiple Pi processes can still race until cross-process locking is justified.
- Risk: migration depends on parsing old flat-file bullet entries; unusual legacy formatting may need manual cleanup.
- Guardrail: first-response `/remember` curation must not save, and persistence must not be claimed without a successful tool result.
- Guardrail: retired persistent-memory files under `~/.pi/memory/` are not deleted or indexed unless they use conforming fact frontmatter.
- Guardrail: migration idempotency keys off `~/.pi/memory.md.bak`, not `~/.pi/memory/` existence.

## Read when

- Changing personal-memory storage or migration.
- Changing guided `/remember`, explicit slug upsert, or personal-memory prompt injection.
- Changing `recall_memory`, `recall_memory_entry`, `save_memory`, or bridge protocol memory payloads.
- Deciding whether a fact belongs in personal memory or engineering docs.

## Supersedes

- ADR-0016 personal-memory flat-file storage detail only; ADR-0016 remains active for the broader memory boundary.
