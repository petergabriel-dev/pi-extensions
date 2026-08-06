---
id: ADR-0025
title: Workflow mode announcement channel
status: Active
date: 2026-07-30
decision: Announce active workflow modes through a hidden per-turn custom message plus an authoritative system-prompt header; announce Off once after its durable mode entry; keep tool block results historical and mode-stamped.
why: Put enforced workflow state at the tail of model input on every active-mode turn so stale assistant or tool-result claims self-heal without extra provider calls; system-prompt-only and one-shot-active announcements did not reliably correct model belief.
affects: agent/extensions/workflow-modes/caveman.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_caveman.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/workflow-modes/README.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md, docs/engineering/decisions/ADR-0026-session-scoped-workflow-plan-files-and-task-tracking.md (plan marker payload), docs/engineering/decisions/README.md
consequences: Active modes persist one hidden custom message per user turn; Off uses one transition message; custom-message role mapping requires a harness prefix; enforcement outcomes and provider round trips remain unchanged.
readWhen: changing workflow-mode prompt composition, mode transitions, before_agent_start messages, tool block reasons, compaction behavior, or provider continuation/cache behavior
---

# ADR-0025: Workflow mode announcement channel

## Decision

- For Discuss, Plan, Build, Review, and Design, `before_agent_start` returns the composed system prompt and one hidden `workflow-mode-current` custom message naming the active mode on every user turn.
- When an active saved plan exists, that same hidden message carries compact plan marker details: plan id, file path, savedAt, tracker progress, and next task; it never carries the full task list.
- Prefix custom-message content with `[workflow-modes]` because Pi converts custom messages to LLM role `user`; the marker identifies harness-authored state.
- Open every active-mode system prompt with an authoritative header that supersedes earlier mode claims, forbids redundant switch requests, and requires one real tool attempt before refusing on a believed block.
- For Off, which has no workflow prompt, append the durable `workflow-mode-set` entry before sending one `workflow-mode-transition` message. A send failure restores prior in-memory and durable mode state and surfaces the error.
- Keep tool block reasons historical: state mode at tool-call time and point to the latest authoritative marker. Preserve native sandboxed Bash output and exit status without appending mode guidance.

## Why

- Tool enforcement and stale tool results appear in message context. Regenerating a compact marker at the input tail corrects stale beliefs after ordinary turns, compaction, branch navigation, and session resume without another provider round trip.
- **Rejected: system prompt only.** Pi already recomposed workflow instructions each turn, yet recorded sessions still showed the model asserting an earlier mode. Another system-prompt sentence would not add authority at the tail of model input.
- **Rejected: one switch-time message for active modes.** Pi compaction treats custom messages as valid cut points, and branch navigation can reconstruct a different mode without replaying a transition. A one-shot active announcement can therefore disappear or become stale; per-turn regeneration self-heals. Off remains one-shot because it intentionally has no per-turn workflow prompt.
- Keeping the per-turn marker in input preserves Codex continuation matching because input differences do not alter workflow instructions or add provider calls.

## Affects

Docs:

- `agent/extensions/workflow-modes/README.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/caveman.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/test/test_caveman.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`

## Consequences

- Good: Active-mode belief self-heals on every user turn; Off transitions remain visible to the model.
- Good: The marker is hidden from the TUI, O(1) to compose, keeps mode content compact while carrying only plan identity/progress details, and adds no provider round trip.
- Good: Mutation gates, Design surface checks, Review policy, and sandbox fallback keep the same allow/deny outcomes.
- Good: Historical block results no longer claim a current mode or tell the user to switch.
- Bad/risk: One hidden custom message is persisted per active-mode user turn, increasing session history slightly.
- Bad/risk: Custom messages map to LLM role `user`; missing the harness prefix could make extension text look user-authored.
- Bad/risk: Prompt authority is behavioral. A model can still ignore it, so the real tool-attempt rule remains necessary evidence gathering.

## Read when

- changing workflow prompt composition or mode labels
- changing `/mode`, `before_agent_start`, custom-message delivery, or block reasons
- changing compaction cut points, session reconstruction, or provider continuation/cache matching

## Supersedes

- None
