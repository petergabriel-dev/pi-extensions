---
id: ADR-0029
title: Consolidated extension dev tooling
status: Active
date: 2026-08-25
decision: Keep nine runtime extension entrypoints separate; consolidate extension test and typecheck dependencies, locks, and configuration into a root-owned development toolchain in a later implementation.
why: Runtime coupling is small, while nested development tooling duplicates manifests, locks, and TypeScript configuration, permits Pi host peer drift, and leaves typecheck gaps.
affects: package.json, package-lock.json, scripts/check-workspace.mjs, agent/extensions/ccc-search/package.json, agent/extensions/ccc-search/package-lock.json, agent/extensions/ccc-search/tsconfig.json, agent/extensions/engineering-docs/package.json, agent/extensions/filechanges/package.json, agent/extensions/filechanges/package-lock.json, agent/extensions/personal-memory/package.json, agent/extensions/personal-memory/tsconfig.json, agent/extensions/subagents/package.json, agent/extensions/subagents/package-lock.json, agent/extensions/subagents/tsconfig.json, agent/extensions/workflow-modes/package.json, agent/extensions/workflow-modes/package-lock.json, agent/extensions/workflow-modes/tsconfig.json, docs/engineering/architecture.md, docs/engineering/decisions/ADR-0023-workspace-source-runtime-separation.md, docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md, docs/engineering/decisions/README.md
consequences: Runtime extension boundaries remain unchanged; a later migration can remove duplicated development setup and close typecheck/version gaps, but root scripts, workspace checks, manifests, locks, and TypeScript configuration must move together.
readWhen: changing runtime extension boundaries, root or nested package tooling, bootstrap, extension tests/typechecks, Pi host development dependency versions, or workspace manifest checks
supersedes: None
---

# ADR-0029: Consolidated extension dev tooling

> Active decision, not yet implemented. Current manifests, lockfiles, TypeScript configs, `npm run bootstrap`, and root scripts remain authoritative until a dedicated migration lands.

## Decision

- Keep all nine runtime extension entrypoints deliberately separate; do not merge, split, or rename extensions to reduce development-tooling files (`package.json:37-47`).
- In a later scoped migration, move extension test/typecheck dependencies, lock ownership, and shared TypeScript configuration to a root-owned development toolchain. Preserve targeted extension test commands and runtime loading boundaries.
- Migration must close existing typecheck gaps and remove independent Pi host development-version drift rather than merely relocating files (`agent/extensions/engineering-docs/package.json:1-10`, `agent/extensions/filechanges/package.json:1-11`, `agent/extensions/ccc-search/package.json:15`, `agent/extensions/subagents/package.json:21`).
- Move root scripts and integrity checks in lockstep with tooling files. `scripts/check-workspace.mjs` pins the current root manifest shape (`scripts/check-workspace.mjs:67-84`), while bootstrap and aggregate checks encode the current nested topology (`package.json:55-62`).
- This ADR records the target only. It does not change `package.json`, `npm run bootstrap`, any nested manifest, lockfile, TypeScript config, or runtime entrypoint.

## Why

- Runtime separation costs five static sibling imports, with `claude-bridge` the only multi-sibling consumer (`docs/engineering/architecture.md:97`). That coupling does not justify merging runtime extensions.
- Development separation costs six nested manifests, four lockfiles, and four TypeScript configs (`docs/engineering/architecture.md:101-107`).
- Pi host development peers already differ: `ccc-search` uses `^0.80.7`, while `subagents` uses `^0.80.9` (`agent/extensions/ccc-search/package.json:15`, `agent/extensions/subagents/package.json:21`).
- `engineering-docs` and `filechanges` declare no typecheck script, and the root typecheck omits both (`agent/extensions/engineering-docs/package.json:1-10`, `agent/extensions/filechanges/package.json:1-11`, `package.json:62`).
- Tooling consolidation addresses duplicated setup and coverage drift without changing state ownership, event channels, or runtime loading.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/decisions/ADR-0023-workspace-source-runtime-separation.md`
- `docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md`
- `docs/engineering/decisions/README.md`

Future code/config migration:

- `package.json`
- `package-lock.json`
- `scripts/check-workspace.mjs`
- `agent/extensions/ccc-search/package.json`
- `agent/extensions/ccc-search/package-lock.json`
- `agent/extensions/ccc-search/tsconfig.json`
- `agent/extensions/engineering-docs/package.json`
- `agent/extensions/filechanges/package.json`
- `agent/extensions/filechanges/package-lock.json`
- `agent/extensions/personal-memory/package.json`
- `agent/extensions/personal-memory/tsconfig.json`
- `agent/extensions/subagents/package.json`
- `agent/extensions/subagents/package-lock.json`
- `agent/extensions/subagents/tsconfig.json`
- `agent/extensions/workflow-modes/package.json`
- `agent/extensions/workflow-modes/package-lock.json`
- `agent/extensions/workflow-modes/tsconfig.json`

## Consequences

- Good: Nine runtime entrypoints and their ownership/event boundaries remain independently loadable.
- Good: A later root-owned toolchain can provide one dependency installation, one host-version policy, and typecheck coverage for every TypeScript extension.
- Good: Targeted extension tests can remain runnable while root verification becomes less dependent on nested setup drift.
- Bad/risk: Consolidation is a coordinated migration; changing tooling files without root scripts and `check-workspace.mjs` can break bootstrap, package checks, or CI.
- Tradeoff: Shared tooling reduces duplication but makes preserving per-extension targeted commands an explicit migration requirement.
- Temporary: Until migration, six manifests, four lockfiles, four TypeScript configs, and current bootstrap behavior remain supported project truth.

## Relationship to ADR-0023

ADR-0023 remains Active. It decides package source versus Pi-owned runtime-state separation and published resource boundaries (`docs/engineering/decisions/ADR-0023-workspace-source-runtime-separation.md:13-25`); ADR-0029 decides only development-tooling ownership. Neither supersedes the other.

## Read when

- changing the nine runtime extension boundaries or entrypoints
- changing root or nested package manifests, lockfiles, TypeScript configs, or bootstrap
- changing extension test/typecheck aggregation or Pi host development dependency versions
- changing workspace checks that pin package or tooling shape

## Supersedes

- None
