# Pi Extensions

`@lopezpetergabriel/pi-extensions@0.6.0` is a Pi package and source workspace containing eleven extensions, four skills, and two bundled agent definitions. The repository is source for the package, not a separate Pi home: Pi continues to own authentication, settings, models, sessions, and personal memory.

## Requirements

- Pi CLI on `PATH`
- Node.js `>=22.19.0`
- npm and network access for the first bootstrap and uncached `npx` test dependencies
- Optional: `ccc` for `ccc_search`; `gh` for live Review-mode GitHub checks
- For browser verification: Chromium, installed with `cd agent/extensions/browser && npx playwright install chromium`

## Install and try the package

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.6.0
pi install -l npm:@lopezpetergabriel/pi-extensions@0.6.0   # this project only
pi -e npm:@lopezpetergabriel/pi-extensions@0.6.0           # temporary try
pi list
```

These install commands pin `@0.6.0`. Upgrade an installed package to the latest release with:

```bash
pi update npm:@lopezpetergabriel/pi-extensions
```

Remove it with `pi remove npm:@lopezpetergabriel/pi-extensions`. A bare `pi update` updates Pi itself, not package extensions.

Install `ccc` separately before using `ccc_search`; verify it with `ccc --version`. Raw or global copies of these extensions can load twice alongside the package. Use `pi list` and `pi config` to inspect registrations, then remove or disable duplicates.

## Develop from source

From the repository root:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm run check
./bin/pi-workspace
```

`npm run bootstrap` installs the lockfile-backed development packages under `agent/extensions/`. `npm run check` verifies the workspace and npm artifact inventory. The launcher runs `pi --no-extensions -e <repository-root>` so global extension discovery is disabled and this checkout is loaded once. Do not replace it with `pi -e .`.

Review the Pi project-trust prompt before approving local resources. On startup, the extension header should list exactly eleven extensions from this repository and no global extension paths. Use `/quit` to exit. Add `--no-session` to the launcher for a disposable parent session:

```bash
./bin/pi-workspace --no-session
```

## Common commands

```bash
npm run check                 # workspace and package integrity/size checks
npm test                      # full configured test, typecheck, and Cursor-hook gate
npm run test:ask-user-question
npm run test:extensions
npm run typecheck
npm run test:cursor
npm run test:cursor-kit
```

The focused commands are useful while iterating; `npm test` runs the complete configured gate after bootstrap.

## Contents

### Extensions

- `ask-user-question` — model-initiated text, single-select, and multi-select questions, including context defer/resume.
- `browser` — gated persistent Chromium browser tools and parent/child browser proxies.
- `ccc-search` — bounded `ccc_search` semantic search.
- `claude-bridge` — live bridge watcher and request handling for the Pi-side bridge.
- `discussion-notes` — `discussion_notes`, `/notes`, and the Notes UI.
- `engineering-docs` — engineering-document operations, tag validation, and generated spokes/indexes.
- `filechanges` — branch-local tracking and accept/decline rollback for successful Pi `edit`/`write` mutations.
- `notify` — terminal-native “Ready for input” notifications.
- `personal-memory` — user-global indexed memory and `/remember`.
- `subagents` — isolated child Pi processes with tool, ownership, and workflow-mode policy.
- `workflow-modes` — `/mode`, `/plan`, `/caveman`, prompt composition, and read-only/mutation gates.

### Skills and agents

- Skills: `grill`, `grill-with-docs`, `web-debug`, and `worker-orchestration`.
- Bundled agents: `explorer` for repository-read-only discovery and `worker` for Build-mode implementation.

### Repository map

- `agent/extensions/` — extension entrypoints and supporting source
- `agent/skills/` — authored skills
- `agent/agents/` — bundled agent definitions
- `agent/claude-bridge-client/` and `agent/cursor-bridge-client/` — bridge clients and read-only hooks
- `.cursor/` — Cursor integration and workflow commands
- `docs/engineering/` — canonical engineering documentation
- `bin/pi-workspace` — isolated source launcher
- `scripts/check-workspace.mjs` — workspace/resource integrity check

## Safety and package boundary

The launcher reuses the current Pi user state; it does not create a separate Pi home or copy credentials/settings into Git. Runtime state may remain in Pi-owned locations outside the repository, and bridge IPC under `.pi/memory/bridge/` is ephemeral and ignored.

Never add credentials, trust/settings/model files, sessions, plans, personal memory, caches, databases, logs, dependency trees, bridge IPC, CCC indexes, or external symlinks to the repository. The only tracked `.pi/` resource is the internal `.pi/agents` symlink.

The public npm package allowlist contains runtime TypeScript/helpers, the workflow plan template, agent and skill Markdown, `docs/engineering/**`, `README.md`, `LICENSE`, `CHANGELOG.md`, and required nested READMEs. It excludes tests, nested manifests/lockfiles/TypeScript configs, bridge clients, Cursor configuration, `.pi`, `node_modules`, and runtime/user state. Package checks enforce `<=512 KiB` packed and `<=1 MiB` unpacked limits.

## Documentation

Canonical project truth lives under [`docs/engineering/`](docs/engineering/). Start with:

- [Engineering docs index](docs/engineering/README.md)
- [Architecture and package boundary](docs/engineering/architecture.md)
- [Development workflow and test matrix](docs/engineering/dev-workflow.md)
- [Conventions](docs/engineering/conventions.md)
- [Invariants](docs/engineering/invariants.md)
- [Operational traps](docs/engineering/traps.md)

Edit canonical engineering docs rather than generated `AGENTS.md`, `CLAUDE.md`, or index content; regenerate generated outputs when required.
