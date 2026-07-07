---
id: ADR-0018
title: Engineering docs root spokes
status: Active
date: 2026-07-07
decision: Engineering-docs emits root AGENTS.md and CLAUDE.md as pure pointer spokes through a non-destructive pi-docs marker-block merge.
why: Many coding agents discover root entrypoint files before project-specific docs, so root spokes make docs/engineering/ visible without copying project truth or risking user content loss.
affects: agent/extensions/engineering-docs/constants.ts, agent/extensions/engineering-docs/filesystem.ts, agent/extensions/engineering-docs/index.ts, agent/extensions/engineering-docs/README.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/dev-workflow.md
consequences: Agents get a stable pointer to invariants/conventions and full engineering docs; root files may be created or updated only inside the managed marker block; docs check can detect and repair missing/stale blocks.
readWhen: changing engineering-docs init/check, manifest.generated, AGENTS.md/CLAUDE.md generation, or marker-block merge behavior
---

# ADR-0018: Engineering docs root spokes

## Decision

- `agent/extensions/engineering-docs/` emits root `AGENTS.md` and `CLAUDE.md` as generated spokes.
- Spokes are pure pointers to canonical docs only:
  - `docs/engineering/invariants.md`
  - `docs/engineering/conventions.md`
  - `docs/engineering/`
- The generated block is delimited by `<!-- pi-docs:start ... -->` and `<!-- pi-docs:end -->`.
- Generation is non-destructive:
  - absent file -> create block-only file;
  - existing file without markers -> append block after a blank line;
  - existing file with markers -> replace only the managed block.
- `manifest.generated` lists the decision index plus `AGENTS.md` and `CLAUDE.md`.
- `/docs check` validates spoke presence, block freshness, and linked doc paths; when writes are allowed it repairs missing/stale blocks.
- `/docs check --check` validates only and never writes.
- Spoke writes remain mode-gated by command-layer write permission: Build/Off only.

## Why

- Coding agents commonly read root entrypoint files before project docs.
- Root spokes let Pi engineering docs become the durable hub for cross-agent project knowledge.
- Keeping spokes as pointers avoids duplicated or stale facts outside `docs/engineering/`.
- Marker-block merge avoids clobbering hand-written `AGENTS.md` or `CLAUDE.md` content.
- Reusing `manifest.generated` keeps generated artifacts visible without a separate subsystem.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0018-engineering-docs-root-spokes.md`

Code:

- `agent/extensions/engineering-docs/constants.ts`
- `agent/extensions/engineering-docs/filesystem.ts`
- `agent/extensions/engineering-docs/index.ts`
- `agent/extensions/engineering-docs/README.md`
- `agent/extensions/engineering-docs/test/test_spokes.ts`
- `AGENTS.md`
- `CLAUDE.md`

## Consequences

- Good: new repos initialized with `/docs init` expose engineering docs to multiple agent tools immediately.
- Good: re-running init/check is idempotent for spokes.
- Good: existing root file content remains user-owned outside the managed block.
- Good: agents receive only doc paths, not generated summaries that can drift.
- Risk: agents may still ignore root entrypoint instructions.
- Risk: future docs path changes must update the generator and validation together.
- Guardrail: never write outside the managed marker block when updating spokes.

## Read when

- Changing `/docs init` output.
- Changing `/docs check` validation or repair behavior.
- Changing `manifest.generated` semantics.
- Changing root `AGENTS.md` or `CLAUDE.md` generation.
- Considering adding more agent-specific root entrypoint files.
