---
id: ADR-0024
title: Design mode and design docs root
status: Active
date: 2026-07-22
decision: Design specs and previews are responsive-ready and vertical; Design adopts documented existing systems before inventing new ones, supports both dark-theme roots, and Build receives design-system guidance only when docs/design/manifest.json exists.
why: Keep design artifacts implementation-ready without changing non-design Build prompts or making undocumented component creation a hard gate; preserve existing project systems without dead manifest metadata.
affects: agent/extensions/engineering-docs/design.ts, agent/extensions/engineering-docs/filesystem.ts, agent/extensions/engineering-docs/test/test_design.ts, agent/extensions/workflow-modes/index.ts, docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md, docs/engineering/decisions/README.md
consequences: workflow-modes synchronously reads design manifest presence while composing Build prompts; missing or unreadable manifests leave Build unchanged; theme/base-system adoption remains prompt guidance rather than manifest schema.
readWhen: changing Design prompts, design scaffolds, token parsing, preview themes, base-library guidance, build prompt composition, frontend component guidance, or bridge prompt recall
---

# ADR-0024: Design mode and design docs root

## Decision

- Add additive `design` workflow mode.
- Manage design-system artifacts under `docs/design/` with separate `design-docs` manifest.
- Restrict Design writes to `docs/design/**` plus validated manifest `tokenFiles`; fail closed otherwise.
- Require responsive-ready, mobile-first specs and previews; previews are single-column, vertically stacked, never grid galleries.
- Inspect and adopt or extract existing styles/components before creating tokens or specs. When a named base library exists, record it in `docs/design/README.md` and derive specs from base components.
- Parse `.dark` as a dark-theme token root with `\.dark(?![\w-])`, alongside existing `:root` and `[data-theme="dark"]` roots; semantic tokens define both light and dark values.
- Scaffold native preview theme-toggle buttons that switch root `data-theme`; projects with `.dark`-class systems toggle that class instead.
- Reject a `baseSystem` manifest field: it would be dead metadata until tooling branches on it.
- When `docs/design/manifest.json` exists, append Build guidance to consult documented component specs before frontend changes. Missing specs require explicit user approval before creating components; implementation follows each spec's Responsive section.

## Why

- Keep design-system planning and generated references separate from implementation code and engineering truth.
- Make token-file permission explicit and auditable.
- Keep design previews and resulting implementations responsive without adding lint rules or dependencies.
- Preserve existing design systems and base-library composition through soft Design guidance rather than a new manifest field or hard gate.
- Preserve byte-identical Build guidance for projects without design docs; prompt injection is a soft gate, not enforcement.

## Affects

Docs:

- `docs/design/README.md`
- `docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/engineering-docs/design.ts`
- `agent/extensions/engineering-docs/filesystem.ts`
- `agent/extensions/engineering-docs/test/test_design.ts`
- `agent/extensions/workflow-modes/index.ts`

## Consequences

- Good: Design work has scoped prompts, gates, deterministic token references, and preview checks.
- Good: Existing workflow and bridge modes remain additive/backward compatible; projects without a design manifest receive unchanged Build guidance.
- Good: Fresh design scaffolds state responsive/vertical-preview expectations and provide an accessible native theme toggle.
- Good: Existing systems and base libraries are adopted instead of duplicated; token references support common `.dark` CSS.
- Bad/risk: `workflow-modes` now reads design manifest presence at prompt-compose time, coupling it to `engineering-docs` manifest constants.
- Bad/risk: Build and adoption guidance are soft gates; model compliance remains prompt-level.
- Tradeoff: `baseSystem` is intentionally not stored in the manifest because no tooling branches on it; add schema only when behavior needs structured data.

## Read when

- changing Design prompts, design write gates, token parsing, docs/design scaffolding, preview themes, base-library guidance, or bridge prompt recall

## Supersedes

- (none)
