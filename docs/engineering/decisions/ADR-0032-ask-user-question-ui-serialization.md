---
id: ADR-0032
title: Ask-user-question UI serialization
status: Active
date: 2026-08-27
decision: Adopt ask-user-question as the eleventh runtime extension with text, single-select, and multi-select modes; serialize model-initiated UI through a module-local FIFO queue with batch cancellation.
why: Pi can emit multiple tool calls in one batch while ctx.ui.custom supports one active UI call. A local queue prevents overlapping question UIs without leaking mutable state through globalThis; explicit Skip and Escape outcomes preserve per-question and batch semantics.
affects: package.json, scripts/check-workspace.mjs, agent/extensions/ask-user-question/index.ts, agent/extensions/ask-user-question/queue.ts, agent/extensions/ask-user-question/test/test_queue.ts, agent/extensions/subagents/spawn.ts, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/conventions.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, README.md, docs/engineering/decisions/README.md
consequences: Interactive sessions can answer bounded normalized questions by text or selection; queued calls resolve on answer, Skip, Escape cancellation, abort, or unavailable UI. The focused queue test runs from the root without nested tooling, while workers cannot ask because child loaders use noExtensions: true.
readWhen: changing ask_user_question modes, question UI ownership, queue or cancellation semantics, root test registration, or worker extension loading
supersedes: None
---

# ADR-0032: Ask-user-question UI serialization

## Decision

- Add `agent/extensions/ask-user-question/index.ts` as the eleventh package runtime entrypoint. The `ask_user_question` tool supports free-form text, single-select, and multi-select questions with bounded schemas, trimmed labels/details, filtered empty labels, and option values defaulted to labels.
- Render selection controls with visible rows and hints only. Single-select order is options, Other, Skip this question; multi-select order is options, Other, Submit, Skip this question. Escape cancels the whole queued batch; Skip resolves only the current question and lets the next queued question render. Results include `answered`, `skipped`, `cancelled`, and `unavailable` statuses.
- Keep UI serialization in `agent/extensions/ask-user-question/queue.ts` as module-local FIFO state. Recheck `batchCancelled` and `signal.aborted` after each waiter reaches the lock, drain queued waiters without invoking their render callback, and reset cancellation only after the chain reaches idle. Do not use `globalThis`.
- Keep worker sessions out of this UI path. `agent/extensions/subagents/spawn.ts` creates child sessions with `noExtensions: true`, so the parent must handle model-initiated questions.
- Run queue coverage from the root `test:ask-user-question` script. Do not add a nested manifest, lockfile, TypeScript config, or bootstrap package for this focused test.

## Why

- Pi executes tool batches concurrently, but `ctx.ui.custom` cannot safely host overlapping interactive components. FIFO serialization preserves tool-call order and prevents one question from stealing another’s input.
- A module-local queue is sufficient for this package entrypoint and avoids a process-global mutable lock shared through `globalThis`. The queue’s explicit cancellation outcomes make batch Escape and per-question Skip distinguishable to the model.
- Child sessions intentionally load no extensions. Adding question UI to workers would require a separate parent proxy contract; the current boundary keeps UI ownership in the parent.
- A root-run framework-free test provides coverage without expanding the published or bootstrapped package surface.

## Affects

Docs:

- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [conventions.md](../conventions.md)
- [dev-workflow.md](../dev-workflow.md)
- [traps.md](../traps.md)
- [README.md](../../../README.md)
- [ADR-0032-ask-user-question-ui-serialization.md](ADR-0032-ask-user-question-ui-serialization.md)
- [decisions index](README.md)

Code:

- [package.json](../../../package.json) (version, files, extension registration, root test script)
- [check-workspace.mjs](../../../scripts/check-workspace.mjs) (extension and package inventories)
- [ask-user-question/index.ts](../../../agent/extensions/ask-user-question/index.ts) (tool schema, three UIs, result statuses)
- [ask-user-question/queue.ts](../../../agent/extensions/ask-user-question/queue.ts) (FIFO and cancellation state)
- [ask-user-question/test/test_queue.ts](../../../agent/extensions/ask-user-question/test/test_queue.ts) (focused queue assertions)
- [subagents/spawn.ts](../../../agent/extensions/subagents/spawn.ts) (child `noExtensions` boundary)

## Consequences

- Good: Interactive model questions have one visible UI at a time, deterministic FIFO order, explicit text/select modes, and usable headless `unavailable` results.
- Good: Escape drains pending questions as cancelled, while Skip advances only the current question.
- Good: Queue, schema, and package-boundary behavior have focused root-run coverage without nested tooling.
- Bad/risk: Workers and other child sessions cannot call `ask_user_question`; the parent must ask or receive missing requirements before delegation.
- Bad/risk: The module-local queue coordinates only this extension. A future model-initiated UI extension must either use its own owner or adopt an explicit shared owner contract.

## Read when

- changing `ask_user_question` schema, modes, selection gestures, or result statuses
- changing question queue ordering, abort, Escape, Skip, or UI ownership
- changing root test/package registration or child extension loading

## Supersedes

- None
