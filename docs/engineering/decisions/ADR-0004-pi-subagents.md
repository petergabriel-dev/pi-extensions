---
id: ADR-0004
title: Pi Subagents
status: Active
date: 2026-06-01
---

# ADR-0004: Pi Subagents

## Decision

Pi subagents v1 use persisted, in-process child `AgentSession`s rather than subprocesses.

1. **In-process spawn:** `runSubagent()` creates a child session with `createAgentSession()`, a fresh `SessionManager.create(ctx.cwd)`, disabled extension/skill/theme/context-file discovery, and a role-specific model/tool set.
2. **Persisted child sessions:** Every subagent run leaves a normal Pi session file that can be inspected after completion and can later serve as a Context Transfer branch artifact foundation.
3. **Structured-return-only parent context:** The parent receives the child final assistant message parsed into bounded structured explorer/worker fields. The child transcript does not enter parent message history.
4. **Role split:** Explorers are read-only (`read`, `grep`, `find`, `ls`). Workers are coding agents, but `spawn_worker` is parent-gated to workflow Build mode before child creation.
5. **Spawn graph bound:** The only nested graph is `main -> worker -> explorer`, with max depth 2. Workers receive nested `spawn_explorer`; workers do not receive `spawn_worker`; explorers are leaves.
6. **Concurrency model:** Subagents use a configurable default lane (default cap 3), a reserved explorer lane for nested worker-spawned explorers, and an overlap guard for parallel worker `fileOwnership`.
7. **Visibility:** Live progress uses a keyed `subagents-progress` widget, throttled to 250 ms, and clears when runs finish.

## Why

- **Lower integration overhead:** The Task 1 spike verified in-process `createAgentSession()` works from extension tool execution, persists a child session, and preserves parent branch/UI state.
- **Better parent isolation than transcript sharing:** A structured result keeps parent context small and avoids importing the child conversation wholesale.
- **Safety for coding workers:** Because child sessions disable extensions and do not inherit the parent workflow-modes `tool_call` hook, the worker Build-mode gate must live in the parent `spawn_worker` tool.
- **Deadlock avoidance:** A reserved explorer lane lets a worker delegate discovery without consuming worker/default concurrency slots that might be saturated.
- **Auditability:** Persisted child session files allow after-the-fact inspection without polluting parent context.

## Alternatives Rejected

- **Subprocess fallback:** Rejected for v1 because the in-process spike succeeded. Subprocess spawning remains a fallback pattern only if future in-process session isolation regresses.
- **Unbounded nested workers:** Rejected because worker→worker recursion complicates ownership, concurrency, and safety. v1 keeps the graph to main→worker→explorer.
- **Letting workflow-modes block child tools:** Rejected because child sessions intentionally disable extension loading for isolation; relying on inherited workflow hooks would be false security.
- **Putting child transcripts into parent context:** Rejected due to context bloat and isolation risk.

## Affects

Docs:

- [architecture.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/architecture.md)
- [invariants.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/invariants.md)
- [traps.md](file:///Users/petergabrielrlopez/.pi/docs/engineering/traps.md)

Code:

- [index.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/index.ts) (`spawn_explorer`, `spawn_worker`, nested spawn graph, commands/debug tools)
- [spawn.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/spawn.ts) (`runSubagent`, structured parsing, child session lifecycle)
- [agents.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/agents.ts) (agent definition discovery)
- [concurrency.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/concurrency.ts) (default lane, explorer lane, settings)
- [progress.ts](file:///Users/petergabrielrlopez/.pi/agent/extensions/subagents/progress.ts) (progress widget)
- [explorer.md](file:///Users/petergabrielrlopez/.pi/agent/agents/explorer.md)
- [worker.md](file:///Users/petergabrielrlopez/.pi/agent/agents/worker.md)
- [SKILL.md](file:///Users/petergabrielrlopez/.pi/agent/skills/worker-orchestration/SKILL.md)

## Consequences

- **Good:** Subagents are inspectable and composable while keeping parent history clean.
- **Good:** Worker write capability is explicitly gated by parent workflow mode.
- **Good:** Read-only explorer delegation can be used from workers without deadlocking worker slots.
- **Good:** Parallel worker conflicts are caught before overlapping file ownership proceeds.
- **Bad/risk:** In-process child sessions still share the same Pi process; future global singleton changes must preserve parent/child isolation.
- **Bad/risk:** Structured parsing is markdown-section based and must tolerate malformed outputs rather than assuming perfect model compliance.

## Read when

- modifying `agent/extensions/subagents/*`.
- changing workflow-mode tool gating or child extension loading.
- changing subagent concurrency, nested spawn graph, or file ownership semantics.
- debugging parent/child session isolation, stale widgets, or persisted child sessions.

## Supersedes

- None
