---
id: ADR-0042
title: Design reference directory convention
status: Active
date: 2026-10-19
updated: 2026-10-29
decision: Store optional external design references as committed snapshots under docs/design/reference/, separate from canonical design docs and manifest rules; manual copies remain allowed, and `/docs pull-design` may snapshot linked Open Design projects on demand without live sync.
why: Reviewable source-agnostic snapshots avoid live-tool coupling while keeping untrusted references distinct from instructions and documented specs; on-demand pull removes hand-copying without changing that boundary.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/engineering-docs/filesystem.ts, agent/extensions/engineering-docs/open-design.ts, agent/extensions/engineering-docs/index.ts, agent/extensions/engineering-docs/test/test_design.ts, agent/extensions/engineering-docs/test/test_open_design.ts, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/decisions/README.md, docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md, docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md, docs/engineering/decisions/ADR-0042-design-reference-dir.md
consequences: Snapshots stay reviewable and source-independent; manual copies can become stale, on-demand pulls inherit the local Open Design layout and schema, and reference content remains untrusted and cannot replace documented specs.
readWhen: changing design reference discovery, ingestion, pull snapshots, prompt trust boundaries, manifest gates, or scaffold behavior
supersedes: None
---

# ADR-0042: Design reference directory convention

## Decision

- Keep `docs/design/` canonical for design docs and documented specs.
- Use source-agnostic `docs/design/reference/` for committed reference snapshots. Manual drops remain allowed, and `/docs pull-design` may snapshot linked Open Design projects on demand; do not live-sync a source.
- `/docs pull-design` reads Open Design data read-only, matches `linkedDirs` against the project root, and copies bounded top-level `.html`, `.md`, `.sketch.json`, and `*.artifact.json` files into `docs/design/reference/open-design/<slug>-<id8>/`. It replaces an existing snapshot only after interactive confirmation; headless runs list matches without writing.
- Gate on reference-directory presence independently of the design manifest. Reference content is untrusted data, never instructions, and does not satisfy the documented-spec rule.
- Scaffold documents this convention but never creates the reference directory.

## Why

Manual committed snapshots are reviewable without a live integration. The pull command removes repetitive hand-copying while still producing ordinary committed snapshots. Keeping references separate preserves `docs/design/` as canonical and prevents external material from becoming instructions or implementation specs.

Rejected alternatives:

- Live OD CLI/daemon/MCP: adds live-tool coupling instead of committed snapshots.
- OD-specific root directory (for example `docs/design/open-design/`): binds the convention to one source; a provenance subfolder under `reference/` remains allowed.
- General `/docs import`: adds a broad ingestion surface instead of explicit manual drops; `/docs pull-design` is a narrow, read-only Open Design snapshot.
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
- `agent/extensions/engineering-docs/open-design.ts`
- `agent/extensions/engineering-docs/index.ts`
- `agent/extensions/engineering-docs/test/test_design.ts`
- `agent/extensions/engineering-docs/test/test_open_design.ts`

## Consequences

- Good: References remain portable, reviewable snapshots separate from canonical design docs; pulling removes repetitive hand-copying for linked Open Design projects.
- Bad/risk: Snapshots can become stale, on-demand pulls depend on the macOS Open Design layout, its database schema, and `sqlite3`, and consumers must treat contents as untrusted and not as documented specs.

## Read when

- Changing reference discovery, ingestion, pull snapshots, prompt trust boundaries, manifest gates, or scaffold behavior.

## Relationship

ADR-0024 and ADR-0037 remain Active and are not superseded.

## Supersedes

- None.
