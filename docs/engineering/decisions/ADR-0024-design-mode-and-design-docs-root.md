---
id: ADR-0024
title: Design mode and design docs root
status: Active
date: 2026-07-22
decision: Design specs and previews are responsive-ready and vertical; Build receives design-system guidance only when docs/design/manifest.json exists.
why: Keep design artifacts implementation-ready without changing non-design Build prompts or making undocumented component creation a hard gate.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/engineering-docs/filesystem.ts, docs/design, docs/engineering/decisions/README.md
consequences: workflow-modes synchronously reads design manifest presence while composing Build prompts; missing or unreadable manifests leave Build unchanged.
readWhen: changing Design prompts, design scaffolds, build prompt composition, frontend component guidance, or bridge prompt recall
---

# ADR-0024: Design mode and design docs root

## Decision

- Add additive `design` workflow mode.
- Manage design-system artifacts under `docs/design/` with separate `design-docs` manifest.
- Restrict Design writes to `docs/design/**` plus validated manifest `tokenFiles`; fail closed otherwise.
- Require responsive-ready, mobile-first specs and previews; previews are single-column, vertically stacked, never grid galleries.
- When `docs/design/manifest.json` exists, append Build guidance to consult documented component specs before frontend changes. Missing specs require explicit user approval before creating components; implementation follows each spec's Responsive section.

## Why

- Keep design-system planning and generated references separate from implementation code and engineering truth.
- Make token-file permission explicit and auditable.
- Keep design previews and resulting implementations responsive without adding lint rules or dependencies.
- Preserve byte-identical Build guidance for projects without design docs; prompt injection is a soft gate, not enforcement.

## Affects

Docs:

- `docs/design/`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`

Code:

- `agent/extensions/workflow-modes/`
- `agent/extensions/engineering-docs/`
- `agent/extensions/claude-bridge/`
- `agent/extensions/engineering-docs/filesystem.ts`

## Consequences

- Good: Design work has scoped prompts, gates, deterministic token references, and preview checks.
- Good: Existing workflow and bridge modes remain additive/backward compatible; projects without a design manifest receive unchanged Build guidance.
- Good: Fresh design scaffolds state responsive and vertical-preview expectations.
- Bad/risk: `workflow-modes` now reads design manifest presence at prompt-compose time, coupling it to `engineering-docs` manifest constants.
- Bad/risk: Build guidance is a soft gate; users must explicitly approve undocumented component creation, but model compliance remains prompt-level.

## Read when

- changing workflow modes, design write gates, token parsing, docs/design scaffolding, or bridge prompt recall

## Supersedes

- (none)
