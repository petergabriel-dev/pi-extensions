---
id: ADR-0050
title: Bundled design skills and cross-harness export
status: Active
date: 2026-10-29
decision: Bundle 23 package skills, including pinned Markdown-only design and verification derivatives, and export their skill roots through `/harness` as managed directory symlinks for Claude, Cursor, and OpenCode.
why: Pinned local guidance gives each harness one reviewed offline skill set without copying unlicensed wrappers or adding auto-install steps; the trade-offs are bundle size, manual CLI setup, and unverified live skill discovery.
affects: agent/skills/, agent/skills/THIRD_PARTY_NOTICES.md, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/index.ts, agent/extensions/harness-setup/test/test_setup.ts, package.json, scripts/check-package.mjs, scripts/check-workspace.mjs, agent/skills/web-debug/SKILL.md, agent/skills/worker-orchestration/SKILL.md, agent/skills/grill-with-docs/SKILL.md, docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md, docs/engineering/decisions/ADR-0044-harness-setup-extension.md, docs/engineering/decisions/ADR-0050-bundled-design-skills-and-harness-export.md, docs/engineering/decisions/README.md
consequences: Pinned licensed Markdown guidance works offline; `/harness` uses one package-checked inventory and preserves foreign destinations with preview and backup. Packed limit stays 512 KiB; unpacked limit is 2 MiB. CLI setup is manual, and filesystem tests do not prove live harness discovery.
readWhen: changing bundled skill content, provenance or licenses, package skill inventory, `/harness` skill links, or cross-harness visual verification
supersedes: ADR-0044's command-only/no-skills restriction
---

# ADR-0050: Bundled design skills and cross-harness export

## Context

The package now contains 23 skills: four existing skills plus 19 design and verification skills. ADR-0044 originally limited `/harness` exports to commands and plugins. Frontend verification and design guidance need to remain available offline and consistent across harnesses without importing unlicensed wrappers or relying on runtime network fetches.

## Decision

- Keep bundled skills as Markdown. The three newly added skills are `impeccable`, `web-design-guidelines`, and `playwright-cli`; the 16 Emil Kowalski skills are `emil-design-eng`, `animate`, `animate-expo`, `review-animations`, `improve-animations`, `find-animation-opportunities`, `remove-animations`, `animation-performance`, `animation-vocabulary`, `apple-design`, `write-swift`, `pick-ui-library`, `prototype`, `mobile-native`, `break-ui`, and `ask-sonner`.
- Pin upstream revisions and record source paths, SPDX licenses, full license text, upstream NOTICE content where present, and modifications in `agent/skills/THIRD_PARTY_NOTICES.md`. Impeccable and Playwright derivatives retain Apache-2.0 notices; Emil's skills and the Web Interface Guidelines rules retain MIT notices. The Web Interface Guidelines skill is Pi-authored from the licensed `command.md` rules; the unlicensed `vercel-labs/agent-skills` skill is not copied. Impeccable engine, detector, scripts, hidden state, and platform reference files are omitted.
- Keep the new design and QA guidance model-invoked, with local references loaded on demand. Do not bundle executable scripts or binaries or fetch skill content at runtime. The `playwright-cli` skill alone documents a manual prerequisite, `npm install -g @playwright/cli@latest`; setup never installs or updates it automatically.
- Keep one `PACKAGE_SKILL_NAMES` inventory in `agent/extensions/harness-setup/manifest.ts`. `/harness` links each `agent/skills/<name>` directory to `skills/<name>` in the Claude, Cursor, and OpenCode roots. `check-workspace.mjs` requires this list to match `package.json` `pi.skills`; no skills are exported to `~/.agents/skills`.
- Treat skill links as managed setup entries: preview and confirm changes, back up owned links before retarget/removal, preserve foreign files, directories, and symlinks, and uninstall only owned links. The `playwright-cli` PATH advisory is filesystem-only and never executes the CLI.
- Keep the packed package limit at 512 KiB and the unpacked limit at 2 MiB. Report browser verification as unverified when the CLI or browser is unavailable; skill installation and PATH presence are not evidence of visual verification.
- Existing `web-debug`, `worker-orchestration`, and `grill-with-docs` skills describe Pi tool mappings and non-Pi fallbacks. Their Pi-specific behavior remains unchanged.

## Why

Vendoring licensed, pinned Markdown references keeps guidance available offline and avoids runtime supply-chain changes. One package-driven inventory prevents `/harness` from drifting from Pi's package skills. Managed directory links reuse the installer's preview, backup, and foreign-file protections rather than introducing another installer.

Rejected alternatives:

- Copying the unlicensed Web Design Guidelines skill wrapper or fetching it at runtime would violate the licensing boundary or make QA network-dependent.
- Auto-installing `playwright-cli` would add an unexpected global mutation; the prerequisite stays explicit and user-managed.
- Exporting to `~/.agents/skills` would create a fourth destination and risk duplicate discovery; only the three harness-specific roots are managed.

## Affects

Docs:

- `docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md`
- `docs/engineering/decisions/ADR-0044-harness-setup-extension.md`
- `docs/engineering/decisions/ADR-0050-bundled-design-skills-and-harness-export.md`
- `docs/engineering/decisions/README.md`

Code, package, skills, and tests:

- `agent/skills/`
- `agent/skills/THIRD_PARTY_NOTICES.md`
- `agent/skills/web-debug/SKILL.md`
- `agent/skills/worker-orchestration/SKILL.md`
- `agent/skills/grill-with-docs/SKILL.md`
- `agent/extensions/harness-setup/manifest.ts`
- `agent/extensions/harness-setup/setup.ts`
- `agent/extensions/harness-setup/index.ts`
- `agent/extensions/harness-setup/test/test_setup.ts`
- `package.json`
- `scripts/check-package.mjs`
- `scripts/check-workspace.mjs`

## Consequences

- Good: pinned, licensed skill guidance is locally available without runtime fetches or executable skill payloads.
- Good: Pi and `/harness` share one checked 23-skill inventory; previewed and backed-up links preserve foreign destinations.
- Good: `playwright-cli` gives non-Pi harnesses a documented visual-verification path; Pi retains its gated native `browser_*` tools.
- Bad/risk: the package has a larger unpacked footprint, bounded at 2 MiB; upstream changes require reviewed manual re-vendoring.
- Bad/risk: `playwright-cli` requires user setup. Harness setup tests verify link ownership and safety, not whether each live harness discovers or loads every skill; task 16 owns live dogfood.

## Read when

- changing derived skill content, pinned upstreams, attribution, or license text
- changing Pi skill inventory or `/harness` skill destinations and ownership
- changing browser verification guidance or the manual Playwright CLI prerequisite

## Supersedes

- ADR-0044's restriction to export commands and plugins but never skills. ADR-0044 remains active for all other setup, preview, backup, and ownership boundaries.
