# Architecture

## Workspace and package boundary

This repository publishes as `@lopezpetergabriel/pi-extensions@0.2.4`, one Pi package containing nine extensions, three skills, and two package-owned bundled agent definitions. It is source, not a separate Pi home.

- The npm allowlist ships runtime TS/helpers, workflow plan template, agent/skill Markdown, `docs/engineering/**`, README/LICENSE, and npm-mandatory nested READMEs under engineering-docs/filechanges. It excludes tests, nested manifests/locks/tsconfigs, bridge clients, Cursor config, `.pi`, `node_modules`, and runtime/user state; package gates enforce <=512 KiB packed and <=1 MiB unpacked.
- `bin/pi-workspace` resolves the repository root from its own location, then runs `pi --no-extensions -e <root>` for source development. The source checkout’s `.pi/agents` link is a dev/project mechanism, not npm agent registration.
- Bundled agent definitions load relative to the package module. Scope overrides are: default user = bundled then user; project = bundled then nearest project; both = bundled then user then project. Later definitions override by name, but a selected valid unsafe explorer override is rejected by the caller’s read-only validator.
- The package reuses host Pi auth, settings, model catalogs, personal memory, and session storage. Those remain outside this repository under Pi-owned user-global paths. Dependency installs, CCC indexes, bridge IPC, logs, DBs, credentials, sessions, plans, and personal memory are runtime/generated state and ignored.
- Active global extension source under `~/.pi` is independent. Workspace scripts and source must not import or mutate that source tree.

`agent/extensions/workflow-modes/index.ts` resolves `plan-template.md` relative to `import.meta.url`; package behavior does not depend on checkout location or a user-specific absolute path.

## Packaged component inventory

### Extensions

| # | Entrypoint | Surface | Owned state / role |
|---|---|---|---|
| 1 | `agent/extensions/ccc-search/index.ts` | `ccc_search` tool | Validates bounded semantic-search input and invokes fixed `ccc search` argv without a shell. |
| 2 | `agent/extensions/claude-bridge/index.ts` | `/claude-bridge` command | Owns live project bridge watcher, lock, heartbeat, request processing, response cache, and event-bus adapters. |
| 3 | `agent/extensions/discussion-notes.ts` | `discussion_notes` tool, `/notes` command, Notes UI | Owns typed notes for selected Pi session branch and reconstructs them from branch entries. |
| 4 | `agent/extensions/engineering-docs/index.ts` | `docs_validate_tags` tool, `/docs` command | Owns managed engineering-doc operations, tag validation, generated spokes/indexes, and branch-local reminder tracking. |
| 5 | `agent/extensions/filechanges/index.ts` | `/filechanges`, `/filechanges-accept`, `/filechanges-decline` | Tracks successful Pi `edit`/`write` mutations against branch-local first-write baselines and can keep or revert them. |
| 6 | `agent/extensions/notify.ts` | `agent_end` lifecycle hook | Emits terminal-native “Ready for input” notification; no persistent state. |
| 7 | `agent/extensions/personal-memory/index.ts` | `remember`, `recall_memory_entry`, `/remember` | Owns user-global indexed personal-memory reads, writes, and one-time legacy migration. |
| 8 | `agent/extensions/subagents/index.ts` | `spawn_explorer`, `spawn_worker`, model command, debug tools | Discovers role definitions, enforces spawn policy/concurrency/ownership, and runs isolated persisted child sessions. |
| 9 | `agent/extensions/workflow-modes/index.ts` | `/mode`, `/plan`, `/caveman`; prompt/tool hooks | Owns branch-local workflow mode, session-scoped saved-plan pointers/task progress, Caveman preference, prompt composition, and read-only mode gates. |

### Agent definitions

| Definition | Contract | Discovery |
|---|---|---|
| `agent/agents/explorer.md` | Read-only discovery using `read`, `grep`, `find`, and `ls`; returns compressed files/code/architecture/open-question output. | Bundled module-relative definition; user/project overrides follow explicit scope. |
| `agent/agents/worker.md` | Build-mode scoped implementation using coding tools; returns summary, touched files, commands, follow-ups, and questions. | Bundled module-relative definition; user/project overrides follow explicit scope. |

Subagent discovery is module-relative for bundled definitions. Scope defaults to bundled+user; project is bundled+nearest project; both is bundled, then user, then project, with later same-name definitions winning. A selected valid-but-unsafe explorer override remains selected for validation and is rejected rather than silently replaced.

### Skills

| Skill | Purpose |
|---|---|
| `agent/skills/grill` | One-question-at-a-time plan interrogation with a recommended answer. |
| `agent/skills/grill-with-docs` | Domain-aware interrogation that inspects code/docs, captures discussion notes, updates context docs, and offers ADRs only for durable trade-offs. |
| `agent/skills/worker-orchestration` | Contract-first A+B orchestration, disjoint file ownership, sequential/parallel rules, and parent-owned integration. |

### Harness clients and project integration

- `agent/claude-bridge-client/pi-bridge-mcp.js` is the shared Node-stdlib MCP/file-protocol client for Claude Code and Cursor.
- `agent/claude-bridge-client/pi-readonly-hook.js` is Claude Code’s fail-closed PreToolUse guard.
- `agent/cursor-bridge-client/cursor-readonly-hook.js` classifies Cursor shell/MCP activity and restores native edit preimages.
- `.cursor/mcp.json` registers the shared bridge MCP client.
- `.cursor/hooks.json` registers Cursor shell, MCP, and post-edit guards.
- `.cursor/commands/discuss.md` and `.cursor/commands/plan.md` define bridge-backed read-only workflows and mandatory capture/save checkpoints.

## Runtime-state ownership

| State | Location | Owner | Repository status |
|---|---|---|---|
| Package source, docs, agent definitions, skills | Repository tracked files | Git / contributors | Versioned |
| Workflow mode, saved-plan pointers/selection/task progress, Caveman preference | Selected Pi session branch entries; plan body at `<agentDir>/plans/<sessionId>/<planId>.md` | `workflow-modes` | Host session storage; body is atomic, session-scoped, and never repository/Git-branch/bridge-scoped |
| Discussion notes | Selected Pi session branch tool-result/custom entries | `discussion-notes` | Host session storage |
| File-change baselines and clear/untrack events | Selected Pi session branch custom entries | `filechanges` | Host session storage |
| Docs changed-file/touched/snooze markers | Selected Pi session branch custom entries | `engineering-docs` | Host session storage |
| Parent and child session files | Pi user-global agent session storage | Pi host / `SessionManager` | Excluded |
| Auth, settings, model catalogs | Pi user-global agent directory | Pi host | Reused, never copied into Git |
| Personal memory entries and generated index | `~/.pi/memory/*.md`, `~/.pi/memory/MEMORY.md` | `personal-memory/store.ts` | User-global, excluded |
| Bridge requests, responses, processed cache, policy, heartbeat | `<project>/.pi/memory/bridge/` | `claude-bridge` | Ephemeral, ignored |
| Dependency trees and semantic index | package `node_modules/`, `.cocoindex_code/` | npm / CCC | Generated, ignored |

Project truth belongs in `docs/engineering/` and ADRs. Discussion notes are session handoff state, not project truth or personal memory. Personal memory is cross-repository user state, not project documentation.

## Extension interaction map

```text
workflow-modes ──state/events──> engineering-docs write gating
       │
       ├──state/build gate──────> subagents spawn_worker
       │
       └──state/save-plan───────> claude-bridge <──file IPC── bridge clients
                                      │
                                      ├──add event────> discussion-notes
                                      ├──pure validator> engineering-docs filesystem helpers
                                      └──store calls───> personal-memory store

edit/write lifecycle ───────────> filechanges + engineering-docs tracking
agent_end ──────────────────────> notify + engineering-docs reminder
```

Live mutable extension state has one owner. Cross-extension mutation uses namespaced `pi.events` request/result pairs. Direct imports from the bridge are limited to pure prompt composition, docs validation, and personal-memory store functions; the bridge does not import mutable discussion-note or workflow session state.

## Pi ↔ multi-harness bridge

Claude Code and Cursor are read-only planning surfaces for existing Pi projects. Pi remains source of truth for engineering docs validation, discussion notes, personal memory, workflow prompts, saved-plan handoff, and build execution.

Flow:

1. Pi loads `agent/extensions/claude-bridge/index.ts` in an active session.
2. Bridge resolves project root from nearest `.pi/` marker.
3. Bridge creates `<project>/.pi/memory/bridge/{requests,responses,processed}` plus `session.json` and `policy.json`.
4. MCP client writes UUID request JSON and polls matching response for up to two seconds.
5. Bridge handles `recall`, `recall_entry`, `save_memory`, `capture`, `validate_tags`, `save_plan`, `read_plan_tasks`, and `tick_plan_task` using Pi-side owners/helpers.
6. Recall returns canonical engineering docs, compact personal-memory index, composed workflow prompts, plan template, and live saved-plan state; task reads/ticks use the live workflow owner rather than a bridge cache.
7. Bridge shutdown removes its owned request/response/cache/lock/policy files; ignored directories may remain.

Bridge request protocol:

- `requests/<uuid>.json`: `{ id, type, payload, ts }`
- `responses/<uuid>.json`: `{ id, ok, result | error }`
- `processed/<uuid>.json`: idempotency cache
- `policy.json`: short-lived policy snapshot for clients/compatibility
- `session.json`: active bridge lock and heartbeat

Only one fresh bridge session processes a project. Another watcher becomes passive. Processed responses make UUID replay idempotent.

`capture` accepts primary `sessionId` plus deprecated `claudeSessionId`; primary wins. Capture emits `discussion-notes:add`, then waits for owner response. `save_plan` emits `workflow-modes:save-plan`, then waits for live owner response. Recall obtains saved plans only through `workflow-modes:get`; unavailable live state is an error.

### Read-only harness enforcement

- Claude hook applies to any cwd below a `.pi` marker. Mutation tools and `dangerouslyDisableSandbox` are denied.
- On macOS, Claude Bash is rewritten through `/usr/bin/sandbox-exec` with network and non-scratch writes denied. If unavailable, Bash denies closed.
- Cursor shell commands are allow/deny/ask classified; mutating non-bridge MCP calls deny; unknown calls ask.
- Cursor native edits are restored from exact pre-edit bytes and return a visible denial.
- Client code has zero Pi internal imports. All Pi-state writes travel through live bridge requests.

## Workflow modes

`workflow-modes` reconstructs branch-local contracts from selected session ancestry:

- `workflow-mode-set` selects Off, Discuss, Plan, Build, Review, or Design.
- `workflow-plan` stores plan pointer set/activate/clear events plus task ticks. The immutable plan body lives at `<agentDir>/plans/<sessionId>/<planId>.md`; only its session-scoped pointer and progress state live in branch entries.
- `caveman-mode-state` stores Caveman preference; no explicit entry means enabled.

`/plan save` writes the bounded plan body atomically, seeds Section 4 tasks, then appends the durable pointer before activating it. `/plan select`, `/plan view`, and `/plan clear` operate on plans visible in selected ancestry; clear deactivates the pointer but does not delete its file. `workflow_plan_tick` records one completed task per confirmation, so the tracker—not immutable Section 4 checkboxes—is the Build queue. Before each turn, workflow-modes rereads the active body and injects a compact marker with plan identity, path, savedAt, progress, and next task.

Off injects no workflow/style prompt. Discuss, Plan, Build, Review, and Design compose mode prompt plus the active saved-plan body when present (`workflow-modes/caveman.ts`), then Caveman or normal-style override. Design scopes design-system work to `docs/design/` plus manifest-declared token CSS; component source remains Build work. Plan-template resolution is module-relative.

Discuss, Plan, and Review block mutation tools. Design allows `write`/`edit` only inside `docs/design/**` or manifest-declared token files, failing closed to `docs/design/**` when manifest is missing or invalid. Design Bash reuses Plan's sandboxed read/test policy. Discuss/Plan Bash prefers structural sandboxing with network denied; Review admits only scoped read/approved `gh` commands, keeps filesystem writes denied, and permits network. If sandbox wrapping is unavailable or fails, conservative regex policy applies.

The extension publishes `workflow-modes:get/state`, `workflow-modes:changed`, and `workflow-modes:save-plan/result` events. Engineering docs consumes state for write gating; subagents queries it before worker spawn; bridge uses it for recall and plan save.

## Discussion notes

`discussion-notes` owns an in-memory view reconstructed from selected branch entries on `session_start` and `session_tree`.

- Tool additions persist their versioned snapshot in tool-result details.
- Manual `/notes` and bridge additions append `discussion-notes` custom entries.
- Each note has type, text, timestamp, source, and branch-local numeric ID.
- Input is normalized, deduplicated by type/text, limited to 480 characters per note and 200 active notes.
- Failed custom-entry persistence restores previous in-memory state.
- Compact status/widget shows latest notes; `/notes` provides list/detail/add/clear UI.
- Filtered `discussion_notes list` calls expose bounded pages of at most 50 notes to the model; unfiltered calls retain count-only content.
- `/notes promote` starts a visible current-session turn containing every active `lesson` as delimited JSON. Build/Off curates into canonical `docs/engineering/`; read-only modes propose changes and point to `/mode build`.

Bridge capture never mutates imported module state. It requests addition over the event bus; the live owner appends the snapshot, redraws UI, and returns result. Capture does not stage or write memory; project promotion remains explicit and never targets user-global personal memory.

## File-change tracking and rollback

`filechanges` watches Pi `edit` and `write` lifecycle events.

1. `tool_call` captures a preimage keyed by tool-call ID.
2. Failed results discard pending preimages.
3. First successful result appends one immutable branch baseline for that path.
4. Current file bytes are reread as UTF-8 and compared with first baseline to render cumulative unified diff.
5. Session start/tree navigation replays branch baseline/clear/untrack entries, then recomputes against disk.

Accept keeps current files and clears tracking. Decline requires confirmation unless forced, deletes files whose baseline was absent, restores original UTF-8 content for existing files, reports per-file failures, then clears tracking. This is a Pi-tool mutation log, not Git state: Bash/external mutations do not establish new baselines, and no accept/decline action stages or commits.

## CCC semantic search

`ccc_search` invokes `ccc search` through `execFile` with fixed argv. Query, language filters, project-relative path glob, pagination, timeout, abort signal, and output size are validated/bounded. Query text never enters a shell.

Search may use daemon state under `~/.cocoindex_code/`, ignored project `.cocoindex_code/`, and configured embedding network access. Tool surface permits search and optional refresh only. Initialization/index management remain explicit Build-mode CLI operations.

## Subagents

Subagents run as persisted in-process child `AgentSession`s with a fresh `SessionManager.create(ctx.cwd)`. Child resource loaders disable extension, theme, skill, and context-file discovery; parent receives only parsed final structured output, while child transcript remains in host session storage.

- Explorer definitions must contain only `read`, `grep`, `find`, and `ls`.
- Worker spawn queries live workflow mode and refuses outside Build.
- Spawn graph is bounded to parent → worker → explorer. Workers receive nested explorer only; explorers receive no spawn tools.
- Default concurrency lane cap is three; reserved nested-explorer lane cap is one. Global settings may be overridden by nearest project `.pi/settings.json`.
- Concurrent worker ownership paths may not overlap.
- Progress widget is keyed/throttled and clears after all runs.
- Idle watchdog resets on every child event; absolute max-total timer does not reset. Timeout failures preserve partial output metadata.
- `/subagent-model` manages per-role model defaults; debug tools expose progress, graph, concurrency, discovery, direct run, and in-process spike diagnostics.

## Engineering docs

`engineering-docs` manages `docs/engineering/` according to `manifest.json` and design-system docs under `docs/design/` according to its separate `design-docs` manifest.

- `/docs init` scaffolds missing canonical docs without overwriting existing files.
- `/docs check` validates manifest, ADRs, decision index, and generated spoke marker blocks; repair writes occur only when mode permits.
- `/docs init --design` scaffolds non-destructive design docs; `/docs update-tokens` generates deterministic token reference; `/docs check` validates manifest, token freshness, marker usage, and preview `var()` styling.
- `/docs update-index`, `/docs validate-tags`, and `/docs patch` cover index, plan tags, and change-driven suggestions.
- `docs_validate_tags` validates `[DOCS:*]` and ADR-action pairing.
- Write permission is derived from live workflow state and fails closed before state is known; only Build/Off allow docs writes.
- Successful edit/write results append branch-local tracking markers. `agent_end` may remind when source changed but engineering docs did not.
- `AGENTS.md` and `CLAUDE.md` are generated pointer spokes. Only marker blocks are extension-owned.

## Personal memory

`personal-memory/store.ts` owns user-global indexed storage:

1. Entries are slugged Markdown with required frontmatter.
2. `MEMORY.md` is generated from conforming entries.
3. Bare or prefilled `/remember` starts a visible two-turn global curation flow: first list/ask without saving, then consolidate the user's selection.
4. The `remember` tool writes one entry through `writeMemoryFact`; an optional validated slug replaces that exact entry, in-process writes serialize around the index path, and `MEMORY.md` is rebuilt.
5. `before_agent_start` injects compact index only.
6. `recall_memory_entry(slug)` validates one slug and fetches one full body.
7. Legacy `~/.pi/memory.md` migrates once, then is renamed `memory.md.bak`.

Bridge `recall_entry` and `save_memory` call same store. Curation uses the current visible session model, but no automatic/background extraction, staging, or reconciliation pipeline exists; persistence claims require successful tool results.

## Terminal notification

`notify` has no persisted state. On `agent_end`, it selects Windows toast when `WT_SESSION` exists, Kitty OSC 99 when `KITTY_WINDOW_ID` exists, otherwise OSC 777, then announces that Pi is ready for input.
