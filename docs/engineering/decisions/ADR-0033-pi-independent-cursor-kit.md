---
id: ADR-0033
title: Pi-independent Cursor kit
status: Active
date: 2026-08-27
decision: Ship a portable Cursor command, skill, and hook kit that keeps project truth in docs/engineering/ while leaving Pi bridge integration in explicitly pi-prefixed surfaces.
why: Collaborators may have no Pi installation. A docs-as-handoff surface gives every harness one durable project-truth boundary; nudge-not-gate enforcement preserves safety without locking users out; AGENTS.md is the broad context carrier and survives generated spoke refresh outside its markers.
affects: .cursor/commands/discuss.md, .cursor/commands/plan.md, .cursor/commands/build.md, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, .cursor/skills/write-adr/SKILL.md, .cursor/hooks.json, .cursor/hooks/docs-nudge.js, .cursor/hooks/test-docs-nudge.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, AGENTS.md, CLAUDE.md, package.json, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/README.md
consequences: Neutral commands run without Pi or bridge state; project truth remains reviewable in docs/engineering/; commit nudges can be dismissed because they never deny; explicit bridge commands retain live state parity; duplicated handoff instructions require maintenance.
readWhen: changing Cursor commands, hooks, ADR skill, root spoke ownership, docs write-back workflow, or cross-harness bridge boundaries
supersedes: None
---

# ADR-0033: Pi-independent Cursor kit

## Decision

- Ship `.cursor/commands/discuss.md`, `.cursor/commands/plan.md`, and `.cursor/commands/build.md` as a portable workflow for repositories with no Pi installation or bridge configuration.
- Keep `.cursor/commands/pi-discuss.md` and `.cursor/commands/pi-plan.md` as explicitly bridge-backed commands. Neutral and bridge workflows use separate names; neither silently replaces the other.
- Treat `docs/engineering/` and its ADRs as the only project-truth handoff surface. Commands read verified docs and write only task-named canonical files during implementation.
- Append hand-written workflow discipline below the generated marker in `AGENTS.md` and `CLAUDE.md`; generated spoke refresh may replace only marker content.
- Deny Cursor `Write` tools in `.pi` projects with `preToolUse` before execution. Return Cursor's `permission` wire key and supported message fields; never restore files from `afterFileEdit`.
- Run the commit docs check as a nudge, not a gate. When staged non-doc changes omit `docs/engineering/**`, ask for a likely doc update; malformed input or Git failure allows the commit.
- Do not synchronize notes, plans, or other harness-private state between neutral commands and bridge workflows. Shared project truth belongs in docs, while live bridge state remains explicit.

## Why

- A collaborator without Pi must be able to clone a repository, use `/discuss`, `/plan`, and `/build`, and leave a reviewable handoff without installing or configuring a second system.
- Cross-harness state synchronization would add coupling, ownership conflicts, and failure modes. Canonical engineering docs provide a durable, inspectable boundary instead.
- A commit nudge catches likely documentation drift while preserving commit availability when hooks cannot inspect Git or when a user intentionally defers documentation.
- `AGENTS.md` is the broad project-context carrier used by coding harnesses. Keeping the hand-written section outside generated markers preserves it without adding a second rules hierarchy.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0033-pi-independent-cursor-kit.md`

Code and project surfaces:

- `.cursor/hooks.json`
- `.cursor/hooks/docs-nudge.js`
- `.cursor/hooks/test-docs-nudge.js`
- `.cursor/commands/discuss.md`
- `.cursor/commands/plan.md`
- `.cursor/commands/build.md`
- `.cursor/commands/pi-discuss.md`
- `.cursor/commands/pi-plan.md`
- `.cursor/skills/write-adr/SKILL.md`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `AGENTS.md`
- `CLAUDE.md`
- `package.json`

## Consequences

- Good: Neutral Cursor workflows have no dependency on Pi installation, bridge state, or MCP configuration.
- Good: Docs, ADRs, and hand-written spoke discipline give collaborators one inspectable project-truth handoff.
- Good: `preToolUse` blocks Write before execution; the docs nudge can never deny a commit; hook failures fail open for the nudge.
- Good: Explicit `pi-` command names preserve existing bridge recall/capture/save behavior without occupying neutral command names.
- Bad/risk: Neutral commands do not share live notes or saved plans with bridge workflows; users must carry project truth through docs and Git.
- Bad/risk: The nudge is advisory and cannot prove that a documentation update is complete.
- Bad/risk: Cursor hook and command APIs may drift; focused Node-stdlib tests and live acceptance remain necessary.

## Read when

- adding or renaming Cursor commands, skills, or hooks
- changing read-only enforcement or commit-time docs checks
- changing root spoke generation or hand-written content ownership
- changing the boundary between canonical docs and harness-specific state

## Supersedes

- None
