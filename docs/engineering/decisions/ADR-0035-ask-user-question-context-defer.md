---
id: ADR-0035
title: Ask-user-question defer-to-next-turn compaction
status: Active
date: 2026-08-29
decision: After an answered ask_user_question result in TUI mode, inspect known context usage once; when it exceeds contextWindow - 16,384, retain one bounded answer batch, wait for the question queue to drain, append one TUI-only marker, abort once, and on agent_settled send one fresh user message without deliverAs so Pi can run its normal pre-prompt compaction.
why: Pi checks compaction after an agent loop and before a non-streaming prompt, while prompt() returns early for streaming input, so an answered question can cross the threshold mid-run. Direct ctx.compact() was rejected because AgentSession.compact() opens with await this.abort(), which would abort from inside tool execution before matching tool results settle. The threshold mirrors Pi's default 16,384-token compaction reserve. This is deliberately a narrow ask_user_question mid-run guard, not a general mid-run compaction guard, because the extension owns this tool's answer boundary, queue, and deferred batch lifecycle.
affects: agent/extensions/ask-user-question/index.ts:660-679, :726-739, agent/extensions/ask-user-question/defer.ts:1-54, agent/extensions/ask-user-question/queue.ts:1-40, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0032-ask-user-question-ui-serialization.md, docs/engineering/decisions/README.md, @earendil-works/pi-coding-agent/dist/core/agent-session.js:779, :834-846, :864-868, :1400-1402, @earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:74-76
consequences: TUI answers that cross the threshold resume after Pi compaction through one fresh turn while preserving matching tool results; each agent run permits one bounded defer batch, marker, and abort. The flow does not cover headless mode, unknown usage, or arbitrary mid-run token growth, and it depends on the referenced Pi host lifecycle and reserve behavior.
readWhen: changing ask_user_question context defer, answer batching, queue drain or abort behavior, resume delivery, or Pi host compaction assumptions
supersedes: None
---

# ADR-0035: Ask-user-question defer-to-next-turn compaction

## Decision

- In TUI mode, inspect `ctx.getContextUsage()` after each answered `ask_user_question` result. If known usage is above `contextWindow - 16,384`, record the bounded question/answer in the current run's pending batch.
- Keep one defer state per agent run. After `tool_execution_end` observes the ask-user-question queue is empty, append the TUI-only `ask-user-question:context-defer` entry and abort once. Deferred tool calls retain their matching `tool_result`; mixed tool runs do not get a second marker or abort.
- At `agent_settled`, take the pending answers and call `sendUserMessage(buildResumeMessage(...))` as a fresh user turn without `deliverAs`. This lets Pi's normal non-streaming prompt preflight perform compaction before the resume.

## Why

- Pi's existing `shouldCompact` call sites run after an agent loop (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:779`) and before a non-streaming prompt (`:864-868`). `prompt()` returns early while streaming (`:834-846`), so a tool-result boundary is needed to notice an answered question that crosses the threshold.
- Direct `ctx.compact()` was rejected because `AgentSession.compact()` begins with `await this.abort()` (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:1400-1402`). Calling it from tool execution would abort before the tool lifecycle has settled; queue-drain abort followed by `agent_settled` preserves the matching results.
- The 16,384-token threshold mirrors Pi's default compaction reserve (`@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:74-76`) instead of introducing a second reserve policy.
- The guard stays narrow to `ask_user_question` mid-run handling. This extension can identify a completed TUI answer and coordinate its queue, marker, abort, and resume; it does not intercept arbitrary tools or attempt to replace Pi's general compaction policy.

## Affects

Docs:

- [architecture.md](../architecture.md) (`ask_user_question` context defer flow)
- [invariants.md](../invariants.md) (TUI-only answer-driven defer invariant)
- [traps.md](../traps.md) (Pi compaction and streaming lifecycle)
- [ADR-0032-ask-user-question-ui-serialization.md](ADR-0032-ask-user-question-ui-serialization.md) (question UI ownership and queue)
- [decisions index](README.md)

Code:

- [index.ts](../../../agent/extensions/ask-user-question/index.ts) (`:660-679`, `:726-739`)
- [defer.ts](../../../agent/extensions/ask-user-question/defer.ts) (`:1-54`)
- [queue.ts](../../../agent/extensions/ask-user-question/queue.ts) (`:1-40`)

Pi host evidence:

- `@earendil-works/pi-coding-agent/dist/core/agent-session.js:779` (`shouldCompact` after the agent loop)
- `@earendil-works/pi-coding-agent/dist/core/agent-session.js:834-846` (streaming `prompt()` early return)
- `@earendil-works/pi-coding-agent/dist/core/agent-session.js:864-868` (non-streaming pre-prompt compaction check)
- `@earendil-works/pi-coding-agent/dist/core/agent-session.js:1400-1402` (`AgentSession.compact()` begins with `await this.abort()`)
- `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:74-76` (default 16,384-token reserve)

## Consequences

- Good: A TUI answer that crosses the threshold reaches a fresh turn after normal Pi compaction rather than relying on a streaming follow-up path.
- Good: Queue draining, one abort, one marker, and answer batching preserve tool-result pairing during mixed tool runs.
- Bad/risk: The behavior is intentionally limited to TUI answers with known usage and is coupled to the referenced Pi host lifecycle and reserve implementation.
- Bad/risk: Resuming requires one additional user turn after the settled run.

## Read when

- changing `ask_user_question` context threshold or deferred answer batching
- changing queue drain, abort, marker, or `agent_settled` resume behavior
- changing Pi host compaction call sites, streaming prompt handling, or compaction reserve assumptions

## Supersedes

- None
