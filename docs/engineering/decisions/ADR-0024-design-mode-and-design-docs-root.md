---
id: ADR-0024
title: Design mode and design docs root
status: Active
date: 2026-07-22
---

# ADR-0024: Design mode and design docs root

## Decision

- Add additive `design` workflow mode.
- Manage design-system artifacts under `docs/design/` with separate `design-docs` manifest.
- Restrict Design writes to `docs/design/**` plus validated manifest `tokenFiles`; fail closed otherwise.

## Why

- Keep design-system planning and generated references separate from implementation code and engineering truth.
- Make token-file permission explicit and auditable.

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

## Consequences

- Good: Design work has scoped prompts, gates, deterministic token references, and preview checks.
- Good: Existing workflow and bridge modes remain additive/backward compatible.
- Bad/risk: Mode and manifest policy must remain synchronized across extensions.

## Read when

- changing workflow modes, design write gates, token parsing, docs/design scaffolding, or bridge prompt recall

## Supersedes

- (none)
