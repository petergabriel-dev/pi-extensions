---
id: ADR-0026
title: Session-scoped workflow plan files and task tracking
status: Active
date: 2026-08-06
decision: Store immutable saved-plan bodies under the Pi agent directory by session and plan id; store selection and task progress in selected-session branch entries; expose all plan/task mutations through the live workflow owner.
why: Plan text needs a durable, hand-editable body and a path the model and bridge can use without putting state in a repository or leaking it across Git branches; task progress must remain branch-aware and must not mutate the plan specification.
affects: agent/extensions/workflow-modes/plan-file.ts, agent/extensions/workflow-modes/plan-state.ts, agent/extensions/workflow-modes/plan-tasks.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/caveman.ts, agent/claude-bridge/index.ts, agent/claude-bridge-client/pi-bridge-mcp.js, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0021-session-branch-workflow-plans.md, docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md, docs/engineering/decisions/README.md
consequences: Plan bodies are isolated per Pi session and can be reread for hand-edits; session ancestry still controls visibility and progress; ephemeral sessions cannot promise restart persistence; bridge clients remain read-only file-protocol clients and depend on a live Pi owner.
readWhen: changing /plan save/select/view/clear, plan-file paths or retention, task seeding/ticking, workflow markers, bridge plan access, or session ancestry semantics
supersedes: ADR-0021
---

# ADR-0026: Session-scoped workflow plan files and task tracking

## Decision

- Store each saved plan body at `<agentDir>/plans/<sessionId>/<planId>.md`. `sessionId` and `planId` are host-owned, path-safe identifiers; the file is bounded to 256 KiB and written with fsync plus atomic rename.
- Treat the plan file as the immutable specification during Build. `/plan save` writes a new body, parses top-level unchecked Section 4 tasks, and appends a `workflow-plan` pointer before activating the plan. `/plan save --last` remains the deterministic fallback when an agent-driven save tool call is missed.
- Store plan visibility and active selection as `workflow-plan` `set`, `activate`, and `clear` entries in selected Pi session ancestry. Store completed task ids as `tick` entries. Reconstruct these entries from `getBranch()` on session start and tree navigation; forks inherit only their selected ancestry.
- Make the tracker, not plan-file checkboxes, the Build task queue. `workflow_plan_tick` completes one seeded task per confirmation and is idempotent for repeated task ids. The plan body is never rewritten to record progress.
- Reread the active plan body before each agent turn. Inject its body into the workflow prompt and carry only plan id, path, savedAt, progress counts, and next task in the hidden per-turn marker. Missing or unreadable bodies degrade to no active plan with one notice.
- Route bridge `save_plan`, `read_plan_tasks`, and `tick_plan_task` through live `workflow-modes` events. MCP clients never read plan files directly and never cache plan state. UUID request replay remains idempotent.
- Run age-based GC only for unreferenced files in the current session directory; never delete a referenced plan body. A plan file may remain after `/plan clear` until retention GC.

## Why

- The prior session-branch design made entries the only plan store. It preserved ancestry correctly but could not provide a stable body path for hand-edits, model self-correction, or equivalent bridge handoff.
- Repository and Git-branch plan stores leak plans between unrelated Pi sessions. Session-keyed files keep body ownership isolated while branch entries continue to control which plans are visible and active.
- Separate immutable plan text from branch-backed task progress prevents checkbox drift: the specification remains stable while completion follows the selected branch.
- A live event-bus owner preserves Pi's source-of-truth boundary for Pi and external harnesses. Direct bridge file reads would bypass ancestry, missing-file handling, and task reconstruction.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `agent/extensions/workflow-modes/README.md`
- `docs/engineering/decisions/ADR-0021-session-branch-workflow-plans.md`
- `docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md` (plan marker payload)
- `docs/engineering/decisions/ADR-0026-session-scoped-workflow-plan-files-and-task-tracking.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/plan-file.ts`
- `agent/extensions/workflow-modes/plan-state.ts`
- `agent/extensions/workflow-modes/plan-tasks.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/caveman.ts`
- `agent/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/test-core-protocol.js`

## Consequences

- Good: A saved plan has a bounded, atomic, session-isolated body with a stable path that the model can see and that hand-edits can update on the next turn.
- Good: Plan selection, forks, rewinds, task ticks, and bridge operations all resolve through one selected-ancestry owner.
- Good: Multiple saves create separate plans rather than overwriting a prior body; `/plan clear` does not destroy user-authored plan text.
- Good: Claude Code and Cursor get the same plan/task behavior through live bridge requests without Pi imports or direct file writes.
- Bad/risk: An ephemeral session may leave a plan file that cannot be restored after exit; GC is intentionally age-based rather than destructive on clear.
- Bad/risk: A missing or unreadable body removes the active plan from the prompt and requires the visible notice/fallback path; it must not crash `before_agent_start`.
- Bad/risk: Tracker progress is session-branch state, so external clients require an active Pi bridge and cannot claim progress while Pi is unavailable.

## Read when

- changing saved-plan persistence, file paths, retention, selection, or ancestry reconstruction
- changing Section 4 task parsing, Build task queue, or `workflow_plan_tick`
- changing workflow per-turn marker details or hand-edited plan rereads
- changing bridge `save_plan`, `read_plan_tasks`, `tick_plan_task`, or MCP plan access

## Supersedes

- ADR-0021
