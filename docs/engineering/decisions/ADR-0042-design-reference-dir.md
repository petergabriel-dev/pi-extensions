---
id: ADR-0042
title: Design reference directory convention
status: Active
date: 2026-10-19
decision: Store optional external design references as manual, committed snapshots under docs/design/reference/, separate from canonical design docs and manifest rules.
why: Reviewable source-agnostic snapshots avoid live-tool coupling while keeping untrusted references distinct from instructions and documented specs.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/engineering-docs/filesystem.ts, agent/extensions/engineering-docs/test/test_design.ts, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/decisions/README.md, docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md, docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md, docs/engineering/decisions/ADR-0042-design-reference-dir.md
consequences: Snapshots stay reviewable and source-independent; manual copies can become stale, and reference content remains untrusted and cannot replace documented specs.
readWhen: changing design reference discovery, ingestion, prompt trust boundaries, manifest gates, or scaffold behavior
supersedes: None
---

# ADR-0042: Design reference directory convention

## Decision

- Keep `docs/design/` canonical for design docs and documented specs.
- Use source-agnostic `docs/design/reference/` for manually dropped, committed reference snapshots; do not live-sync a source.
- Gate on reference-directory presence independently of the design manifest. Reference content is untrusted data, never instructions, and does not satisfy the documented-spec rule.
- Scaffold documents this convention but never creates the reference directory.

## Why

Manual committed snapshots are reviewable without a live integration. Keeping references separate preserves `docs/design/` as canonical and prevents external material from becoming instructions or implementation specs.

Rejected alternatives:

- Live OD CLI/daemon/MCP: adds live-tool coupling instead of committed snapshots.
- OD-specific directory: binds convention to one source.
- `/docs import`: adds command-driven ingestion instead of explicit manual drops.
- Design-mode agent copy: adds a separate reference-copy workflow.
- OD satisfying documented-spec gate: confuses supplemental references with canonical specs.
- Manifest-only gating: couples reference presence to a separate design-manifest condition.
- Scaffolded stub directory: turns an optional directory into a scaffold-created one.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md`
- `docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md`
- `docs/engineering/decisions/ADR-0042-design-reference-dir.md`

Code:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/engineering-docs/filesystem.ts`
- `agent/extensions/engineering-docs/test/test_design.ts`

## Consequences

- Good: References remain portable, reviewable snapshots separate from canonical design docs.
- Bad/risk: Manual snapshots can become stale; consumers must treat their contents as untrusted and not as documented specs.

## Read when

- Changing reference discovery, ingestion, prompt trust boundaries, manifest gates, or scaffold behavior.

## Relationship

ADR-0024 and ADR-0037 remain Active and are not superseded.

## Supersedes

- None.
