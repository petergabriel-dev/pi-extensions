---
id: ADR-0039
title: Interactive subagent overlay and question relay
status: Active
date: 2026-10-10
decision: Keep RPC children headless; expose bounded redacted recent/live activity through the parent-only `/agents` TUI overlay; route child questions through the ask-user-question owner, gate requests while overlays are open, dismiss the viewed child's queued prompt on Esc while retaining the pending question, preserve other-child prompts, and deliver exactly-once answers with redacted `nextTurn` notes only to the main agent.
why: Reverse the 2026-10-08 no-terminal-view choice without cmux or transcript parsing, while preserving RPC ownership, bounded output, token redaction, and the single main-agent context boundary.
affects: agent/extensions/subagents/index.ts, agent/extensions/subagents/launch.ts, agent/extensions/subagents/overlay.ts, agent/extensions/subagents/package.json, agent/extensions/subagents/package-lock.json, agent/extensions/subagents/test/test_launch.ts, agent/extensions/subagents/test/test_lifecycle.ts, agent/extensions/subagents/test/test_interaction.ts, agent/extensions/subagents/test/test_overlay.ts, agent/extensions/subagents/test/test_tool_surface.ts, agent/extensions/subagents/test/smoke/fake-openai-server.mjs, agent/extensions/subagents/test/smoke/run-smoke.mjs, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/workflow-modes/manual-delegation-verification.md, agent/skills/worker-orchestration/SKILL.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, docs/engineering/decisions/ADR-0038-rpc-mode-subagent-transport.md, docs/engineering/decisions/ADR-0039-interactive-subagent-overlay-and-question-relay.md, docs/engineering/decisions/ADR-0040-single-question-ui-owner.md, docs/engineering/decisions/README.md, README.md, CHANGELOG.md
consequences: Children remain headless RPC processes; `/agents` is TUI-only and renders at most 10 times per second from a 200-item/2-KiB redacted buffer; dismissed/no-UI questions remain pending and may hold concurrency slots; no cmux or terminal-app dependency is added.
readWhen: Changing child-question routing, owner-scoped item buffering, `/agents`, live steering, or parent `nextTurn` notes
supersedes: None
---

# ADR-0039: Interactive subagent overlay and question relay

## Decision

- Keep spawned children headless in Pi RPC mode. Add `/agents` as a keyboard-only overlay owned by the interactive parent TUI; do not launch a child terminal or require cmux.
- Maintain an ordered, per-run buffer of structured RPC items. Coalesce text/thinking deltas by content index, replace them with finalized content, combine tool start/end into one summary, cap at 200 items and 2 KiB serialized per item, evict oldest first, and retain the text suffix. Pass every item through `redactSubagentText`. Expose recent items through `readItems(owner)` and live updates through `subscribeItems(owner, listener)`; release listeners on settle, failure, abort, and host close.
- Render only these safe buffered items; do not parse child transcripts or expose loadout, environment, or auth data. Throttle overlay redraws to 10/s. Re-read the live parent context for UI work; show a clear notice outside interactive TUI mode.
- Relay `ask_question` from any child depth through the single `ask-user-question` UI owner using the namespaced event contract in ADR-0040. Keep a subagents queue for the `/agents` gate; dialogs share the owner's model/child FIFO and source-scoped cancellation. The owner uses existing TUI components or RPC-safe `select`/`input`; dialog labels include the redacted owner chain. Dialog, `/agents`, and explicit `subagent_message` answers share owner-plus-question-ID validation; the first valid answer wins. Dismissing a dialog or lacking UI leaves the question pending, not cancelled.
- While any `/agents` overlay is open, keep child relays queued and do not send a question request to the UI owner. Show the viewed child's question and options in that overlay so Enter can answer it; show `<chain label> has a question; press Esc to answer it.` for another child. On Esc, close the overlay; dismiss and remove the viewed child's unanswered queued prompt, warn that its question remains pending for `/agents`, and open no dialog for it. Keep other-child prompts queued and pump them after the last overlay closes. A dismissed question remains answerable through `/agents`.
- On answer, resolve only the matching child's RPC UI request, dismiss any competing dialog, and send one redacted `subagent-question` note to the main agent with `deliverAs: "nextTurn"`. Do not send a user message or steer intermediate children.

## Why

The 2026-10-08 ADR-0038 choice to provide no live child view is reversed at the parent only: users can now watch and steer children without changing their headless RPC execution. A bounded structured buffer avoids transcript parsing and terminal dependencies. Child questions must reach the user directly rather than start a parent-model answer turn; the main-agent-only note preserves context after the answer without steering nested workers.

## Consequences

- Good: users can inspect recent/live child activity, answer pending questions, and steer running children in one parent TUI surface.
- Good: per-run ownership, token redaction, child transcript separation, and exactly-once settlement remain intact.
- Good: relay dialogs wait until `/agents` closes; Esc returns to chat without opening the viewed child's question dialog, while that question remains answerable later through `/agents`. Other-child dialogs retain FIFO delivery after close.
- Bad/risk: dismissed or unavailable dialogs leave the child waiting indefinitely and hold a concurrency slot until answer or cancellation.
- Bad/risk: `/agents` requires an interactive TUI. Child dialogs can use RPC-safe built-in UI when available; dismissed or unavailable dialogs leave children waiting and hold concurrency slots. A model-initiated question may still open over `/agents`; that interaction remains out of scope (ADR-0040).

## Affects

Docs:

- [ADR-0038-rpc-mode-subagent-transport.md](ADR-0038-rpc-mode-subagent-transport.md)
- [ADR-0040-single-question-ui-owner.md](ADR-0040-single-question-ui-owner.md)
- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [dev-workflow.md](../dev-workflow.md)
- [decisions index](README.md) (generated)
- [root README](../../../README.md)
- [CHANGELOG.md](../../../CHANGELOG.md)
- [manual-delegation-verification.md](../../../agent/extensions/workflow-modes/manual-delegation-verification.md)
- [worker-orchestration/SKILL.md](../../../agent/skills/worker-orchestration/SKILL.md)

Code:

- [index.ts](../../../agent/extensions/subagents/index.ts)
- [launch.ts](../../../agent/extensions/subagents/launch.ts)
- [overlay.ts](../../../agent/extensions/subagents/overlay.ts)
- [subagents package.json](../../../agent/extensions/subagents/package.json)
- [subagents package-lock.json](../../../agent/extensions/subagents/package-lock.json)
- [test_launch.ts](../../../agent/extensions/subagents/test/test_launch.ts)
- [test_lifecycle.ts](../../../agent/extensions/subagents/test/test_lifecycle.ts)
- [test_interaction.ts](../../../agent/extensions/subagents/test/test_interaction.ts)
- [test_overlay.ts](../../../agent/extensions/subagents/test/test_overlay.ts)
- [test_tool_surface.ts](../../../agent/extensions/subagents/test/test_tool_surface.ts)
- [smoke/fake-openai-server.mjs](../../../agent/extensions/subagents/test/smoke/fake-openai-server.mjs)
- [smoke/run-smoke.mjs](../../../agent/extensions/subagents/test/smoke/run-smoke.mjs)
- [workflow-modes/index.ts](../../../agent/extensions/workflow-modes/index.ts)
- [test_build_design_prompt.ts](../../../agent/extensions/workflow-modes/test/test_build_design_prompt.ts)

## Read when

- changing the `/agents` overlay, buffered child activity, or item redaction
- changing child-question relay, answer ownership, dismissal, or parent notes
- changing RPC child visibility or live steering

## Supersedes

- None
