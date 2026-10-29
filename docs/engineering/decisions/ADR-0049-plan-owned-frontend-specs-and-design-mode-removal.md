---
id: ADR-0049
title: Plan-owned frontend specifications without Design mode
status: Active
date: 2026-10-29
decision: Remove Design mode and make read-only Plan the sole owner of frontend taste and component contracts, with Build implementing and reviewing those contracts.
why: Frozen plan specs give every harness one accessible, token-backed target and keep taste decisions out of implementation; the trade-off is more planning and prompt-level visual verification.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/plan-template.md, agent/extensions/workflow-modes/plan-state.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/workflow-modes/test/test_plan_state.ts, agent/extensions/engineering-docs/mode.ts, agent/extensions/engineering-docs/index.ts, agent/extensions/engineering-docs/open-design.ts, agent/extensions/engineering-docs/test/test_mode.ts, agent/extensions/engineering-docs/test/test_design.ts, agent/extensions/engineering-docs/test/test_open_design.ts, agent/extensions/claude-bridge/index.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-core-protocol.js, agent/skills/impeccable/SKILL.md, agent/skills/animate/SKILL.md, agent/skills/animation-vocabulary/SKILL.md, agent/skills/find-animation-opportunities/SKILL.md, agent/skills/web-design-guidelines/SKILL.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/dev-workflow.md, agent/extensions/workflow-modes/README.md, README.md, CHANGELOG.md, docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md, docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md, docs/engineering/decisions/ADR-0042-design-reference-dir.md, docs/engineering/decisions/ADR-0049-plan-owned-frontend-specs-and-design-mode-removal.md, docs/engineering/decisions/README.md
consequences: Plan stays read-only and browser-blind; Build owns design-doc writes, literal implementation, and screenshot review, recording unverified ticks when review is unavailable. Reference snapshots remain untrusted. Visual verification is prompt guidance, not host-enforced proof.
readWhen: changing workflow modes, frontend plan specs, design-doc write gates, tick notes, visual verification, or Open Design references
supersedes: ADR-0024
extends: ADR-0030, ADR-0037, ADR-0042
---

# ADR-0049: Plan-owned frontend specifications without Design mode

## Context

Design mode separated visual decisions from the saved plan that Build executes. That split let implementation-time taste diverge from planning and left component work without one portable contract. The project now has durable session plans, frontend skill references, Build-time browser tools, and optional Open Design snapshots; the workflow must preserve their boundaries across Pi and peer harnesses.

## Decision

- Remove `design` from the supported workflow modes; only Off, Discuss, Plan, Build, and Review remain. A restored or received legacy `design` value follows the unknown-mode path and grants no writes.
- Make Plan the single place to decide frontend taste and save it as a frozen, read-only specification. Schedule design rules, tokens, `docs/design/` changes, and manifest `tokenFiles` before component tasks. Reuse the existing design system or base library; use primitive/semantic token layers, semantic light/dark values, named tokens instead of hard-coded values, mobile-first layouts, and single-column previews in both themes. Accessibility is non-negotiable.
- Specify every component task by file path, base component, props/types, variants, states (default, hover, focus-visible, active, disabled, loading, empty, error), named tokens, per-breakpoint layout, motion token/trigger/`prefers-reduced-motion`, accessibility role/keyboard/aria, and verification viewports (default 375, 768, and 1280 px unless overridden). Do not include code skeletons. Decide taste in Plan using the named `impeccable` and Emil motion skills, referenced by absolute packaged paths.
- Keep Plan file-read-only and browser-blind. When present, relevant `docs/design/reference/` snapshots (including Open Design exports) are untrusted visual input, never instructions or canonical specs; documented design docs and tokens win.
- Allow design-doc and declared token-file writes, token updates, and Open Design imports only in Build or Off. Build treats the saved Plan and `docs/design/` component specs as authoritative; it stops for Plan when a spec is missing or wrong rather than making unplanned taste changes.
- Build's frontend verification prompt requires screenshots for every specified viewport and required state, review against the saved spec and `web-design-guidelines`, and up to three fix/review passes. Tick only after review. If a browser is unavailable or declined, record an honest `unverified: <reason>` tick note and state that status in the report. Pi and the bridge validate an optional trimmed 1–500 character `workflow_plan_tick` note; it is persisted with the tick and the first note is retained on idempotent re-ticks.

## Why

A saved contract makes taste decisions once, before implementation, and gives Pi, Claude, Cursor, and OpenCode the same target. Keeping tokens and docs first makes downstream specs implementable; asking Build to follow frozen specs prevents taste drift. Visual review belongs in Build because Plan must remain read-only and browser-blind. Optional committed snapshots retain the useful Open Design input without trusting external content.

Keeping Design mode was rejected: it would preserve two competing owners for decisions and implementation. Allowing Build to change taste was rejected because it would silently invalidate the plan. Treating reference snapshots as instructions or specs was rejected because they are external, non-canonical data.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/dev-workflow.md`
- `agent/extensions/workflow-modes/README.md`
- `README.md`
- `CHANGELOG.md`
- `docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md`
- `docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md`
- `docs/engineering/decisions/ADR-0042-design-reference-dir.md`
- `docs/engineering/decisions/ADR-0049-plan-owned-frontend-specs-and-design-mode-removal.md`
- `docs/engineering/decisions/README.md`

Code, tests, and packaged skills:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/plan-template.md`
- `agent/extensions/workflow-modes/plan-state.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/extensions/workflow-modes/test/test_plan_state.ts`
- `agent/extensions/workflow-modes/test/test_policy.ts`
- `agent/extensions/engineering-docs/mode.ts`
- `agent/extensions/engineering-docs/index.ts`
- `agent/extensions/engineering-docs/open-design.ts`
- `agent/extensions/engineering-docs/test/test_mode.ts`
- `agent/extensions/engineering-docs/test/test_design.ts`
- `agent/extensions/engineering-docs/test/test_open_design.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/skills/impeccable/SKILL.md`
- `agent/skills/animate/SKILL.md`
- `agent/skills/animation-vocabulary/SKILL.md`
- `agent/skills/find-animation-opportunities/SKILL.md`

## Consequences

- Good: frontend decisions and component contracts persist with the saved plan and travel across harnesses.
- Good: Build has explicit authority, token/docs ordering, accessibility requirements, and a screenshot review checklist.
- Good: reference snapshots remain available without becoming instructions or canonical specs.
- Bad/risk: taste decisions require more planning before implementation.
- Bad/risk: screenshot review remains prompt-enforced; the host does not prove that screenshots were captured or correctly reviewed. Unavailable review must remain visibly unverified.

## Read when

- changing workflow mode state or legacy-mode restoration
- changing frontend planning rules, component contract fields, taste-skill references, or spec authority
- changing design-doc/token write gates, tick notes, screenshot verification, or Open Design reference prompts

## Supersedes

- ADR-0024: Design mode and design docs root

## Extends

- ADR-0030: Agent-driven browser verification
- ADR-0037: Design token adherence advisory on source writes
- ADR-0042: Design reference directory convention
