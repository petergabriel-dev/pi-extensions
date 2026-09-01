---
name: worker-orchestration
description: Guides contract-first orchestration of Pi worker subagents. Use when decomposing implementation work across workers, deciding parallel vs sequential execution, assigning disjoint file ownership, or doing a final integration pass.
---

# Worker Orchestration

Use this skill when coordinating worker subagents for implementation work.

## Current Pi Surface

Parent starts work with `subagent` using `agent: "worker"`; discovery uses `agent: "explorer"`. Use `subagents_list` for status and `subagent_message` for live follow-up or parked-question answers. Nested children use `subagent` only when their agent definition allowlists the child and depth remains bounded.

## Core Model

Use an **A+B orchestration model**:

- **A — Main agent / orchestrator:** owns decomposition, contracts, ordering, integration, final verification, and user-facing decisions.
- **B — Worker subagents:** execute scoped implementation contracts and return structured summaries. They do not own overall architecture or final integration.

The orchestrator must keep worker outputs bounded and actionable. Do not paste or rely on full worker transcripts; consume only structured returns.

## Contract-First Decomposition

Before spawning a worker, write a compact contract:

1. **Goal:** one concrete outcome.
2. **Scope:** exact files, directories, or component boundaries.
3. **File ownership:** paths/globs the worker may modify.
4. **Inputs:** relevant context or prior explorer findings.
5. **Constraints:** invariants, non-functional requirements, and forbidden changes.
6. **Expected output:** Summary / Files Touched / Commands / Follow-ups / Open Questions.
7. **Verification:** targeted checks the worker should run or report as not run.

Do not spawn workers with vague tasks like “fix the feature.” Split until ownership and verification are clear.

## Parallel vs Sequential Slicing

Run workers **in parallel** only when all are true:

- Their file ownership is disjoint.
- Their outputs do not depend on each other.
- They can be verified independently.
- Integration risk is low or isolated.

Run workers **sequentially** when any are true:

- One task depends on another worker’s output.
- They touch related APIs, shared types, shared tests, migrations, or config.
- A decision from an earlier task affects later scope.
- File ownership overlaps or is uncertain.

When uncertain, prefer sequential execution or use an explorer first.

## Disjoint File Ownership

For every worker, assign explicit ownership. Examples:

- Good: `src/auth/session.ts`, `src/auth/session.test.ts`
- Good: `docs/engineering/invariants.md`
- Risky: `src/**`
- Invalid for parallel work: two workers both owning `src/auth/**`

If two workers might need the same file, do not run them in parallel. Either split further or assign one worker and keep the other read-only/explorer.

## Explorer Contract

Use explorer subagents for read-only discovery when:

- You need file candidates before assigning ownership.
- You need architecture context across many files.
- You want a worker to avoid spending implementation time searching.

Before spawning an explorer, write a compact contract:

1. **Goal:** one concrete discovery outcome.
2. **Scope:** exact files, directories, or component boundaries to inspect.
3. **Read scope:** candidate paths and selected files; explorers never own mutation.
4. **Inputs:** relevant task context or prior findings.
5. **Constraints:** read-only tools, no edits, no broad scope expansion, no child agents.
6. **Expected output:** Files Retrieved / Key Code / Architecture / Start Here / Open Questions.
7. **Verification:** report tools used, limits reached, and whether files stayed untouched.

Explorers are leaves. Do not ask them to edit or spawn another agent. Workers may delegate discovery only to their allowlisted explorer; otherwise ask the parent.

## Staged Discovery Protocol

1. **Inventory spawn:** ask an explorer for candidate paths only. It performs no file reads and uses ≤10 `grep`/`find`/`ls` search calls.
2. **Parent selection:** the orchestrator reviews candidates, chooses files, and assigns the next narrow scope. Do not let the inventory child inspect files.
3. **Inspect spawn:** ask an explorer to inspect ≤5 selected files with ≤10 `read` calls. Return findings so far plus what would be read next when the limit is reached.
4. **Sequence narrowly:** discovery is inventory → selection → inspect. Prefer many small sequential spawns over a few broad ones; narrow reads inside owned worker scope remain allowed.

These are default budgets and may be overridden per task. Put the chosen budgets in the task string: `SubagentParams` carries only `task`, `agent`, `agentScope`, and `fileOwnership` (`agent/extensions/subagents/index.ts:58-68`); no tool-level budget enforcement exists.

`subagent_message` cannot interrupt a runaway child. It arrives as a `followUp` user message (`agent/extensions/subagents/child.ts:129`), so the child may finish its current plan first. Closing the cmux surface is the emergency stop; it produces a disconnected result rather than a final report. Verify child-process and surface cleanup afterward.

## Worker Spawn Checklist

Before each worker spawn:

- [ ] Build mode is active for coding workers.
- [ ] Contract has goal, scope, constraints, and verification.
- [ ] File ownership is explicit and non-overlapping with running workers.
- [ ] The task is small enough for one worker to complete and summarize.
- [ ] The expected structured output is clear.

## Integration Pass

After worker completion:

1. Read each worker’s structured result.
2. Inspect files touched, not the child transcript.
3. Reconcile follow-ups and open questions.
4. Run targeted verification across integrated changes.
5. Resolve conflicts or inconsistencies in the main session.
6. Run broader checks only when risk or the plan requires it.
7. Report the integrated result to the user.

The main agent is responsible for final correctness; worker success is not sufficient by itself.

## Failure Handling

If a worker fails, times out, or returns malformed output:

- Treat it as a structured failure.
- Do not assume partial changes are correct.
- Inspect touched files and decide whether to revert, repair, or retry with a narrower contract.
- Capture any durable lesson when a failed approach leads to a successful retry.
