---
id: ADR-0007
title: Workflow modes direct subagent delegation by prompt
status: Active
date: 2026-08-27
---

# ADR-0007: Workflow modes direct subagent delegation by prompt

## Decision

- Workflow modes use prompt guidance over the async `subagent` surface; structural policy remains in the parent launch host.
- Discuss keeps quick lookups inline and uses `subagent` with `agent: "explorer"` only for genuine multi-file or multi-symbol sweeps.
- Plan defaults multi-file, multi-symbol, and fan-out investigation to `subagent` with `agent: "explorer"`, while the parent synthesizes evidence and decisions.
- Build uses the worker-orchestration A+B model: for a substantial confirmed saved-plan Section-4 task, start exactly one async `subagent` with `agent: "worker"`, task text as `task`, and scoped `fileOwnership`; skip workers for trivial one-line tasks.
- `subagents_list` monitors runs and `subagent_message` handles live follow-up or parked-question answers. The parent retains saved-plan task selection, Verification Gate, final verification, commits, and confirmation before advancing.
- Parallel worker fan-out remains reserved for ad-hoc multi-task Build requests outside the saved-plan Section-4 loop.

## Why

- Prompt guidance sets delegation preference while parent toolset/depth/ownership gates enforce safety for async child processes.
- Discuss needs anti-over-delegation thresholds so ordinary product grilling and quick evidence checks stay fast and conversational.
- Plan benefits from explorer fan-out because planning often needs broad read-only discovery before synthesis.
- Saved-plan Build mode already has a load-bearing one-task-at-a-time confirmation/verification/commit loop; sequential worker use preserves that loop while still offloading substantial isolated implementation.
- The parent `subagent` Build/toolset gate remains authoritative because child sessions disable normal extensions and workflow hooks.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/decisions/ADR-0007-workflow-modes-subagent-delegation.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/subagents/index.ts`
- `agent/skills/worker-orchestration/SKILL.md`

## Consequences

- Good: mode prompts now consistently advertise when to use explorers and workers.
- Good: existing read-only mode gates and the parent-side worker Build gate stay unchanged.
- Good: saved-plan Build keeps parent-owned verification, commits, and user confirmation.
- Bad/risk: delegation remains behavioral prompt guidance, so under-delegation or over-delegation can still occur and must be watched through manual workflow verification.
- Bad/risk: prompt wording adds per-turn tokens, so delegation guidance must stay concise.

## Rejected alternatives

- **Structural enforcement:** Rejected for v1 because existing gates already enforce safety boundaries and the desired behavior is delegation preference, not a permission boundary.
- **Soft-nudge runtime warnings:** Rejected until observed behavior shows prompt guidance is insufficient.
- **Parallel Section-4 fan-out:** Rejected because saved-plan tasks are intentionally sequential with a checkpoint commit and explicit confirmation between tasks.

## Read when

- changing workflow-mode prompts or saved-plan orchestration
- changing `subagent`, `subagents_list`, or `subagent_message` contracts
- changing worker-orchestration guidance
- debugging delegation overuse, underuse, or saved-plan loop regressions

## Supersedes

- None
