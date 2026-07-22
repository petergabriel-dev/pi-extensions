# Pi Extensions Workspace

Independent development workspace for nine Pi extensions, three authored skills, two subagent definitions, bridge clients, Cursor integration, and canonical engineering docs. The public npm package ships only its allowlisted runtime/resources, not bridge clients or Cursor configuration.

This repository isolates **source**, not Pi user state. Launcher reuses current Pi auth/settings/models/sessions/personal memory while disabling global extension discovery.

## Requirements

- Pi CLI on `PATH`
- Node.js `>=22.19.0`
- npm with network access for first bootstrap and uncached `npx` test dependencies
- Optional: `ccc` for semantic search/indexing, `gh` for live Review-mode GitHub checks

## Install

Public package `@lopezpetergabriel/pi-extensions@0.2.0` ships nine extensions, three skills, and two package-owned bundled agent definitions.

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.2.0
pi install -l npm:@lopezpetergabriel/pi-extensions@0.2.0   # install for this project
pi -e npm:@lopezpetergabriel/pi-extensions@0.2.0   # temporary try
pi list
pi update npm:@lopezpetergabriel/pi-extensions
pi remove npm:@lopezpetergabriel/pi-extensions
```

The exact `@0.2.0` source is pinned. Upgrade a pinned install with `pi install npm:@lopezpetergabriel/pi-extensions@NEW_VERSION`; `pi update npm:@lopezpetergabriel/pi-extensions` updates an unpinned source.

`ccc` remains an external prerequisite for `ccc_search` (`ccc --version`). Existing raw or global copies can double-load; inspect `pi list` and `pi config`, then remove or disable duplicates.

The npm package contains runtime TypeScript/helpers, the workflow plan template, bundled agent and skill Markdown, engineering docs, README/LICENSE, and npm-mandatory nested READMEs under engineering-docs/filechanges. It does not contain tests, bridge clients, Cursor configuration, nested manifests/locks/tsconfigs, `.pi`, `node_modules`, or runtime/user state. Packed and unpacked package checks enforce 512 KiB and 1 MiB limits.

## Develop from source

From repository root:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm run check
./bin/pi-workspace
```

Review any Pi project-trust prompt before approving local resources. Startup header should list exactly nine extensions from this repository and no global extension paths. Exit with `/quit`.

`bin/pi-workspace` executes `pi --no-extensions -e <repository-root>`. Do not replace it with `pi -e .`: without `--no-extensions`, active global copies may load beside workspace copies.

## Common commands

```bash
npm ci --ignore-scripts --legacy-peer-deps # install root published runtime dependency
npm run bootstrap       # npm ci in four lockfile-backed development packages
npm run check           # verify workspace plus npm artifact inventory/size
npm test                # extension tests, typechecks, Cursor hook tests
npm run test:extensions # focused extension tests
npm run typecheck       # all configured TypeScript checks
npm run test:cursor     # Cursor read-only hook regression suite
```

Normal launch may write Pi-owned runtime state outside repository and ignored bridge IPC under `.pi/memory/bridge/`. It never copies credentials/settings into Git. For isolated live bridge testing, use procedure in [`docs/engineering/dev-workflow.md`](docs/engineering/dev-workflow.md).

## Repository map

- `agent/extensions/` — nine package entrypoints and supporting code
- `agent/agents/` — explorer and worker definitions
- `agent/skills/` — grill, grill-with-docs, worker-orchestration
- `agent/claude-bridge-client/` — shared MCP client and Claude read-only hook
- `agent/cursor-bridge-client/` — Cursor read-only hook
- `.cursor/` — project MCP, hooks, and discuss/plan commands
- `docs/engineering/` — canonical architecture, workflow, conventions, invariants, traps, ADRs
- `bin/pi-workspace` — explicit package launcher
- `scripts/check-workspace.mjs` — package/resource integrity check

## Safety boundary

Never add auth, trust/settings/model files, sessions, plans, personal memory, caches, DBs, logs, dependency trees, bridge IPC, or external symlinks. Only tracked `.pi/` resource is `.pi/agents` internal symlink.

See:

- [Architecture](docs/engineering/architecture.md)
- [Development workflow and full test matrix](docs/engineering/dev-workflow.md)
- [Conventions](docs/engineering/conventions.md)
- [Invariants](docs/engineering/invariants.md)
- [Operational traps](docs/engineering/traps.md)
