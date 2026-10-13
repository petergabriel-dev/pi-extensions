---
id: ADR-0023
title: Workspace source and runtime separation
status: Active
date: 2026-10-13
decision: Publish the allowlisted source/assets as public npm package @lopezpetergabriel/pi-extensions, including CHANGELOG.md; keep Pi-owned runtime state outside the repository and never package or copy it into active ~/.pi source. Starting with 0.8.0, ship exactly five bridge client runtime files, exclude docs/engineering/**, identify the source with package.json repository metadata, and mirror the tarball on release. Use Prepare vX.Y.Z commits on main; annotated vX.Y.Z tags from 0.8.0 onward point to release commits, while earlier tags stay on main.
why: A relocatable package preserves source history and clean installation without risking credentials, sessions, personal memory, generated state, or active global Pi source/config.
affects: package.json, package-lock.json, CHANGELOG.md, LICENSE, .gitignore, .pi/agents, bin/pi-workspace, scripts/check-workspace.mjs, scripts/check-package.mjs, scripts/release-branch.mjs, scripts/test-release-branch.mjs, agent/extensions/subagents/agents.ts, agent/agents, docs/engineering
consequences: The package ships eleven extensions, four skills, two bundled agents, the packaged changelog, and exactly five bridge client runtime files from 0.8.0 onward; docs/engineering/** and .cursor/** are excluded. Root package.json declares repository metadata, production dependencies, and Pi peer dependencies. The release branch mirrors the unpacked tarball except optional root .npmrc; Prepare vX.Y.Z commits land on main, while tags from 0.8.0 onward point to release commits and earlier tags stay on main. The release script never pushes.
readWhen: changing package resources or allowlists, dependencies, launcher flags, repository/runtime ownership, project agent discovery, ignored state, npm installation, or migration policy
---

# ADR-0023: Workspace source and runtime separation

## Decision

- Keep this workspace as an independent Git repository preserving imported ancestry, with no remote that points back to the active global Pi source checkout.
- Publish the allowlisted source/assets as npm package `@lopezpetergabriel/pi-extensions`; include `CHANGELOG.md` with the package allowlist. Root `package.json` `repository` metadata identifies the source repository. The package is not a separate Pi home and never contains or copies Pi-owned runtime state.
- Ship exactly eleven extension entrypoints, four authored skills, and two bundled agent definitions. Starting with `0.8.0`, include exactly five bridge client runtime files: `agent/claude-bridge-client/pi-bridge-mcp.js`, `agent/claude-bridge-client/pi-readonly-hook.js`, `agent/claude-bridge-client/pi-peer-hook.js`, `agent/claude-bridge-client/pi-statusline.js`, and `agent/cursor-bridge-client/cursor-readonly-hook.js`. Exclude `docs/engineering/**` and `.cursor/**`; engineering docs, development material, and Cursor commands/config remain on main and are not packaged. Root `package.json` declares extension/skill resources and allowlists package-owned agent assets; root owns production dependencies while Pi packages remain peer dependencies.
- The source launcher `bin/pi-workspace` runs `pi --no-extensions -e <repository-root>` so global extension discovery is disabled and the workspace package loads once; npm installation loads the package without copying source into active `~/.pi`.
- Reuse host Pi auth, settings, model catalogs, sessions, and indexed personal memory through normal Pi runtime ownership. Do not copy them into repository.
- Version only allowlisted source/assets, authored config, and engineering docs on main. Exclude credentials, trust/settings/model snapshots, sessions, plans, memory, bridge IPC, caches, DBs, logs, dependency trees, CCC index data, and external symlinks; never treat Pi-owned runtime state as package content. From `0.8.0`, the npm tarball omits `docs/engineering/**`; `.cursor/**` remains repository-only.
- Resolve package-owned assets relative to module/script location. No machine-specific absolute source path or dependency on active `~/.pi` source is allowed.
- Keep clone/migration non-destructive: never move, delete, repoint, disable, or commit inside active global Pi source checkout.

## Why

- Developing directly inside active Pi home couples source edits to current interactive runtime and makes rollback harder.
- Broad config copies risk leaking credentials, sessions, personal memory, and generated state into Git.
- Plain explicit loading without `--no-extensions` can register global and workspace copies together, duplicating commands, hooks, watchers, widgets, and notifications.
- Preserving Git ancestry keeps historical decisions available without retaining a source dependency or remote back to active global checkout.
- Reusing host runtime state avoids duplicating login/model configuration while keeping source package portable.
- Public npm distribution gives consumers one managed install/update/remove path without copying extension source into active `~/.pi`.

## Affects

Docs:

- `README.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/conventions.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `CHANGELOG.md`

Code/config:

- `package.json`
- `package-lock.json`
- `LICENSE`
- `.gitignore`
- `.pi/agents`
- `bin/pi-workspace`
- `scripts/check-workspace.mjs`
- `scripts/check-package.mjs`
- `agent/extensions/subagents/agents.ts`
- `agent/agents/explorer.md`
- `agent/agents/worker.md`

## Consequences

- Good: Workspace source can be edited, tested, documented, and committed without modifying active global Pi source.
- Good: Package inventory and integrity checks make resource scope explicit.
- Good: Public npm installation provides a managed lifecycle without copying source into active `~/.pi`.
- From `0.8.0`, the release commit tree mirrors the unpacked npm tarball file-for-file; optional root `.npmrc` is the only permitted extra. `scripts/release-branch.mjs` builds this local branch and annotated tag from the already packed artifact and never pushes.
- Prepare release source on main with `Prepare vX.Y.Z`, then create the release branch commit/tag. Tags from `v0.8.0` onward point to release commits; historical tags before `v0.8.0` remain on main.
- Good: Bundled module-relative role definitions make clean installs self-contained while preserving scoped overrides.
- Good: Global extension duplicates are prevented by launcher flag rather than manual global config changes.
- Good: Credentials, personal memory, sessions, caches, and generated runtime data remain outside Git.
- Good: Module-relative asset resolution works after relocation.
- Bad/risk: Normal workspace runs still share user-global auth/settings/models/sessions/personal memory; source isolation is not full runtime isolation.
- Bad/risk: Live bridge writes ignored project IPC under `.pi/memory/bridge/` while running.
- Tradeoff: Root now locks published production dependencies/peers while nested package locks remain development bootstrap inputs.
- Tradeoff: Fully isolated live tests must create secure temporary `PI_CODING_AGENT_DIR`, copy only required runtime inputs there, stop Pi, then delete temporary state.

## Read when

- Adding/removing extension, skill, or agent package resources.
- Changing npm identity, publication allowlist, production dependencies, or release checks.
- Changing launcher flags or project trust/loading behavior.
- Changing where auth, settings, sessions, plans, memory, bridge IPC, or indexes live.
- Adding symlinks or package-owned assets.
- Migrating this repository or active global Pi source again.

## Supersedes

- None
