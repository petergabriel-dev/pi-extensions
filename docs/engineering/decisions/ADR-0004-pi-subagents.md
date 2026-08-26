---
id: ADR-0004
title: Pi Subagents
status: Active
date: 2026-06-01
decision: Use persisted, in-process child AgentSessions with bundled explorer/worker defaults and user/project definition precedence.
why: In-process sessions preserve parent isolation and auditability; bundled module-relative defaults make clean installs work while scoped overrides remain explicit and validated.
affects: agent/extensions/subagents, agent/extensions/browser/index.ts, agent/extensions/workflow-modes/index.ts, agent/agents/explorer.md, agent/agents/worker.md, agent/skills/worker-orchestration/SKILL.md, docs/engineering/decisions/ADR-0031-subagent-browser-access.md, package.json, scripts/check-package.mjs
consequences: Clean installs work without external agent copies; malformed overrides fall back to the next definition, while a selected valid-but-unsafe override is rejected by validation rather than silently replaced.
readWhen: changing subagent sessions, role definitions, agent-definition discovery or precedence, nested spawning, concurrency, workflow gating, browser proxies, or parent/child isolation
---

# ADR-0004: Pi Subagents

## Decision

Pi subagents v1 use persisted, in-process child `AgentSession`s rather than subprocesses.

1. **In-process spawn:** `runSubagent()` creates a child session with `createAgentSession()`, a fresh `SessionManager.create(ctx.cwd)`, disabled extension/skill/theme/context-file discovery, and a role-specific model/tool set.
2. **Persisted child sessions:** Every subagent run leaves a normal Pi session file that can be inspected after completion and can later serve as a Context Transfer branch artifact foundation.
3. **Structured-return-only parent context:** The parent receives the child final assistant message parsed into bounded structured explorer/worker fields. The child transcript does not enter parent message history.
4. **Role split:** Explorers are read-only with respect to the repository by construction (`read`, `grep`, `find`, `ls`, plus the validated browser verification proxy set). Browser proxies may affect external web state but grant no repository mutation tools. Workers are coding agents, but `spawn_worker` is parent-gated to workflow Build mode before child creation.
5. **Definition precedence:** Package-owned explorer/worker Markdown files are bundled defaults and are resolved relative to the package module, not the active Pi home. Selected user definitions override bundled defaults; selected nearest project definitions override user definitions. A malformed override falls back to the next lower-precedence definition, while a valid but unsafe selected explorer override remains selected and is rejected by read-only validation.
6. **Spawn graph bound:** The only nested graph is `main -> worker -> explorer`, with max depth 2. Workers receive nested `spawn_explorer`; workers do not receive `spawn_worker`; explorers are leaves.
7. **Concurrency model:** Subagents use a configurable default lane (default cap 3), a reserved explorer lane for nested worker-spawned explorers, and an overlap guard for parallel worker `fileOwnership`.
8. **Visibility:** Live progress uses a keyed `subagents-progress` widget, throttled to 250 ms, and clears when runs finish.

## Why

- **Lower integration overhead:** The Task 1 spike verified in-process `createAgentSession()` works from extension tool execution, persists a child session, and preserves parent branch/UI state.
- **Better parent isolation than transcript sharing:** A structured result keeps parent context small and avoids importing the child conversation wholesale.
- **Safety for coding workers:** Because child sessions disable extensions and do not inherit the parent workflow-modes `tool_call` hook, the worker Build-mode gate must live in the parent `spawn_worker` tool. Browser proxies follow the same parent-owned boundary; explorer browser capability is selected from parent mode at spawn time.
- **Deadlock avoidance:** A reserved explorer lane lets a worker delegate discovery without consuming worker/default concurrency slots that might be saturated.
- **Auditability:** Persisted child session files allow after-the-fact inspection without polluting parent context.

## Alternatives Rejected

- **Subprocess fallback:** Rejected for v1 because the in-process spike succeeded. Subprocess spawning remains a fallback pattern only if future in-process session isolation regresses.
- **Unbounded nested workers:** Rejected because worker→worker recursion complicates ownership, concurrency, and safety. v1 keeps the graph to main→worker→explorer.
- **Letting workflow-modes block child tools:** Rejected because child sessions intentionally disable extension loading for isolation; relying on inherited workflow hooks would be false security.
- **Putting child transcripts into parent context:** Rejected due to context bloat and isolation risk.
- **Requiring external user/project role definitions:** Rejected because clean installs would be incomplete and coupled to machine-specific filesystem state.

## Affects

Docs:

- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)

Code:

- [index.ts](../../../agent/extensions/subagents/index.ts) (`spawn_explorer`, `spawn_worker`, nested spawn graph, commands/debug tools)
- [browser/index.ts](../../../agent/extensions/browser/index.ts) (owner-scoped browser page and proxy channel)
- [workflow-modes/index.ts](../../../agent/extensions/workflow-modes/index.ts) (mode-scoped browser mutation gating)
- [spawn.ts](../../../agent/extensions/subagents/spawn.ts) (`runSubagent`, structured parsing, child session lifecycle)
- [agents.ts](../../../agent/extensions/subagents/agents.ts) (agent definition discovery)
- [concurrency.ts](../../../agent/extensions/subagents/concurrency.ts) (default lane, explorer lane, settings)
- [progress.ts](../../../agent/extensions/subagents/progress.ts) (progress widget)
- [explorer.md](../../../agent/agents/explorer.md)
- [worker.md](../../../agent/agents/worker.md)
- [SKILL.md](../../../agent/skills/worker-orchestration/SKILL.md)
- [ADR-0031-subagent-browser-access.md](ADR-0031-subagent-browser-access.md)
- [package.json](../../../package.json) (published agent asset allowlist)
- [check-package.mjs](../../../scripts/check-package.mjs) (artifact inventory)

## Consequences

- **Good:** Subagents are inspectable and composable while keeping parent history clean.
- **Good:** Worker write capability is explicitly gated by parent workflow mode.
- **Good:** Repository-read-only explorer delegation can be used from workers without deadlocking worker slots; Build-mode browser proxies add live verification without repository mutation tools.
- **Good:** Parallel worker conflicts are caught before overlapping file ownership proceeds.
- **Good:** Module-relative bundled assets survive relocation and clean npm installs do not require external user or project copies.
- **Bad/risk:** In-process child sessions still share the same Pi process; future global singleton changes must preserve parent/child isolation.
- **Bad/risk:** Structured parsing is markdown-section based and must tolerate malformed outputs rather than assuming perfect model compliance.
- **Bad/risk:** A valid unsafe explorer override can be selected before validation rejects it; silently falling back would hide the safety failure.

## Read when

- modifying `agent/extensions/subagents/*`.
- changing workflow-mode tool gating or child extension loading.
- changing subagent concurrency, nested spawn graph, or file ownership semantics.
- changing bundled agent package assets, discovery scope, or precedence.
- debugging parent/child session isolation, stale widgets, or persisted child sessions.

## Supersedes

- None
