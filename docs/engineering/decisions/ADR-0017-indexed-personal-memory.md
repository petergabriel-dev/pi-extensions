---
id: ADR-0017
title: Indexed user-global personal memory
status: Active
date: 2026-06-30
decision: User-global personal memory is a markdown directory with an index plus fetch-on-demand entries, not one fully injected flat file.
why: The flat ~/.pi/memory.md file grew into full-prompt injection and made personal memory harder to prune, fetch selectively, or share through the bridge safely.
affects: agent/extensions/personal-memory, agent/extensions/claude-bridge, agent/claude-bridge-client/pi-bridge-mcp.js, ~/.pi/memory/
consequences: Agents see a compact memory index by default; full entries require explicit recall_memory_entry; saving rewrites one slug entry and regenerates MEMORY.md.
readWhen: changing personal-memory storage, recall_memory, recall_memory_entry, save_memory, /remember, or legacy ~/.pi/memory.md migration
supersedes: ADR-0016 personal-memory flat-file storage detail
---

# ADR-0017: Indexed user-global personal memory

## Decision

- User-global personal memory now lives under `~/.pi/memory/` as individual markdown entries plus generated `MEMORY.md` index.
- Startup prompt injection includes only the compact `MEMORY.md` index, not full entry bodies.
- Full entry bodies are fetched on demand with `recall_memory_entry(slug)` / bridge `recall_entry`.
- Saves use `writeMemoryFact` / bridge `save_memory` / MCP `save_memory` to write one slug file and rebuild the index.
- Legacy `~/.pi/memory.md` migrates once into indexed entries, then moves to `memory.md.bak`.

## Why

- Full-file injection does not scale as personal memory grows.
- Index-first recall keeps default context small while preserving durable cross-session memory.
- Slugged markdown entries are easy to inspect, edit, delete, and fetch explicitly.
- Bridge/MCP clients need explicit entry fetch and save APIs instead of receiving all personal memory in every recall payload.
- The design keeps ADR-0016's split: project truth stays in engineering docs; personal cross-repo facts stay user-global.

## Affects

Docs:

- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0017-indexed-personal-memory.md`

Code:

- `agent/extensions/personal-memory/store.ts`
- `agent/extensions/personal-memory/index.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `~/.pi/memory/`
- `~/.pi/memory.md` legacy migration source

## Consequences

- Good: default memory injection is bounded to the index.
- Good: agents can fetch only relevant full entries.
- Good: bridge and MCP have matching recall/save protocol for personal memory.
- Good: users can manage memory as plain markdown files.
- Risk: duplicate or stale facts can still happen when agents save a new slug instead of updating the right existing entry.
- Risk: migration depends on parsing old flat-file bullet entries; unusual legacy formatting may need manual cleanup.

## Read when

- Changing personal-memory storage or migration.
- Changing prompt injection for personal memory.
- Changing `recall_memory`, `recall_memory_entry`, `save_memory`, or bridge protocol memory payloads.
- Deciding whether a fact belongs in personal memory or engineering docs.

## Supersedes

- ADR-0016 personal-memory flat-file storage detail only; ADR-0016 remains active for the broader memory boundary.
