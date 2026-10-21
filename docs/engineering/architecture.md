# Architecture

## Workspace and package boundary

This workspace prepares package version `@lopezpetergabriel/pi-extensions@0.9.2`, one Pi package containing twelve extensions, four skills, and two package-owned bundled agent definitions. This repository is package source, not a separate Pi home.

- The prepared `0.9.2` release tarball is configured to ship runtime TS/helpers, workflow plan template, agent/skill Markdown, README.md, LICENSE, CHANGELOG.md, required nested READMEs, and exactly six bridge-client runtime files: `agent/claude-bridge-client/pi-bridge-mcp.js`, `agent/claude-bridge-client/pi-readonly-hook.js`, `agent/claude-bridge-client/pi-peer-hook.js`, `agent/claude-bridge-client/pi-statusline.js`, `agent/cursor-bridge-client/cursor-readonly-hook.js`, and `agent/opencode-bridge-client/pi-opencode-plugin.js`. It also ships nine `pi-*` command templates under `agent/harness-commands/{claude,cursor,opencode}/`. It excludes `docs/engineering/**`, `.cursor/**`, tests, nested manifests/locks/tsconfigs, `.pi`, `node_modules`, and runtime/user state. Package gates enforce <=512 KiB packed and <=1 MiB unpacked.
- From `0.8.0` onward, the `release` branch mirrors the unpacked tarball file-for-file; only an optional root `.npmrc` may be extra. Main retains engineering docs and development material, including `.cursor/` commands and config; those files are not packaged.
- `bin/pi-workspace` resolves the repository root from its own location, then runs `pi --no-extensions -e <root>` for source development. The source checkout’s `.pi/agents` link is a dev/project mechanism, not npm agent registration.
- Bundled agent definitions load relative to the package module. Scope overrides are: default user = bundled then user; project = bundled then nearest project; both = bundled then user then project. Later definitions override by name, but a selected valid unsafe explorer override is rejected by the caller’s read-only validator.
- The package reuses host Pi auth, settings, model catalogs, personal memory, and session storage. Those remain outside this repository under Pi-owned user-global paths. Dependency installs, CCC indexes, bridge IPC, logs, DBs, credentials, sessions, plans, and personal memory are runtime/generated state and ignored.
- Active global extension source under `~/.pi` is independent. Workspace scripts and source must not import or mutate that source tree.

`agent/extensions/workflow-modes/index.ts` resolves `plan-template.md` relative to `import.meta.url`; package behavior does not depend on checkout location or a user-specific absolute path.

## Packaged component inventory

### Extensions

| # | Entrypoint | Surface | Owned state / role |
|---|---|---|---|
| 1 | `agent/extensions/browser/index.ts` | `/browser`; `browser_goto`, `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`, `browser_screenshot`, `browser_close`/`browser_kill` | Owns gated persistent Chromium context, lazy owner-keyed pages, per-page bounded console/network buffers, browser:* request/result events, and browser-free unit-test helpers. |
| 2 | `agent/extensions/ccc-search/index.ts` | `ccc_search` tool | Validates bounded semantic-search input and invokes fixed `ccc search` argv without a shell. |
| 3 | `agent/extensions/claude-bridge/index.ts` | `/claude-bridge` command | Owns one private IPC namespace per validated Pi session, heartbeat/presence, request processing, idempotency cache, peer pairing/chat routing, and event-bus adapters. |
| 4 | `agent/extensions/discussion-notes.ts` | `discussion_notes` tool, `/notes` command, Notes UI | Owns typed notes for selected Pi session branch and reconstructs them from branch entries. |
| 5 | `agent/extensions/engineering-docs/index.ts` | `docs_validate_tags` tool, `/docs` command | Owns managed engineering-doc operations, tag validation, generated spokes/indexes, and branch-local reminder tracking. |
| 6 | `agent/extensions/filechanges/index.ts` | `/filechanges`, `/filechanges-accept`, `/filechanges-decline` | Tracks successful Pi `edit`/`write` mutations against branch-local first-write baselines and can keep or revert them. |
| 7 | `agent/extensions/notify.ts` | `agent_end` lifecycle hook | Emits terminal-native “Ready for input” notification; no persistent state. |
| 8 | `agent/extensions/personal-memory/index.ts` | `remember`, `recall_memory_entry`, `/remember` | Owns user-global indexed personal-memory reads, writes, and one-time legacy migration. |
| 9 | `agent/extensions/subagents/index.ts` | `subagent`, `subagents_list`, `subagent_message`, model/effort commands | Discovers agent definitions, enforces toolset/depth/concurrency/ownership policy, relays child questions through the question owner, tracks result receipt, and runs isolated persisted child processes. |
| 10 | `agent/extensions/workflow-modes/index.ts` | `/mode`, `/plan`, `/caveman`; prompt/tool hooks | Owns branch-local workflow mode, session-scoped saved-plan pointers/task progress, Caveman preference, prompt composition, and read-only mode gates. |
| 11 | `agent/extensions/ask-user-question/index.ts` | `ask_user_question` tool | Owns model text/single-/multi-select and child text/single-select UI, source-scoped FIFO serialization, and threshold-defer/resume. Child RPC dialogs use built-in `select`/`input`. |
| 12 | `agent/extensions/harness-setup/index.ts` | `/harness` command | Inspects and manages owned Claude, Cursor, and OpenCode setup through previewed, confirmed plans; records installed harnesses in the agent-dir stamp. |

### Agent definitions

| Definition | Contract | Discovery |
|---|---|---|
| `agent/agents/explorer.md` | Repository-read-only discovery using `read`, `grep`, `find`, `ls`, and parent-injected browser proxies; returns compressed files/code/architecture/open-question output. | Bundled module-relative definition; user/project overrides follow explicit scope. |
| `agent/agents/worker.md` | Build-mode scoped implementation using coding tools; returns summary, touched files, commands, follow-ups, and questions. | Bundled module-relative definition; user/project overrides follow explicit scope. |

Subagent discovery is module-relative for bundled definitions. Scope defaults to bundled+user; project is bundled+nearest project; both is bundled, then user, then project, with later same-name definitions winning. A selected valid-but-unsafe explorer override remains selected for validation and is rejected rather than silently replaced. A local same-name override shadows its bundled definition; discovery reports omitted bundled `tools`, `subagent_agents`, or `model` keys, and subagents warns once per override file per session.

### Skills

| Skill | Purpose |
|---|---|
| `agent/skills/grill` | One-question-at-a-time plan interrogation with a recommended answer. |
| `agent/skills/grill-with-docs` | Domain-aware interrogation that inspects code/docs, captures discussion notes, updates context docs, and offers ADRs only for durable trade-offs. |
| `agent/skills/web-debug` | Evidence-first browser debugging for console, network, DOM, storage, session, and UI symptoms. |
| `agent/skills/worker-orchestration` | Contract-first A+B orchestration with disjoint ownership, staged discovery (inventory → parent selection → bounded inspect), default budgets (inventory no reads/≤10 `grep`/`find`/`ls`; inspect ≤5 files/≤10 reads), sequential preference, parent-owned integration, and at most two within-task slices at default/≥3 concurrencyCap to leave a nested-explorer slot. |

### Harness clients and project integration

The `.cursor/` MCP config, hooks, and commands below are main-repository integrations only; `.cursor/**` is never included in the npm package or its tarball-mirroring `release` branch. Nine `pi-*` templates for Claude, Cursor, and OpenCode are shipped under `agent/harness-commands/`. This repository's `.cursor/commands/pi-*` symlinks point to the packaged Cursor templates but remain repo-only.

- `agent/claude-bridge-client/pi-bridge-mcp.js` is the shared Node-stdlib MCP/file-protocol client for Claude Code, Cursor, and OpenCode; client code imports no Pi internals. It requires finite lease timestamps and fails closed when `expiresAt` is missing, malformed, or elapsed.
- `agent/claude-bridge-client/pi-readonly-hook.js` is Claude Code’s fail-closed PreToolUse guard outside a matching Pi Build lease. For bridge MCP calls it validates host `session_id`, rejects conflicting identity args, then stamps `sessionId` and `harness: "claude"`. It denies mutation tools, passes bridge and known read/meta tools, asks on unknown or foreign tools, and denies on hook errors; harness setup appends an exit-2 guard to the `PreToolUse` command. Claude’s `UserPromptSubmit` peer hook injects pending messages as advisory context, then acknowledges included IDs; `SessionEnd` best-effort unpairs.
- Claude’s statusline composes the `Pi ✉N` indicator from bridge presence only; it does not issue requests, write state, or ack messages.
- `agent/cursor-bridge-client/cursor-readonly-hook.js` classifies Cursor shell/MCP activity and returns Cursor's `permission` contract. Bridge MCP calls require safe `conversation_id`, parseable args, matching `sessionId`, and `harness: "cursor"`; mismatches deny. Without a matching lease it allows only allowlisted read shell segments, `preToolUse` allows known read plus shell/MCP passthrough types and denies other names, and unknown foreign MCP asks; a matching `conversation_id` lease permits shell and `preToolUse` tools. Cursor peer chat uses MCP `read_messages` as its pull path; no Cursor peer-message hook is installed.
- `agent/opencode-bridge-client/pi-opencode-plugin.js` uses OpenCode's `tool.execute.before`, overwrites bridge MCP identity from host `sessionID` and `harness: "opencode"`, and without a matching lease allows known read/bridge/`execute` calls and sandboxed shell while throwing on other names.
- `.cursor/mcp.json` registers the shared bridge MCP client.
- `.cursor/hooks.json` registers Cursor shell, MCP, pre-tool, and commit-nudge guards.
- `.cursor/commands/pi-discuss.md`, `.cursor/commands/pi-plan.md`, and `.cursor/commands/pi-build.md` are repository symlinks to `agent/harness-commands/cursor/pi-{discuss,plan,build}.md`; they define bridge-backed workflows and remain repo-only.
- `agent/harness-commands/{claude,cursor,opencode}/pi-{discuss,plan,build}.md` provide the nine shipped harness workflows, including Build handoff and live tracker mapping.
- `harness-setup` reads the harness manifest, classifies the package root, inspects owned destinations, builds an install/repair/uninstall plan, previews diffs, and requires confirmation before apply. Apply re-reads targets before mutation; config changes and stamp updates use safe backups and atomic replacement. Startup health checks inspect only stamped harnesses and never repair them.
- `.cursor/commands/{discuss,plan,build}.md` provide a neutral workflow that needs no bridge or Pi session; `.cursor/skills/write-adr/SKILL.md` documents project ADR authoring.
- `.cursor/hooks/docs-nudge.js` asks for an engineering-doc update on code commits that stage no `docs/engineering/**` path, without blocking the commit.

## Runtime-state ownership

| State | Location | Owner | Repository status |
|---|---|---|---|
| Package source, docs, agent definitions, skills | Repository tracked files | Git / contributors | Versioned |
| Harness setup stamp | `<agentDir>/harness-setup.json` | `harness-setup` | Pi-owned runtime state; records harnesses managed by this package, excluded from Git |
| Workflow mode, saved-plan pointers/selection/task progress, Caveman preference | Selected Pi session branch entries; plan body at `<agentDir>/plans/<sessionId>/<planId>.md` | `workflow-modes` | Host session storage; body is atomic, session-scoped, and never repository/Git-branch/bridge-scoped |
| Discussion notes | Selected Pi session branch tool-result/custom entries | `discussion-notes` | Host session storage |
| File-change baselines and clear/untrack events | Selected Pi session branch custom entries | `filechanges` | Host session storage |
| Docs changed-file/touched/snooze markers | Selected Pi session branch custom entries | `engineering-docs` | Host session storage |
| Parent and child session files | Pi user-global agent session storage | Pi host / `SessionManager` | Excluded |
| Browser gate, shared Chromium context, owner-keyed pages, per-page buffers | Selected session branch `browser:state` plus live Playwright state; profile defaults to `<agentDir>/extensions/browser/.profile` or `PI_BROWSER_PROFILE` | `browser` | Gate is branch-persisted; context, pages, and buffers are process runtime state; profile is user-global runtime state |
| Auth, settings, model catalogs | Pi user-global agent directory | Pi host | Reused, never copied into Git |
| Personal memory entries and generated index | `~/.pi/memory/*.md`, `~/.pi/memory/MEMORY.md` | `personal-memory/store.ts` | User-global, excluded |
| Bridge requests, responses, processed cache, and presence | `<project>/.pi/memory/bridge/sessions/<piSessionId>/{requests,responses,processed,presence.json}` | `claude-bridge` | One private `0700` namespace per validated Pi session; bridge files are `0600`; ephemeral and ignored |
| Peer mailbox | In-process bridge memory | `claude-bridge` | Ephemeral, bounded, non-durable; pending messages can be dropped on session switch or shutdown |
| Dependency trees and semantic index | package `node_modules/`, `.cocoindex_code/` | npm / CCC | Generated, ignored |

Project truth belongs in `docs/engineering/` and ADRs. Discussion notes are session handoff state, not project truth or personal memory. Personal memory is cross-repository user state, not project documentation.

## Extension interaction map

```text
subagents ──browser:request──> browser-owned page operations
browser ──browser:result──> subagents browser proxies
subagents ──ask-user-question:request/cancel──> ask-user-question FIFO
ask-user-question ──ack/result──> subagents relay
workflow-modes ──tool-call gate──> browser mutation tools
       │
       ├──state/events──> engineering-docs write gating
       ├──state/build gate──────> subagents subagent
       └──state/save-plan───────> claude-bridge <──file IPC── bridge clients
                                      │
                                      ├──add event────> discussion-notes
                                      ├──pure validator> engineering-docs filesystem helpers
                                      └──store calls───> personal-memory store

edit/write lifecycle ───────────> filechanges + engineering-docs tracking/advisory
agent_end ──────────────────────> notify + engineering-docs reminder

static imports:
claude-bridge ──3 sibling imports──> workflow-modes + engineering-docs + personal-memory
workflow-modes ──2 sibling imports──> engineering-docs
```

Live mutable extension state has one owner. Cross-extension mutation uses namespaced `pi.events` request/result pairs. Direct imports from the bridge are limited to pure prompt composition, docs validation, and personal-memory store functions; the bridge does not import mutable discussion-note or workflow session state.

Static coupling totals five imports: `claude-bridge` imports `workflow-modes`, `engineering-docs`, and `personal-memory` (`agent/extensions/claude-bridge/index.ts:6-8`), while `workflow-modes` imports `engineering-docs` from its entrypoint and policy helper (`agent/extensions/workflow-modes/index.ts:8`, `agent/extensions/workflow-modes/policy.ts:1`). `claude-bridge` is therefore the only consumer spanning multiple sibling extensions; both `workflow-modes` imports target the same sibling.

Four extensions have no outgoing cross-extension edge—neither a sibling import nor a `pi.events` call—in their complete runtime source: `ccc-search` (`agent/extensions/ccc-search/index.ts`), `filechanges` (`agent/extensions/filechanges/index.ts`), `notify` (`agent/extensions/notify.ts`), and `personal-memory` (`agent/extensions/personal-memory/index.ts`, `curation.ts`, `store.ts`). `ask-user-question` listens for namespaced child request/cancel events and emits synchronous acknowledgments and later results to `subagents`; browser uses the namespaced `browser:request`/`browser:result` channel. Incoming use of `personal-memory/store.ts` by `claude-bridge` remains visible in the static map above (`agent/extensions/claude-bridge/index.ts:8`).

### ask_user_question context defer

After an answered TUI result, `index.ts:726-739` reads `ctx.getContextUsage()` once and records bounded question/answer text when `defer.ts:22-53` finds `tokens > contextWindow - 16,384`. `deferredThisRun` and `deferAbortRequested` keep one pending batch to one abort and one transcript marker.

`tool_execution_end` (`index.ts:660-671`) waits for `ask-user-question/queue.ts:8-40` to drain, appends the TUI-only `ask-user-question:context-defer` entry, then aborts. `agent_settled` (`index.ts:673-679`) takes the pending batch and sends `buildResumeMessage()` as a fresh user message without `deliverAs`; Pi's non-streaming prompt preflight checks compaction at `@earendil-works/pi-coding-agent/dist/core/agent-session.js:864-868`. `pi.appendEntry()` keeps the marker out of LLM context. A disposable AgentSession harness observed compaction, fresh resume, one batch marker/abort, preserved mixed-tool results, and no unpaired `tool_use`.

Build topology keeps twelve runtime entrypoints (`package.json:37-48`). Pi's loader exposes one aggregate `noExtensions` option but no per-entrypoint disable option (`@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts:63-84`). Development tooling is split across:

- seven nested manifests (`agent/extensions/browser/package.json:1`, `agent/extensions/ccc-search/package.json:1`, `agent/extensions/engineering-docs/package.json:1`, `agent/extensions/filechanges/package.json:1`, `agent/extensions/personal-memory/package.json:1`, `agent/extensions/subagents/package.json:1`, `agent/extensions/workflow-modes/package.json:1`);
- five nested lockfiles (`agent/extensions/browser/package-lock.json:1`, `agent/extensions/ccc-search/package-lock.json:1`, `agent/extensions/filechanges/package-lock.json:1`, `agent/extensions/subagents/package-lock.json:1`, `agent/extensions/workflow-modes/package-lock.json:1`); and
- five nested TypeScript configs (`agent/extensions/browser/tsconfig.json:1`, `agent/extensions/ccc-search/tsconfig.json:1`, `agent/extensions/personal-memory/tsconfig.json:1`, `agent/extensions/subagents/tsconfig.json:1`, `agent/extensions/workflow-modes/tsconfig.json:1`).

Root scripts install the five lockfile-backed packages, then run the focused ask-user-question queue test, aggregate six nested extension suites, and run five typechecks (`package.json:55-63`).

## Pi ↔ multi-harness bridge

Claude Code, Cursor, and OpenCode use the bridge for planning and peer chat. Pi remains source of truth for engineering docs validation, discussion notes, personal memory, workflow prompts, saved-plan handoff, lease lifecycle, and task progress; an external harness executes Build only under a Pi-granted lease.

### Per-session namespace and request protocol

1. Pi loads `agent/extensions/claude-bridge/index.ts` in an active session and resolves project root from nearest `.pi/` marker.
2. Each validated Pi session owns `<project>/.pi/memory/bridge/sessions/<piSessionId>/{requests,responses,processed,presence.json}`. Namespace directories are `0700`; bridge files are `0600`. There is no project-wide single-owner lock or legacy shared-root fallback.
3. A fresh namespace already owned by another PID makes that Pi session's bridge passive; different Pi session IDs can be active concurrently. Presence schemaVersion 2 records Pi session ID/name, cached workflow mode, PID, start/heartbeat times, peers, outbound `pendingCount`, and inbound `inboundPendingCount`; optional `buildLease` carries the single active harness identity and plan ID. Heartbeat interval is 2s; clients consider presence fresh for 5s; namespaces with heartbeat older than 10m are GC'd with their peers. `/claude-bridge` lists live namespaces.
4. MCP clients write UUID request JSON and poll matching responses for up to two seconds. Requests are `{ id, type, payload, ts, peer? }`; responses are `{ id, ok, result | error }`; processed responses are replay cache. UUID replay is idempotent. If bridge is unavailable, clients return exact error `Pi bridge not responding; start/focus Pi in this project.`
5. Bridge operations include `recall`, `recall_entry`, `save_memory`, `capture`, `validate_tags`, `save_plan`, `read_plan_tasks`, `tick_plan_task`, and peer pairing/message operations. Recall returns canonical engineering docs, compact personal-memory index, composed workflow prompts, plan template, and live saved-plan state; task reads/ticks use the live workflow owner rather than a bridge cache.

`capture` accepts primary `sessionId` plus deprecated `claudeSessionId`; explicit `sessionId` wins over the alias, which wins over `CLAUDE_CODE_SESSION_ID`. `harness` defaults to `claude` and accepts `claude`, `cursor`, `opencode`, or `pi`. Capture emits `discussion-notes:add`; `save_plan` emits `workflow-modes:save-plan`; both wait for the live owner response. Recall obtains saved plans only through `workflow-modes:get`; unavailable live state is an error.

### Pairing and peer chat

Session and peer identifiers are path-safe (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; UUIDv7 is allowed). If exactly one live Pi session exists, an unpaired harness identity auto-pairs to it. With multiple live Pi sessions, pairing is ambiguous and the bridge lists choices. `pair_session` selects one peer and unpairs a prior live pairing. Pairing changes occur through live Pi bridge requests, except same-session restart within 10m may restore peers from that session's own validated non-live presence; peers present in any other live namespace are excluded, so live pairing wins. Each Pi session allows at most 10 peers, 4,000 characters per message, and 20 pending messages per peer per direction.

The peer mailbox is in-process memory, not durable storage. Harness `send_message` is paired-only. Inbound messages drain only into one delimited JSON custom message at the next `before_agent_start`; there is no auto-wake or follow-up turn. Delivery includes a fixed advisory header; peer text is JSON data with delimiter-sensitive characters escaped, never provenance, approval, or instructions. Pi `bridge_message` routes to one paired peer; `to` is required when multiple peers are paired.

Pi-to-peer messages remain pending until the paired peer acknowledges IDs. Reads are non-destructive; ack is idempotent and peer-scoped; failures redeliver the same IDs. MCP `read_messages` returns then acknowledges, with ack failure surfaced as a warning and possible same-ID redelivery. Claude peer hook flushes injected output before ack. Its `UserPromptSubmit` hook checks presence first, reads only when pending, formats at most 9,000 characters, adds `additionalContext`, then acks included IDs; remainder stays pending. Hook failure is fail-open because injection is not a guard. `SessionEnd` best-effort unpairs. Pi surfaces inbound status/toast and warns with the dropped mailbox count on session switch or shutdown.

Claude statusline shows `Pi ✉N` from presence only: no requests, writes, or acknowledgments. Cursor's peer-message path is MCP `read_messages` pull; there is no Cursor peer hook. A clean stop removes the owned namespace's `requests`, `responses`, and `processed` directories, leaving only `presence.json` (0600 in the 0700 namespace) with back-dated, non-live presence. Clean shutdown or session switch drops pending mailbox messages. A restart of the same Pi session within 10m restores peers only from that namespace's own validated non-live presence, excluding peers present in any other live namespace; live pairing wins. GC removes the namespace and peers after 10m. Ignored parent directories may remain.

### Lease-scoped harness Build and read-only enforcement

- Build recall validates a paired Claude, Cursor, or OpenCode peer, active saved plan, and Pi mode; it returns an active same-peer lease, a refusal, or a per-peer pending request. It never grants. The handler does not wait for UI; pending requests are capped at 10 and notify only when new. Headless Pi returns `build_lease_no_approval` without recording a request.
- Only interactive Pi `/build-lease approve` grants. The confirmation shows peer id, request age, plan progress, and four-hour expiry; after confirmation, Pi re-reads workflow and pairing and refuses if plan, mode, pairing, or holder changed. Declining confirmation removes the selected request.
- A grant is one in-memory lease per Pi session with `expiresAt = grantedAt + 4 hours`; schemaVersion 2 presence carries optional `buildLease` and expiry. `/build-lease` reports holder, remaining time, and pending requests; `/build-lease release` clears the active lease.
- Hooks read local presence only, issue no bridge round-trips, and write no Pi state. Mutation requires exactly one fresh paired namespace and a valid, unexpired lease matching host identity (`session_id`, `conversation_id`, or OpenCode `sessionID`); old-format or expired lease data fails closed.
- In `.pi` projects, Claude denies mutation tools without a lease, passes bridge and known read/meta tools, asks on unknown or foreign tools, and sandbox-wraps Bash through macOS Seatbelt; no-lease Bash is denied closed on non-macOS platforms. Hook errors deny, and setup guards `PreToolUse` with an exit-2 suffix. A matching lease allows its holder's tools and unsandboxed Bash.
- Cursor allows only allowlisted read shell segments and `preToolUse` read/passthrough types without a matching lease; bridge identity must match safe host `conversation_id`; unknown foreign MCP asks, and its `permission: "deny"` contract remains unchanged. A matching lease allows shell and `preToolUse` tools; no hook writes or reverts files.
- OpenCode's global plugin replaces model MCP identity with host `sessionID`, allows known read/bridge/`execute` calls and sandboxed `shell` without a matching lease, and throws on edit/write/worktree, patch-style, unknown, and foreign MCP names. The outer Code Mode `execute` dispatcher remains available; nested tools re-enter the hook.
- Only the active lease holder may tick saved-plan tasks through the bridge; non-holders receive `build_lease_required`. Pi's own `workflow_plan_tick` is unchanged. Expiry, holder unpair, holder Discuss/Plan recall, plan clear/change/completion, Pi Build mode, explicit release, or bridge/session lifecycle revokes the lease. Pi's synchronous Build guard blocks `/mode build` while leased; Pi Off remains intentionally unguarded.

## Workflow modes

`workflow-modes` reconstructs branch-local contracts from selected session ancestry:

- `workflow-mode-set` selects Off, Discuss, Plan, Build, Review, or Design.
- `workflow-plan` stores plan pointer set/activate/clear events plus task ticks. The immutable plan body lives at `<agentDir>/plans/<sessionId>/<planId>.md`; only its session-scoped pointer and progress state live in branch entries.
- `caveman-mode-state` stores Caveman preference; no explicit entry means enabled.

`/plan save` writes the bounded plan body atomically, seeds Section 4 tasks, then appends the durable pointer before activating it. `/plan select`, `/plan view`, and `/plan clear` operate on plans visible in selected ancestry; clear deactivates the pointer but does not delete its file. `workflow_plan_tick` records one completed task per confirmation, so the tracker—not immutable Section 4 checkboxes—is the Build queue. Before each turn, workflow-modes rereads the active body and sends a compact marker message whose content names plan identity, progress, and next task. Its structured details retain host metadata such as path and savedAt; Pi drops those details during LLM conversion (`@earendil-works/pi-coding-agent/dist/core/messages.js:89-96`).

Off injects no workflow/style prompt. Discuss, Plan, Build, Review, and Design compose mode prompt plus the active saved-plan body when present (`workflow-modes/caveman.ts`), then Caveman or normal-style override. Build and Design reference prompt lines are gated on `docs/design/reference/` presence, independently of the manifest; Claude bridge passes cwd for both modes for parity. Build's existing design-aware guidance remains manifest-gated. Design scopes design-system work to `docs/design/` plus manifest-declared token CSS; component source remains Build work. Plan-template resolution is module-relative.

Discuss, Plan, and Review block mutation tools, including browser navigation, evaluation, actions, and page close. Design allows `write`/`edit` only inside `docs/design/**` or manifest-declared token files, failing closed to `docs/design/**` when manifest is missing or invalid; browser mutation tools remain blocked there. Design Bash reuses Plan's sandboxed read/test policy. Discuss/Plan Bash prefers structural sandboxing with network denied; Review admits only scoped read/approved `gh` commands, keeps filesystem writes denied, and permits network. If sandbox wrapping is unavailable or fails, conservative regex policy applies.

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

`agent/extensions/subagents/index.ts` exposes `subagent`, `subagents_list`, and `subagent_message`. The parent resolves an agent definition, workflow mode, toolset, model, effort, ownership paths, and spawn depth before `SubagentLaunchHost` writes an atomic `0600` loadout under Pi-owned runtime state. The loadout preserves the exact tool allowlist, agent prompt, model, session ID, parent session ID, browser scope, depth, and nested-agent allowlist for resume.

The parent launches each child with `process.execPath` and its Pi CLI script resolved from `process.argv[1]`, in `--mode rpc` with `--no-extensions`, the child extension, and the loadout-authoritative `--tools` list. It never looks up `pi` from `PATH`. A thin LF-delimited JSONL client correlates commands and events, with a 32 MiB record cap; the `prompt` response is readiness (bounded to 30 seconds), `handled` is a classified launch failure, and process exit before `agent_settled` is a failure. After `agent_settled`, the parent reads final text with `get_last_assistant_text`; `get_state` supplies the child session file. A running `subagent_message` uses RPC `steer` and arrives at the child's next tool boundary. Child `ask_question` requests use RPC extension UI and are relayed to the main parent; child session transcripts stay separate from parent context. Result and failure text is queued with `sendUserMessage(..., { deliverAs: "followUp" })`, but delivery is recorded only when `message_start` user text or `subagent-result` custom content contains the saved text. Until receipt, `subagents_list` shows the body as pending; after receipt, it hides the body and reports delivered. At `agent_settled`, the first check leaves exact text already in the editor user-owned; otherwise the parent queues at most one displayed `subagent-result` with `deliverAs: "nextTurn"`. This fallback never starts a parent turn. An unchanged repeated list call without `tail` returns `No change since last check. Results arrive automatically as a new turn; end your turn instead of polling.`

The host owns one length-prefixed Unix socket per parent session. Each run registers a random token bound to its owner; the first `hello` frame authenticates that pair and carries no lifecycle result. Child IPC connects lazily for nested `spawn`, owner-scoped `browser`, and `ownership` requests only. Frames are capped at 256 KiB; socket directory and socket permissions are `0700` and `0600`. The side channel carries no results, questions, messages, or activity, and disconnect alone does not fail a run.

Each run writes child stderr only to a Pi-owned diagnostics log capped at 1 MiB; stderr never reaches the parent TTY. Complete lines receive one `[stderr]` prefix; partial lines buffer and long partial lines flush without repeating the prefix. The exact per-run token stays redacted across chunks, and only the exact Pi missing-project-session warning for this child session ID is dropped; other stderr warnings remain. The 8 KiB in-memory event/text tail, persistent log, and failure text all redact the exact per-run token. Supported RPC events touch the watchdog; open tool-call IDs pause idle timeout while max-total continues, and a parent question pauses both budgets. A terminal result, failure, abort, or host close settles once and releases the RPC process, ownership lock, concurrency slot, watchdog, browser page, pending question/IPC requests, and per-run token. During parent `session_shutdown`, host-close failures remain diagnostic and send no failure follow-up. RPC children exit on stdin EOF; cancellation sends RPC `abort`, closes stdin, then escalates to `SIGTERM` after one second and `SIGKILL` 500ms later.

The child extension registers only loadout-approved tools plus `ask_question`, owner-scoped browser proxies, and allowlisted nested `subagent`. `subagent_agents:` frontmatter controls nested definitions; `MAX_SUBAGENT_DEPTH` is two. Any toolset containing a mutating tool requires Build at spawn time. Concurrent children use one configurable default semaphore with capacity three; overlapping ownership is rejected using case-folded canonical keys resolved against parent cwd and the longest existing ancestor. Original paths remain in conflicts and snapshots; read-only children skip locks (`ownership.ts`). `progress.ts` renders `subagents-progress` above the editor with 250ms throttling; launch, list, and failure output identify `rpc` transport and diagnostics path. Per-role effort is settings-only: unset or invalid explorer effort resolves to `low`, while worker effort inherits the parent; explicit explorer `inherit` is persisted to override its default.

The parent also retains a bounded structured item buffer per run: at most 200 items, each at most 2 KiB serialized. Text/thinking deltas coalesce by content index, finalized content replaces deltas, and tool start/end becomes one summary; oldest items evict first. Each item passes through `redactSubagentText`; long text keeps its suffix. `readItems(owner)` provides recent state; `subscribeItems(owner, listener)` streams updates and is released on settle, abort, failure, or host close. `/agents` formats these items without transcript parsing, shows recent and live output in a TUI-only overlay, and throttles redraws to 10/s. The overlay re-reads the live parent context and exposes no loadout, environment, or auth data.

Child `ask_question` requests at any depth enter a subagents queue gated while `/agents` is open. The extension emits a redacted `ask-user-question:request` over `pi.events`; the owner acknowledges synchronously, then reports an asynchronous result. Model and child dialogs share one FIFO with source-scoped cancellation. TUI child questions use the owner's existing components; non-TUI/RPC questions use built-in `ctx.ui.select`/`ctx.ui.input` in that same FIFO. Option questions offer Other without Skip. Missing owner, unavailable UI, or dismissal leaves the child question pending; in TUI it remains answerable through `/agents`. UI, overlay, and explicit `subagent_message` answers share owner-plus-question-ID exactly-once handling; `/agents` answers, child settlement, and shutdown cancel open owner requests. The answer returns only to its addressed child; a redacted question/answer note reaches the main agent with `deliverAs: "nextTurn"`, without starting a parent turn or steering intermediate children.

### Browser page state model

`browser` owns one persistent Chromium context and lazily creates owner-keyed pages through `context.newPage()`. Parent and children share the context but never a page: `MAX_BROWSER_PAGES` is four (`MAX_BROWSER_PAGES` in `agent/extensions/browser/index.ts`), with the explicit registry rejecting new owners at capacity. Child browser tools send authenticated IPC `browser` requests; the parent forwards them through `browser:request`/`browser:result` to browser-owned operations.

Each owner has independent console and network ring buffers capped at 1,000 entries. Read-only child toolsets receive only console/screenshot/network and force console/network `clear=false`; Build toolsets may receive full proxy set. Timeout, abort, owner close, child result/exit, `/browser off`, `/new`, disabled tree reconstruction, and `session_shutdown` close the relevant page/context.

## Engineering docs

`engineering-docs` manages `docs/engineering/` according to `manifest.json` and design-system docs under `docs/design/` according to its separate `design-docs` manifest.

- `/docs init` scaffolds missing canonical docs without overwriting existing files.
- `/docs check` validates the manifest, ADRs, full generated decision-index content (including status, summary, and read-when metadata), and generated spoke marker blocks; repair writes occur only when mode permits.
- Root `npm run check:docs` is read-only: it checks index freshness, root spokes, and ADR validity, printing `/docs update-index` or `/docs check` as the repair path. `npm run check` and `npm test` include this gate.
- `/docs init --design` scaffolds non-destructive design docs; `/docs update-tokens` generates deterministic token reference; `/docs check` validates manifest, token freshness, marker usage, and preview `var()` styling.
- `/docs update-index`, `/docs validate-tags`, and `/docs patch` cover index, plan tags, and change-driven suggestions.
- `docs_validate_tags` validates `[DOCS:*]` and ADR-action pairing.
- Write permission is derived from live workflow state and fails closed before state is known; only Build/Off allow docs writes.
- Successful edit/write results append branch-local tracking markers. `agent_end` may remind when source changed but engineering docs did not.
- The same successful `write`/`edit` `tool_result` handler in `agent/extensions/engineering-docs/tracking.ts` invokes the read-only `design-adherence.ts` module after tracking side effects. The module builds a cached index from the valid design manifest and declared token files, scans only newly written text, and returns one optional advisory block; tracking appends it to existing tool content without replacing docs-tracking behavior.
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
