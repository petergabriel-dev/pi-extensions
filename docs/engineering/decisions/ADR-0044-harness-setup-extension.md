---
id: ADR-0044
title: Pi-owned global harness setup
status: Active
date: 2026-10-21
decision: Use the Pi `/harness` extension to preview and explicitly apply user-global Claude, Cursor, and OpenCode setup from one manifest, without exporting skills.
why: A Pi-owned, classified and reversible setup flow keeps installation behavior consistent while avoiding npx, native plugins, or docs-only instructions.
affects: agent/extensions/harness-setup/index.ts, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/test/test_setup.ts, agent/harness-commands/claude/pi-discuss.md, agent/harness-commands/claude/pi-plan.md, agent/harness-commands/claude/pi-build.md, agent/harness-commands/cursor/pi-discuss.md, agent/harness-commands/cursor/pi-plan.md, agent/harness-commands/cursor/pi-build.md, agent/harness-commands/opencode/pi-discuss.md, agent/harness-commands/opencode/pi-plan.md, agent/harness-commands/opencode/pi-build.md, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, .cursor/commands/pi-build.md, package.json, scripts/check-package.mjs, scripts/check-workspace.mjs, README.md, CHANGELOG.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md, docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md, docs/engineering/decisions/ADR-0044-harness-setup-extension.md, docs/engineering/decisions/README.md
consequences: Setup is previewed, confirmed, backed up, and ours-only merged; package-root classification and stamp-gated filesystem checks limit writes and startup behavior, but real Cursor global command discovery remains unverified and may require project-local template copies.
readWhen: changing `/harness`, user-global harness setup, install manifests, command packaging, or startup health checks
supersedes: ADR-0043 Cursor template packaging clause
extends: ADR-0019, ADR-0043
---

# ADR-0044: Pi-owned global harness setup

## Context

The package needs one supported path for installing its Claude, Cursor, and OpenCode harness surfaces into user-global roots. Repo-local `.cursor/` files remain development integrations; consumers may copy packaged Cursor templates into a project `.cursor/commands/` if global command discovery fails.

## Decision

- Provide setup through Pi's `/harness` menu, rather than npx installation, native harness plugins, or documentation-only instructions.
- Install for user-global Claude, Cursor, and OpenCode roots from one central manifest. Permit user npm/Git package roots, warn on development checkouts, and refuse project, temporary, or unsupported roots before setup.
- For every apply, show a plan preview and require explicit confirmation. Back up existing destinations, merge only package-owned entries, and preserve foreign/user-owned config and files.
- Run startup health checks only when `<agentDir>/harness-setup.json` stamp exists. Checks are advisory and filesystem-only: no harness CLI execution and no automatic repair.
- Export commands only, never skills. Use `pi-discuss`, `pi-plan`, and `pi-build` command names; ship all three Cursor templates alongside Claude and OpenCode templates.
- Preserve Cursor hook config `failClosed: true`. Real Cursor global command discovery remains unverified; keep repository `.cursor/commands/pi-*` symlinks, and document copying packaged templates into consumer-project `.cursor/commands/` as fallback. This decision does not claim live Cursor confirmation.

## Why

A single Pi-owned install flow provides visible, reversible setup and consistent ownership boundaries across harnesses. Native plugins and npx would create separate execution/distribution paths; docs-only setup would leave installation and drift unmanaged. Global Cursor discovery is not confirmed, so ship templates while documenting the project-local copy fallback without claiming live behavior.

## Affects

Docs:

- `README.md`
- `CHANGELOG.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md`
- `docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md`
- `docs/engineering/decisions/ADR-0044-harness-setup-extension.md`
- `docs/engineering/decisions/README.md`

Code, tests, package, and command templates:

- `agent/extensions/harness-setup/index.ts`
- `agent/extensions/harness-setup/manifest.ts`
- `agent/extensions/harness-setup/setup.ts`
- `agent/extensions/harness-setup/test/test_setup.ts`
- `package.json`
- `scripts/check-package.mjs`
- `scripts/check-workspace.mjs`
- `agent/harness-commands/claude/pi-discuss.md`
- `agent/harness-commands/claude/pi-plan.md`
- `agent/harness-commands/claude/pi-build.md`
- `agent/harness-commands/cursor/pi-discuss.md`
- `agent/harness-commands/cursor/pi-plan.md`
- `agent/harness-commands/cursor/pi-build.md`
- `agent/harness-commands/opencode/pi-discuss.md`
- `agent/harness-commands/opencode/pi-plan.md`
- `agent/harness-commands/opencode/pi-build.md`
- `.cursor/commands/pi-discuss.md`
- `.cursor/commands/pi-plan.md`
- `.cursor/commands/pi-build.md`

## Consequences

- Good: one previewed, confirmed, backup-protected setup path preserves user-owned and foreign content.
- Good: package-root classification and stamp-gated filesystem-only checks constrain setup and startup behavior.
- Good: Cursor templates ship in the package while repo-local symlinks remain available; its existing `failClosed: true` hook policy stays intact.
- Bad/risk: actual Cursor global command discovery is unverified; consumer projects may need copies of packaged templates under `.cursor/commands/`.

## Read when

- changing `/harness` setup, supported harness roots, package-root classification, or manifest ownership
- changing command names, shipped command templates, Cursor hook safety, or startup health checks

## Extends

- ADR-0019
- ADR-0043

## Supersedes

- ADR-0043's clause keeping Cursor's explicit `pi-build` command repo-local; only that packaging clause is superseded, not ADR-0043's Build lease decision.
