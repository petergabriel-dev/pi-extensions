---
id: ADR-0040
title: Single question UI owner
status: Active
date: 2026-10-12
decision: Route model and child questions through ask-user-question as sole UI owner and FIFO; relay child requests over bounded pi.events messages; use built-in select/input dialogs for non-TUI child questions.
why: RPC children cannot render ctx.ui.custom. A single owner preserves question serialization across extension boundaries without shared mutable imports or competing UI locks.
affects: agent/extensions/ask-user-question/index.ts, agent/extensions/ask-user-question/queue.ts, agent/extensions/ask-user-question/test/test_relay.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/test/test_tool_surface.ts, docs/engineering/decisions/ADR-0032-ask-user-question-ui-serialization.md, docs/engineering/decisions/ADR-0039-interactive-subagent-overlay-and-question-relay.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/README.md
consequences: Model and child prompts share one FIFO; RPC child questions use select/input; redacted event relays preserve parent ownership. Protocol drift remains a risk; model dialogs over /agents remain out of scope.
readWhen: Changing question UI ownership, child relay events, FIFO or source-scoped cancellation, RPC child dialogs, or the /agents gate
supersedes: None
---

# ADR-0040: Single question UI owner

## Decision

- `ask-user-question` owns question UI for both parent-model and child-originated questions. Cross-extension coordination uses `pi.events` only; extensions do not import each other's mutable queue state.
- The child relay contract is namespaced: `ask-user-question:request { requestId, title, options? }`, synchronous `ask-user-question:ack { requestId, accepted, reason? }`, `ask-user-question:result { requestId, status, answer? }`, and `ask-user-question:cancel { requestId }`.
- Validate requests before rendering: `requestId` is non-empty and at most 200 characters, unique while pending; title is non-empty and at most 4,000 characters; options are optional and contain at most 50 non-empty strings of at most 500 characters. Reject malformed and duplicate requests with an ack. Result status is closed to `answered`, `dismissed`, `cancelled`, or `unavailable`; include `answer` only when answered.
- Acknowledge accepted requests synchronously inside `emit`. Enqueue model and child questions in the same module-local FIFO. The owner captures the session context at `session_start`; absent UI returns `unavailable`, and shutdown cancels pending child requests.
- If no owner acknowledges a child request, `subagents` warns that question UI is unavailable and keeps the question answerable through `/agents`.
- In TUI mode, child questions use the existing custom single-select/text components; option questions include Other and omit Skip. In non-TUI modes, including RPC, use `ctx.ui.select(title, [...options, "Other…"], { signal })`; selecting Other opens `ctx.ui.input`, while free-text questions use `ctx.ui.input` directly. These built-in dialogs run inside the same FIFO; non-TUI child questions never use `ctx.ui.custom`.
- Cancellation is source-scoped. Model Escape/abort cancels queued model waiters without cancelling child requests. Child Escape dismisses only that child question and does not cancel the model batch. An explicit cancel removes a queued child request or aborts its open dialog.
- `subagents` retains its `/agents` overlay gate: child questions stay queued while any `/agents` overlay is open. Answers from `/agents`, child settlement, and shutdown cancel any open owner request. The subagent host redacts chain-labeled titles/options before UI display and the answer before its parent `nextTurn` note; the raw answer goes only to the addressed child.
- A model question opening over `/agents` remains out of scope.

## Why

RPC child processes are headless and cannot render the parent's `ctx.ui.custom` components. The RPC-compatible `ctx.ui.select`/`ctx.ui.input` path fixes that boundary while preserving one FIFO owner. A separate FIFO lock lease would add cross-extension lock lifecycle and release paths; direct imports would couple extensions and fail to provide one shared owner across module instances. `pi.events` keeps the contract explicit and the queue private.

## Affects

Docs:

- [ADR-0032-ask-user-question-ui-serialization.md](ADR-0032-ask-user-question-ui-serialization.md)
- [ADR-0039-interactive-subagent-overlay-and-question-relay.md](ADR-0039-interactive-subagent-overlay-and-question-relay.md)
- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [decisions index](README.md) (generated)

Code:

- [ask-user-question/index.ts](../../../agent/extensions/ask-user-question/index.ts)
- [ask-user-question/queue.ts](../../../agent/extensions/ask-user-question/queue.ts)
- [ask-user-question/test/test_relay.ts](../../../agent/extensions/ask-user-question/test/test_relay.ts)
- [subagents/index.ts](../../../agent/extensions/subagents/index.ts)
- [subagents/test/test_tool_surface.ts](../../../agent/extensions/subagents/test/test_tool_surface.ts)

## Consequences

- Good: model and child prompts serialize through one owner; RPC child dialogs use supported built-in UI; cross-extension state stays private.
- Good: request bounds, closed result statuses, scoped cancellation, and redaction make the relay contract explicit.
- Bad/risk: protocol drift between extensions can leave a child question unavailable; the pending question remains answerable through `/agents`.
- Bad/risk: a model question can still open over `/agents`; resolving that ownership case is deferred.

## Read when

- changing ask-user-question UI ownership, child relay protocol, FIFO ordering, or cancellation
- changing child-question rendering in RPC/non-TUI modes
- changing the `/agents` question gate or answer relay

## Supersedes

- None
