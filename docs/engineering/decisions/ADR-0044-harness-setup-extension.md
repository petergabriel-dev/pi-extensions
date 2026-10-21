---
id: ADR-0044
title: Pi-owned global harness setup
status: Active
date: 2026-10-21
decision: Use the Pi `/harness` extension to preview and explicitly apply user-global Claude, Cursor, and OpenCode setup from one manifest, without exporting skills.
why: A Pi-owned, classified and reversible setup flow keeps installation behavior consistent while avoiding npx, native plugins, or docs-only instructions.
affects: agent/extensions/harness-setup/index.ts, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/test/test_setup.ts, agent/harness-commands/claude/pi-discuss.md, agent/harness-commands/claude/pi-plan.md, agent/harness-commands/claude/pi-build.md, agent/harness-commands/cursor/pi-discuss.md, agent/harness-commands/cursor/pi-plan.md, agent/harness-commands/cursor/pi-build.md, agent/harness-commands/opencode/pi-discuss.md, agent/harness-commands/opencode/pi-plan.md, agent/harness-commands/opencode/pi-build.md, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, .cursor/commands/pi-build.md, package.json, scripts/check-package.mjs, scripts/check-workspace.mjs, README.md, CHANGELOG.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md, docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md, docs/engineering/decisions/ADR-0044-harness-setup-extension.md, docs/engineering/decisions/README.md
consequences: Install / repair may replace or remove readable regular files up to 1 MiB at the six Pi command names only after preview, confirmation, and a mode-preserving sibling backup verified byte-for-byte against the planned preimage; oversized/unreadable files and all other foreign/user-owned destinations remain preserved. Uninstall leaves plain files and backups in place; restoration is manual, with no restore logic. Live dogfood found backup siblings absent from Claude Code/OpenCode command lists; Cursor global command discovery remains unverified.
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
- For every apply, show a plan preview and require explicit confirmation. On Install / repair only, replace or remove readable plain regular files up to 1 MiB at `commands/{discuss,plan,build}.md` and `commands/pi-{discuss,plan,build}.md` after a mode-preserving sibling backup is verified byte-for-byte against the planned preimage. Preserve all other foreign/user-owned config and files. Uninstall leaves plain files and backups untouched; no restore logic is provided.
- Run startup health checks only when `<agentDir>/harness-setup.json` stamp exists. Checks are advisory and filesystem-only: no harness CLI execution and no automatic repair.
- Export commands only, never skills. Use `pi-discuss`, `pi-plan`, and `pi-build` command names; ship all three Cursor templates alongside Claude and OpenCode templates.
- Preserve Cursor hook config `failClosed: true`. Real Cursor global command discovery remains unverified; keep repository `.cursor/commands/pi-*` symlinks, and document copying packaged templates into consumer-project `.cursor/commands/` as fallback. This decision does not claim live Cursor confirmation.

## Why

A single Pi-owned install flow provides visible, backup-protected setup and consistent ownership boundaries across harnesses. Native plugins and npx would create separate execution/distribution paths; docs-only setup would leave installation and drift unmanaged. Exact-template hash matching was rejected because edited hand-copies would evade recognition; warn-only was rejected because old command names would remain beside the new `pi-*` commands. Global Cursor discovery is not confirmed, so ship templates while documenting the project-local copy fallback without claiming live behavior.

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

- Good: one previewed, confirmed, backup-protected setup path preserves foreign content outside the six Pi command names.
- Good: eligible plain files at prefixed Pi destinations become package links, while unprefixed files are removed; mode-preserving backups allow manual restoration.
- Good: package-root classification and stamp-gated filesystem-only checks constrain setup and startup behavior.
- Bad/risk: unrelated command contents at Pi names are replaced or removed after confirmation, so review the preview; Uninstall leaves plain files and backups in place with no automatic restore.
- Good: live dogfood confirmed backup siblings are not listed as commands in Claude Code or OpenCode.
- Bad/risk: actual Cursor global command discovery is unverified; consumer projects may need copies of packaged templates under `.cursor/commands/`.

## Read when

- changing `/harness` setup, supported harness roots, package-root classification, or manifest ownership
- changing command names, shipped command templates, Cursor hook safety, or startup health checks

## Extends

- ADR-0019
- ADR-0043

## Supersedes

- ADR-0043's clause keeping Cursor's explicit `pi-build` command repo-local; only that packaging clause is superseded, not ADR-0043's Build lease decision.
