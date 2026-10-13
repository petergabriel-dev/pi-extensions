---
id: ADR-0007
title: Workflow modes direct subagent delegation by prompt
status: Active
date: 2026-10-13
updated: 2026-10-13
decision: Allow at most two substantial disjoint workers within one confirmed saved-plan Build task when concurrencyCap is default 3 or higher; parent freezes contracts, waits for all results, consolidates and verifies, may use one post-settlement fixer; failures block; parent commits and ticks once.
why: Two slices leave a shared lane for a nested explorer; three can exhaust default capacity; blocking nested calls can pause idle timing; delegation remains prompt-enforced.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/plan-tasks.ts, agent/extensions/workflow-modes/test/test_plan_tasks.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/workflow-modes/plan-template.md, agent/extensions/workflow-modes/manual-delegation-verification.md, agent/skills/worker-orchestration/SKILL.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0007-workflow-modes-subagent-delegation.md, docs/engineering/decisions/README.md, CHANGELOG.md
consequences: Two slices leave one slot at capacity 3; parent keeps one gate, commit, and tick; failures block; prompt guidance can under- or over-delegate because fan-out is not structurally enforced.
readWhen: Changing workflow-mode saved-plan Build delegation, worker slicing, nested-worker lane policy, or task verification and commit flow.
---

# ADR-0007: Workflow modes direct subagent delegation by prompt

## Decision

- Workflow modes use prompt guidance over the async `subagent` surface; structural policy remains in the parent launch host.
- Discuss keeps quick lookups inline and uses `subagent` with `agent: "explorer"` only for genuine multi-file or multi-symbol sweeps.
- Plan defaults multi-file, multi-symbol, and fan-out investigation to `subagent` with `agent: "explorer"`, while the parent synthesizes evidence and decisions.
- In Build, handle one confirmed saved-plan Section-4 task at a time. For substantial work, the parent may use one worker or at most two parallel worker slices when the task has at least two substantial disjoint slices and `concurrencyCap` is default 3 or higher; otherwise use one worker or work inline. The optional `Files` hint is advisory; parent assigns actual ownership.
- Before fan-out, the parent writes any shared contract inline. Contract files stay out of slice ownership; each slice task includes the frozen contract. A required contract change is a scope-change request. Each slice owns colocated tests and runs targeted checks; parent waits for every result before consolidation and the Verification Gate.
- After successful slices, parent consolidates and fixes small seams inline. If substantial seam work remains, one normal worker may fix it with union ownership after both slices settle. Any slice failure, block, or scope-change blocks the task: do not abort siblings, repair, or retry; wait for all results, report each slice's status/files/open questions, and do not commit or tick.
- On success, parent retains task selection, final verification, one commit, one tracker tick, and user confirmation before advancing. `subagents_list` monitors runs; `subagent_message` handles live follow-up or parked-question answers.

## Why

- Prompt guidance sets delegation preference while parent toolset/depth/ownership gates enforce safety for async child processes.
- Discuss needs anti-over-delegation thresholds so ordinary product grilling and quick evidence checks stay fast and conversational. Plan benefits from explorer fan-out because planning often needs broad read-only discovery before synthesis.
- Within-task slices parallelize independent implementation without crossing the saved-plan confirmation, verification, and commit boundary.
- A nested `subagent` waits for its result (`agent/extensions/subagents/child.ts`), and every launch acquires from the shared default lane (`agent/extensions/subagents/launch.ts`, `concurrency.ts`); no explorer lane is reserved. Three slices can consume the default capacity of three, leaving nested explorers blocked. At most two slices with `concurrencyCap` at least three leave one lane available. An open tool call pauses idle timeout but not max-total, so lane starvation can persist until the max-total backstop (`docs/engineering/invariants.md`).
- Delegation and slicing remain prompt guidance, not structural policy; under-delegation, over-delegation, or ignoring the cap remains possible. The parent `subagent` Build/toolset gate remains authoritative because child sessions disable normal extensions and workflow hooks.

## Affects

Docs and guidance:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0007-workflow-modes-subagent-delegation.md`
- `docs/engineering/decisions/README.md` (generated)
- `agent/skills/worker-orchestration/SKILL.md`
- `agent/extensions/workflow-modes/plan-template.md`
- `agent/extensions/workflow-modes/manual-delegation-verification.md`
- `CHANGELOG.md`

Code and tests:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/plan-tasks.ts`
- `agent/extensions/workflow-modes/test/test_plan_tasks.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`

## Consequences

- Good: substantial disjoint work can run concurrently without parallelizing saved-plan task checkpoints.
- Good: a free default-lane slot lets a slice worker launch its nested explorer; parent-owned verification, commit, tick, and confirmation remain unchanged.
- Bad/risk: a slice failure blocks the task even if sibling work succeeds; siblings settle before reporting, with no commit or tick.
- Bad/risk: delegation remains prompt-only, so under- or over-delegation and cap violations require manual workflow verification.
- Bad/risk: concise prompt wording still adds per-turn tokens.

## Rejected alternatives

- **Structural fan-out enforcement:** Rejected because slice selection remains a delegation preference; existing launch gates still enforce safety boundaries.
- **Soft-nudge runtime warnings:** Rejected until observed behavior shows prompt guidance is insufficient.
- **Cross-task Section-4 fan-out:** Rejected because task confirmations, Verification Gates, and checkpoint commits remain sequential.
- **Three slices per task:** Rejected; three workers can consume all default lanes and block nested explorers.
- **Dedicated integrator role:** Rejected; the parent owns integration, with one ordinary worker available for substantial post-slice seam fixes.
- **Separate contract-slice phase:** Rejected; the parent can freeze shared contracts inline before fan-out.
- **Inject live concurrency cap into the prompt:** Rejected to avoid new runtime context plumbing; fan-out is disabled when cap is below three or unknown.

## Read when

- changing workflow-mode prompts, saved-plan orchestration, or within-task worker slicing
- changing `subagent`, `subagents_list`, or `subagent_message` contracts
- changing worker-orchestration guidance or nested-worker concurrency
- debugging delegation overuse, underuse, lane starvation, or saved-plan loop regressions

## Supersedes

- None
