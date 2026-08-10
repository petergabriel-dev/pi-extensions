---
id: ADR-0027
title: Static host access and agent-directory injection
status: Active
date: 2026-08-10
decision: Use static bare Pi host imports only; resolve getAgentDir() at extension boundaries and pass host-owned agent directories as required arguments to pure plan and personal-memory stores; enforce the rule in scripts/check-workspace.mjs.
why: Pi rewrites static bare imports through its loader alias, but runtime require and variable-specifier dynamic import bypass that alias; broad catches can hide the resulting host-resolution failure and redirect tests to real user state.
affects: agent/extensions/workflow-modes/plan-file.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/personal-memory/index.ts, agent/extensions/personal-memory/store.ts, agent/extensions/claude-bridge/index.ts, scripts/check-workspace.mjs, docs/engineering/conventions.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, ADR-0023, ADR-0020, ADR-0026, docs/engineering/decisions/README.md
consequences: Live host-resolution failures remain visible; default plan and memory locations stay unchanged; disposable PI_CODING_AGENT_DIR redirects plan and personal-memory writes; bare-node tests need disposable host stubs; the static guard covers the nine shipped extension entrypoints.
readWhen: changing Pi host imports, agent-directory or plan/memory path resolution, extension test isolation, or workspace package checks
---

# ADR-0027: Static host access and agent-directory injection

## Decision

- Import Pi host APIs with static bare imports. `createRequire` and variable-specifier `import()` are not supported for `@earendil-works/pi-*` or `@mariozechner/pi-*` packages.
- Resolve `getAgentDir()` at the extension boundary. Pass the resulting root into `workflow-modes/plan-file.ts` and personal-memory path helpers instead of discovering host state inside pure modules.
- Keep the plan body at `<agentDir>/plans/<sessionId>/<planId>.md` and personal memory beside an agent root under `<globalDir>/memory/`; preserve existing validation, atomic plan writes, retention, and default locations.
- Keep `PI_CODING_AGENT_DIR` as a disposable test/smoke-test override. `scripts/check-workspace.mjs` rejects forbidden host-access shapes in its nine shipped extension entrypoints.
- This decision complements ADR-0023's source/runtime boundary and ADR-0020/ADR-0026's plan-store ownership and session-scoping rules. It supersedes nothing.

## Why

Pi loader aliases are applied to static extension imports at build time. A runtime `createRequire()` or a dynamic `import()` whose specifier is held in a variable cannot use that alias. The old fallback path therefore failed outside Pi, while broad catches in plan-file host discovery and session-start GC could hide the failure. Required directory injection keeps pure file helpers testable, preserves host ownership, and makes disposable runtime roots effective for both plan and personal-memory writes.

## Affects

Docs:

- `docs/engineering/conventions.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/decisions/ADR-0020-durable-workflow-plan-store.md`
- `docs/engineering/decisions/ADR-0023-workspace-source-runtime-separation.md`
- `docs/engineering/decisions/ADR-0026-session-scoped-workflow-plan-files-and-task-tracking.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/plan-file.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/personal-memory/index.ts`
- `agent/extensions/personal-memory/store.ts`
- `agent/extensions/claude-bridge/index.ts`
- `scripts/check-workspace.mjs`

## Consequences

- Good: Live Pi sessions use the host-provided agent directory without runtime package discovery.
- Good: Plan and personal-memory tests can use disposable roots without touching normal `~/.pi` state.
- Good: Host-resolution failures propagate instead of becoming an empty plan store or silent fallback.
- Good: The workspace check catches regressions before package or live-session testing.
- Bad/risk: Bare-node tests that load extensions with value host imports need a temporary host stub; the test removes it after execution.
- Tradeoff: Pure stores require callers to supply host-owned roots, while direct helper tests become explicit about storage location.

## Read when

- changing host API imports or loader/package resolution
- changing plan-file or personal-memory directory ownership
- changing disposable Pi-home test or package-smoke isolation
- changing `scripts/check-workspace.mjs` extension-source guardrails

## Supersedes

- None.
