---
id: ADR-0023
title: Workspace source and runtime separation
status: Active
date: 2026-07-17
decision: Keep extension source in an independent explicit Pi package while reusing Pi-owned user runtime state outside the repository.
why: Development must preserve history and remain runnable without risking the active global Pi source/config or copying credentials, sessions, personal memory, and generated state into Git.
affects: package.json, .gitignore, .pi/agents, bin/pi-workspace, scripts/check-workspace.mjs, agent/extensions/workflow-modes/index.ts, docs/engineering
consequences: Source can evolve and be verified independently; launcher still shares host Pi auth/settings/models/sessions/personal memory; runtime isolation requires an explicit temporary Pi agent directory.
readWhen: changing package resources, launcher flags, repository/runtime ownership, project agent discovery, ignored state, or migration policy
---

# ADR-0023: Workspace source and runtime separation

## Decision

- Keep this workspace as an independent Git repository preserving imported ancestry, with no remote that points back to the active global Pi source checkout.
- Treat repository as explicit Pi package, not separate Pi home.
- Declare exactly nine extension entrypoints and three authored skills in root `package.json`; expose two project agent definitions through internal `.pi/agents` symlink.
- Launch with `pi --no-extensions -e <repository-root>` so global extension discovery is disabled and workspace package loads once.
- Reuse host Pi auth, settings, model catalogs, sessions, and indexed personal memory through normal Pi runtime ownership. Do not copy them into repository.
- Version source, authored config, and engineering docs only. Exclude credentials, trust/settings/model snapshots, sessions, plans, memory, bridge IPC, caches, DBs, logs, dependency trees, CCC index data, and external symlinks.
- Resolve package-owned assets relative to module/script location. No machine-specific absolute source path or dependency on active `~/.pi` source is allowed.
- Keep clone/migration non-destructive: never move, delete, repoint, disable, or commit inside active global Pi source checkout.

## Why

- Developing directly inside active Pi home couples source edits to current interactive runtime and makes rollback harder.
- Broad config copies risk leaking credentials, sessions, personal memory, and generated state into Git.
- Plain explicit loading without `--no-extensions` can register global and workspace copies together, duplicating commands, hooks, watchers, widgets, and notifications.
- Preserving Git ancestry keeps historical decisions available without retaining a source dependency or remote back to active global checkout.
- Reusing host runtime state avoids duplicating login/model configuration while keeping source package portable.

## Affects

Docs:

- `README.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/conventions.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`

Code/config:

- `package.json`
- `.gitignore`
- `.pi/agents`
- `bin/pi-workspace`
- `scripts/check-workspace.mjs`
- `agent/extensions/workflow-modes/index.ts`

## Consequences

- Good: Workspace source can be edited, tested, documented, and committed without modifying active global Pi source.
- Good: Package inventory and integrity checks make resource scope explicit.
- Good: Global extension duplicates are prevented by launcher flag rather than manual global config changes.
- Good: Credentials, personal memory, sessions, caches, and generated runtime data remain outside Git.
- Good: Module-relative asset resolution works after relocation.
- Bad/risk: Normal workspace runs still share user-global auth/settings/models/sessions/personal memory; source isolation is not full runtime isolation.
- Bad/risk: Live bridge writes ignored project IPC under `.pi/memory/bridge/` while running.
- Tradeoff: Fully isolated live tests must create secure temporary `PI_CODING_AGENT_DIR`, copy only required runtime inputs there, stop Pi, then delete temporary state.

## Read when

- Adding/removing extension, skill, or agent package resources.
- Changing launcher flags or project trust/loading behavior.
- Changing where auth, settings, sessions, plans, memory, bridge IPC, or indexes live.
- Adding symlinks or package-owned assets.
- Migrating this repository or active global Pi source again.

## Supersedes

- None
