# Pi Extensions Workspace

Independent development workspace for nine Pi extensions, three authored skills, two subagent definitions, bridge clients, Cursor integration, and canonical engineering docs.

This repository isolates **source**, not Pi user state. Launcher reuses current Pi auth/settings/models/sessions/personal memory while disabling global extension discovery.

## Requirements

- Pi CLI on `PATH`
- Node.js `>=22.19.0`
- npm with network access for first bootstrap and uncached `npx` test dependencies
- Optional: `ccc` for semantic search/indexing, `gh` for live Review-mode GitHub checks

## Quick start

From repository root:

```bash
npm run bootstrap
npm run check
./bin/pi-workspace
```

Review any Pi project-trust prompt before approving local resources. Startup header should list exactly nine extensions from this repository and no global extension paths. Exit with `/quit`.

`bin/pi-workspace` executes:

```bash
pi --no-extensions -e <repository-root>
```

Do not replace it with `pi -e .`: without `--no-extensions`, active global copies may load beside workspace copies.

## Common commands

```bash
npm run bootstrap       # npm ci in four lockfile-backed extension packages
npm run check           # verify 9 extensions, 3 skills, 2 agents, internal link
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
