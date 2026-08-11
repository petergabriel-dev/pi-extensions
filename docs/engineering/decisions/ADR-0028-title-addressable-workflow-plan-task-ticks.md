---
id: ADR-0028
title: Title-addressable workflow plan task ticks
status: Active
date: 2026-08-11
decision: Resolve workflow plan ticks by exact task id or normalized title through one shared live workflow owner; carry model-required tracker state in marker content and keep structured metadata host-side.
why: Agents can retain task titles after compaction but may lose derived tracker ids; custom-message details are dropped during LLM conversion, while changing the system prompt on every tick would reduce prefix-cache reuse.
affects: agent/extensions/workflow-modes/plan-tasks.ts, agent/extensions/workflow-modes/plan-state.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/caveman.ts, agent/claude-bridge/index.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-core-protocol.js, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md, docs/engineering/decisions/ADR-0026-session-scoped-workflow-plan-files-and-task-tracking.md, docs/engineering/decisions/README.md
consequences: Agents can tick by verbatim title without an extra id lookup; exact matching rejects unknown or ambiguous titles; task-id callers remain compatible; marker content survives LLM conversion without changing the system-prompt cache prefix; bridge and Pi tick contracts stay aligned through live-owner routing.
readWhen: changing workflow_plan_tick, task reference resolution, tracker recovery, workflow markers, CustomMessage conversion, prompt-cache behavior, or bridge plan tools
supersedes: None
---

# ADR-0028: Title-addressable workflow plan task ticks

## Decision

- `workflow_plan_tick` requires exactly one bounded `taskId` or `title`. The shared pure resolver normalizes runs of whitespace to one space, then performs exact matching only; unknown references reject, duplicate title matches require `taskId`, and no fuzzy or substring matching is allowed.
- Re-ticking a completed task remains idempotent. Out-of-order ticks are accepted but explicitly flagged. The durable branch tick entry is appended before live tracker state changes, and the saved plan body remains immutable.
- The per-turn marker puts plan id, progress, and next-task id/title in `CustomMessage.content`. Its `details` field retains structured host metadata such as path and savedAt, but Pi's `convertToLlm` drops that field (`@earendil-works/pi-coding-agent/dist/core/messages.js:89-96`).
- Tracker progress stays at the end of message history. `composeWorkflowPrompt` remains byte-identical as progress changes, preserving the system-prompt prefix cache.
- `workflow_plan_tasks` is the read-only recovery path. Pi and bridge/MCP `tick_plan_task` use the same title-or-id payload and route through the live workflow owner; UUID request replay remains idempotent.

## Why

- Derived task ids are durable tracker data, not reliable model context. Exact title addressing lets an agent recover from compaction when the marker still supplies the next title, without a mandatory task-list lookup or extra happy-path provider round trip.
- Pi drops `CustomMessage.details` during LLM conversion, so structured marker metadata cannot be the only model-facing channel. Putting only the compact tracker line in `content` preserves model visibility without duplicating the full task list.
- Progress must not be interpolated into the system prompt. Keeping the prompt stable protects the Anthropic prefix cache while the mutable tracker marker remains in message history.
- One resolver and one live workflow owner prevent Pi and bridge contracts from drifting or bypassing selected-session ancestry.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0025-workflow-mode-announcement-channel.md`
- `docs/engineering/decisions/ADR-0026-session-scoped-workflow-plan-files-and-task-tracking.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/plan-tasks.ts`
- `agent/extensions/workflow-modes/plan-state.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/caveman.ts`
- `agent/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/test-core-protocol.js`

## Consequences

- Good: Agents can tick by exact title or id; existing task-id clients remain compatible.
- Good: Unknown and ambiguous references fail safely with recovery guidance; duplicate ticks do not append branch state.
- Good: Model-visible tracker state survives details conversion, while system-prompt bytes stay stable across progress changes.
- Good: Read-only recovery and bridge parity preserve live-owner and UUID-idempotency invariants.
- Bad/risk: Paraphrased titles still reject; duplicate titles require the derived id; out-of-order acceptance can expose skipped earlier work and is explicitly reported.

## Read when

- changing saved-plan task parsing, resolution, ticking, or recovery
- changing marker content/details or compaction behavior
- changing workflow prompt caching or bridge/MCP plan tools

## Amends

- ADR-0025: the marker's model-facing tracker fields live in `content`; `details` remains structured host metadata and is not delivered to the LLM.

## Supersedes

- None
