---
id: ADR-0044
title: Pi-owned global harness setup
status: Active
date: 2026-10-21
decision: Use Pi's `/harness` extension to preview and apply user-global setup from one manifest, managing matching command, plugin, and package-skill symlinks across roots.
why: A Pi-owned, classified and reversible flow avoids npx, native plugins, or docs-only setup; inspection and repair must agree on owned symlinks across package roots.
affects: agent/extensions/harness-setup/index.ts, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/test/test_setup.ts, agent/harness-commands/claude/pi-discuss.md, agent/harness-commands/claude/pi-plan.md, agent/harness-commands/claude/pi-build.md, agent/harness-commands/cursor/pi-discuss.md, agent/harness-commands/cursor/pi-plan.md, agent/harness-commands/cursor/pi-build.md, agent/harness-commands/opencode/pi-discuss.md, agent/harness-commands/opencode/pi-plan.md, agent/harness-commands/opencode/pi-build.md, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, .cursor/commands/pi-build.md, package.json, scripts/check-package.mjs, scripts/check-workspace.mjs, agent/skills/THIRD_PARTY_NOTICES.md, docs/engineering/decisions/ADR-0050-bundled-design-skills-and-harness-export.md, README.md, CHANGELOG.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md, docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md, docs/engineering/decisions/ADR-0044-harness-setup-extension.md, docs/engineering/decisions/README.md
consequences: Install / repair may replace or remove readable regular files up to 1 MiB at the six Pi command names only after preview, confirmation, and a mode-preserving sibling backup verified byte-for-byte against the planned preimage; oversized/unreadable files and other foreign/user-owned destinations remain preserved. Matching owned command/plugin/package-skill symlinks are managed across package roots: Install / repair retargets them and Uninstall deletes them after preview, without backup links (the preview and results show the previous target), and both remove owned `.harness-bak-` links left by versions ≤0.11.0; other foreign files, directories, and symlinks remain untouched. Claude and Codex Pi hooks sit in their own matcher-less groups. Uninstall leaves plain files and regular-file backups in place; restoration is manual, with no restore logic. Live dogfood found plain-file backup siblings absent from Claude Code/OpenCode command lists; Cursor global command discovery remains unverified.
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
- For every apply, show a plan preview and require explicit confirmation. On Install / repair only, replace or remove readable plain regular files up to 1 MiB at `commands/{discuss,plan,build}.md` and `commands/pi-{discuss,plan,build}.md` after a mode-preserving sibling backup is verified byte-for-byte against the planned preimage. At owned command/plugin destinations, symlinks whose targets match a manifest asset path are owned across package roots: Install / repair retargets them; Uninstall deletes them. Preview every planned change. Back up existing regular files before mutation, never symlinks: a sibling backup link still loads as a skill or command, so the preview diff and results report the previous target instead. Install / repair and Uninstall delete owned `<dest>.harness-bak-<ts>` links left by versions ≤0.11.0. Preserve other foreign/user-owned config and files, including foreign symlinks. Uninstall leaves plain files and regular-file backups untouched; no restore logic is provided.
- Write each Claude Pi hook in its own matcher-less group, as for Codex (ADR-0052); never join a foreign group, whose `matcher` would narrow the guard. Inspection flags an owned hook in a matcher group and Install / repair moves it.
- Run startup health checks only when `<agentDir>/harness-setup.json` stamp exists. Checks are advisory and filesystem-only: no harness CLI execution and no automatic repair.
- Export Pi commands, plugins, and package skills from the manifest. ADR-0050 governs the skill inventory, licensing, and directory links; this ADR continues to govern setup lifecycle and safety boundaries. Use `pi-discuss`, `pi-plan`, and `pi-build` command names; ship all three Cursor templates alongside Claude and OpenCode templates.
- Preserve Cursor hook config `failClosed: true`. Real Cursor global command discovery remains unverified; keep repository `.cursor/commands/pi-*` symlinks, and document copying packaged templates into consumer-project `.cursor/commands/` as fallback. This decision does not claim live Cursor confirmation.

## Why

A single Pi-owned install flow provides visible, backup-protected setup and consistent ownership boundaries across harnesses. Native plugins and npx would create separate execution/distribution paths; docs-only setup would leave installation and drift unmanaged. Exact-template hash matching was rejected because edited hand-copies would evade recognition; warn-only was rejected because old command names would remain beside the new `pi-*` commands. Global Cursor discovery is not confirmed, so ship templates while documenting the project-local copy fallback without claiming live behavior. Inspection and repair must classify owned symlinks consistently; config entries already retarget across roots, so matching owned symlinks must too. Preview and the reported previous target mitigate retargeting a link intentionally aimed at another installation; sibling backup links were dropped because harnesses loaded them as duplicate skills (23 per skill root on the author's machine).

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

- Good: one previewed, confirmed, backup-protected setup path preserves foreign content while managing matching command/plugin/skill symlinks across roots.
- Good: inspection and planner share one ownership rule; live and dangling owned links in another root can be repaired or removed.
- Good: eligible plain files at prefixed Pi destinations become package links, while unprefixed files are removed; mode-preserving backups allow manual restoration.
- Good: package-root classification and stamp-gated filesystem-only checks constrain setup and startup behavior.
- Bad/risk: installing from a different package root retargets matching command/plugin links, even when a user intended to keep them on another install; review the preview or run Pi from that package root.
- Bad/risk: unrelated command contents at Pi names are replaced or removed after confirmation, so review the preview; Uninstall leaves plain files and regular-file backups in place with no automatic restore.
- Good: live dogfood confirmed plain-file backup siblings are not listed as commands in Claude Code or OpenCode.
- Good: no backup links, so retargets and uninstalls leave no duplicate skills; an isolated live run (2026-11-04) removed 56 stale links across four harnesses, kept files and foreign links, moved a misplaced Claude hook, and planned zero changes on rerun.
- Bad/risk: a link's old target survives only in the preview and results, not on disk.
- Bad/risk: actual Cursor global command discovery is unverified; consumer projects may need copies of packaged templates under `.cursor/commands/`.

## Read when

- changing `/harness` setup, supported harness roots, package-root classification, or manifest ownership
- changing command names, shipped command templates, Cursor hook safety, startup health checks, or package-skill export

## Extends

- ADR-0019
- ADR-0043

## Supersedes

- ADR-0043's clause keeping Cursor's explicit `pi-build` command repo-local; only that packaging clause is superseded, not ADR-0043's Build lease decision.

## Partially superseded by

- ADR-0050 supersedes this ADR's earlier “Export commands only, never skills” clause and governs package-skill inventory, licensing, and export. This ADR remains active for all other setup, preview, backup, and ownership boundaries.
