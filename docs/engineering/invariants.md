# Invariants

## Workspace and package boundary

- Workspace scripts, launchers, tests, and extension source must never modify, delete, repoint, or commit inside the active global `~/.pi` source checkout.
- The public identity is `@lopezpetergabriel/pi-extensions@0.6.0`: one package must expose exactly eleven extensions, four skills, and two bundled agent definitions. Its allowlist is runtime TS/helpers, workflow template, agent/skill Markdown, engineering docs, README.md, LICENSE, CHANGELOG.md, and required nested READMEs; tests, nested manifests/locks/tsconfigs, clients, Cursor config, `.pi`, `node_modules`, and runtime/user state are forbidden. Packed/unpacked limits are 512 KiB/1 MiB.
- Bundled agents load module-relatively and always participate: default scope is bundled+user, project is bundled+nearest project, and both is bundled then user then project. Later same-name overrides win, while selected unsafe explorer overrides are rejected by validation. The source checkout `.pi/agents` link is dev/project-only, not npm registration.
- Workspace launcher must disable global extension auto-discovery with `--no-extensions` and explicitly load repository package once.
- `ask-user-question` is sole owner of model-initiated UI serialization. Its module-local FIFO queue permits one `ctx.ui.custom` call at a time; Escape cancels the whole queued batch, while Skip resolves only the current question.
- Context defer is TUI-only and answer-driven: known usage above `contextWindow - 16,384` records one bounded batch, aborts once after the question queue drains, and resumes through one fresh user turn. Every deferred tool call must retain a matching `tool_result`; no agent run may produce more than one defer marker/abort.
- Select TUIs in `ask-user-question` must not bind letter keys as commands; every command gesture must remain visible in its hint or list rows.
- Versioned `.pi/` content is limited to internal `agents` symlink. Credentials, trust/settings/model files, sessions, plans, personal memory, bridge IPC, caches, DBs, logs, dependency trees, and CCC indexes must never enter Git.
- Global auth, settings, model catalogs, sessions, and personal memory remain Pi-owned outside repository. Package may reuse host state through Pi APIs/defaults but must not copy that state into workspace.
- Extension source reaches Pi host APIs only through static bare imports. Host-owned directories are resolved at extension boundaries with `getAgentDir()` and passed as required arguments to pure stores; `createRequire` and variable-specifier host `import()` are forbidden.
- Package-owned source/assets must resolve from repository/module location. No machine-specific absolute source path or dependency on active `~/.pi` source is allowed.
- Every versioned symlink must resolve inside repository. External authored-resource symlinks are excluded until explicitly added to manifest and integrity checks.
- Runtime bridge state under `.pi/memory/bridge/` is ephemeral and ignored. Shutdown may leave ignored directories, but no request, response, processed cache, lock, or policy file may be treated as source.

## Pi ↔ Claude Code bridge

- Client-side bridge code must have zero Pi internal imports. `agent/claude-bridge-client/*` and `agent/cursor-bridge-client/*` use Node stdlib/file IPC or hook input only.
- Pi bridge extension is the only Pi-coupled bridge layer and must reuse/export real sibling extension functions instead of copying logic.
- `capture_note` success requires active Pi bridge response and `widgetUpdated:true`; no silent queue or later replay is considered success.
- `capture_note` must be applied by the live `discussion-notes` extension instance through the event bus; the bridge must not import/render private discussion-notes state.
- Bridge tools fail loudly if Pi bridge is down or stale. No direct memory-file fallback is allowed.
- `.pi` marker presence is the only condition for Claude Code read-only enforcement.
- Claude Code mutation tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) are always denied in `.pi` projects.
- Cursor `Write` tool calls in `.pi` projects must be denied by the project `preToolUse` hook before execution, using Cursor's `permission: "deny"` output; no Cursor hook may write or revert files.
- Cursor must not introduce a client-side Pi-state write path; Pi state changes still go only through live bridge requests.
- Claude Code Bash in `.pi` projects must not depend on bridge `policy.json` freshness, `planBashAllow`, or any Pi round-trip for allow/deny decisions.
- Claude Code Bash in `.pi` projects must deny `dangerouslyDisableSandbox`; sandbox bypass flags are not allowed in read-only bridge mode.
- When `sandbox-exec` is available, Claude Code Bash must be wrapped through `hookSpecificOutput.updatedInput.command` and allowed only through that Seatbelt sandbox.
- When `sandbox-exec` is unavailable, Claude Code Bash in `.pi` projects must deny closed; there is no unsandboxed allowlist fallback.
- Bridge requests are idempotent by UUID. Replayed request IDs return the processed response and must not duplicate notes or saved plans.
- v1 supports one active Pi bridge session per project. A second active watcher must become passive/refuse rather than process the same request stream.
- `save_plan` must update live `workflow-modes` state, not only append a raw `workflow-plan` entry; it writes the same session-scoped body and seeds the same tasks as `/plan save`.
- Saved-plan pointers, active selection, and task progress belong only to selected Pi session ancestry. `workflow-modes` must append the durable `workflow-plan` set/activate/clear/tick entry before changing live state and reconstruct from `getBranch()` on session start/tree navigation.
- `workflow_plan_tick` accepts exactly one bounded `taskId` or `title`; titles match only after whitespace normalization, unknown/ambiguous references reject, completed tasks are idempotent, and out-of-order ticks are accepted but flagged. The durable tick entry must precede live state updates, and saved plan bodies remain immutable.
- Session-start reconstruction of mode and plan state must complete synchronously before asynchronous plan-file GC; maintenance must never expose default mode or empty plan state to later hooks.
- Plan bodies live only under `<agentDir>/plans/<sessionId>/<planId>.md`; paths derive from validated session/plan identifiers, writes are atomic and bounded to 256 KiB, missing reads degrade to no active plan, and referenced files are never deleted. Repository-, Git-branch-, and bridge-scoped plan files are forbidden; current-session GC may remove only unreferenced files older than the retention period.
- Bridge recall must obtain saved-plan state only from live `workflow-modes`; no bridge cache or direct client-side plan-file fallback is allowed. Bridge `read_plan_tasks` and `tick_plan_task` must use the live workflow owner and preserve UUID idempotency.
- Bridge workflow prompts must use `workflow-modes` prompt composition with live `cavemanEnabled`; bridge clients must not copy Caveman text or import Pi code.
- Docs tag validation must use Pi `engineering-docs` validation logic; bare `[DOCS]` is invalid and `[DOCS:decisions]` requires an ADR action tag.
- Bridge capture protocol primary field is `sessionId`; `claudeSessionId` remains a deprecated alias and must keep working for existing Claude Code callers.

## Discussion notes

- `discussion-notes` is sole owner of active note arrays, IDs, snapshots, and Notes UI. Other extensions must request changes over `discussion-notes:add`; they must not import mutable note state.
- Active notes belong to selected Pi session ancestry. Session start/tree navigation must reconstruct from valid `discussion_notes` tool-result details and `discussion-notes` custom entries; no repository/global note file participates.
- Event/manual note additions must append owner snapshot before returning success. Persistence failure must restore previous notes/next ID and surface an error.
- Tool-result and custom-entry snapshots must preserve schema version, complete active notes, and next ID so branch replay is deterministic.
- Note input must use a supported type, non-empty normalized text, 480-character maximum, branch limit, and type/text deduplication.
- Filtered model-visible note listing must paginate at no more than 50 notes and stay within Pi's 50 KiB tool-output limit; unfiltered list calls remain count-only in model-visible content.
- Discussion-note capture must not write project docs or user-global personal memory. Promotion remains a separate explicit action.
- `/notes promote` may send only active `lesson` notes, must treat bodies as untrusted data, and must target current-project canonical engineering docs only. Build/Off may persist; every other mode proposes changes without claiming promotion.

## File-change tracking and rollback

- `filechanges` tracks only successful Pi `edit`/`write` results. Failed tool results must discard pending preimages and must never establish baselines.
- Pending preimages are keyed by tool-call ID. First successful tracked mutation establishes immutable original content for that path until clear/untrack; later diffs remain cumulative against that first baseline.
- Baseline, clear, and untrack state belongs to selected Pi session ancestry and must reconstruct on session start/tree navigation. No repository log file may become source of truth.
- Accept keeps current filesystem bytes and clears tracking. Decline requires interactive confirmation or explicit `force`, deletes files that did not exist at baseline, and restores existing files to recorded original UTF-8 content.
- Decline failures must be reported per file and must never be presented as full success. Accept/decline must not stage, commit, or alter unrelated Git state.
- File-change UI must not claim complete filesystem coverage: mutations outside observed Pi `edit`/`write` calls do not establish new baselines.

## Workflow modes Caveman composition

- `workflow-modes` is the sole Caveman owner. The standalone `caveman-mode` extension must not exist or register a second `/caveman` command.
- Caveman preference is selected-session-branch state using the stable `caveman-mode-state` custom entry. No explicit entry means ON; latest valid ancestral entry wins.
- All five active modes compose the shared question-tool fragment between the authoritative header and mode prompt, followed by Caveman when enabled or the explicit normal-style override when disabled.
- `workflow-modes` names `ask_user_question` only in prompt text and must never import `ask-user-question`.
- Off must inject neither question-tool fragment, Caveman, nor normal-style override. It retains branch preference for the next active workflow mode and reports that preference as inactive.

- Design write/edit gates fail closed: missing, unreadable, or invalid design manifest permits only `docs/design/**`; only validated manifest `tokenFiles` may extend this surface. Design never permits `docs/engineering/**` writes.

## Workflow modes announcement channel

- State enforced at the tool boundary must be announced in the same LLM message channel where enforcement errors appear: `agent/extensions/workflow-modes/index.ts` `before_agent_start` regenerates a hidden active-mode message every user turn, while `setMode` sends one transition message for Off, which has no per-turn prompt.

## Workflow modes state channel

- `workflow-modes:get` / `workflow-modes:state` is a caller-independent read broadcast: its state payload must not require a correlation ID or contain caller-specific data, so one response can serve every listener (`agent/extensions/workflow-modes/index.ts:763-779`). This does not relax correlation for mutations; save-plan and task-tick request/result channels still require `requestId` (`agent/extensions/workflow-modes/index.ts:744-752`, `agent/extensions/workflow-modes/index.ts:794-798`; `docs/engineering/conventions.md:22`).

## Workflow modes read-only Bash

- Discuss/Plan/Design Bash must prefer structural sandbox wrapping over regex gating. Regex allow/deny policy is fallback only when no launcher exists or wrapping fails.
- Discuss/Plan structural Bash must deny network access. All structural read-only Bash must deny writes to the repo and `$HOME` while allowing reads, read-only interpreters, and writes under scratch `TMPDIR`.
- Scratch paths used in sandbox profiles must be resolved through real paths when they already exist, because macOS `/tmp` paths resolve under `/private/var`.
- With no sandbox launcher, `wrapCommand()` must return the original command with `wrapped:false`; callers must then apply conservative policy and must not treat this as approval.
- Review filesystem remains read-only; network is enabled only for commands admitted by the review allow-list and not denied by review/common denies, with policy enforced before sandbox wrapping and again on fallback.
- Review sandbox must omit only network denial, never Seatbelt file-write denial or Bubblewrap's read-only root bind.
- No-launcher or wrapping failure remains a conservative policy fallback and must not fail open beyond the explicit allow-list.
- Behavioral sandbox tests must cover repo read, scratch write, repo write denial, network denial, and interpreter read when a real launcher is present.

## Pi subagents

- Parent `subagent` resolves live workflow state before launch. Outside Build, `validateSubagentToolset()` fails closed and permits only repository read-only tools, `ask_question`, optional nested `subagent`, and read-only browser proxies; Build bypasses this gate. Only new launches are gated, so in-flight children survive mode changes (`agent/extensions/subagents/index.ts`, `agent/extensions/subagents/policy.ts`).
- Child capability is loadout-authoritative. `SubagentLaunchHost` writes loadouts under Pi-owned runtime state with mode `0600`, then launches `pi --no-extensions -e agent/extensions/subagents/child.ts`; resume reuses the same toolset, prompt, session, depth, nested allowlist, and ownership snapshot (`agent/extensions/subagents/launch.ts`).
- Every IPC frame uses the per-session random token, owner, correlation ID, and 4-byte length prefix. Invalid/unauthenticated frames are dropped; unknown owners and correlation mismatches do not reach child/browser operations (`agent/extensions/subagents/ipc.ts`).
- One parent IPC listener initialization uses one memoized in-flight promise, so concurrent launch/resume calls perform one bind. Listen/setup failure closes the server, removes its socket, clears the memo, and leaves the host retryable (`agent/extensions/subagents/ipc.ts`, `agent/extensions/subagents/launch.ts`).
- Explorer definitions cannot include repository-mutating tools. Browser proxy tools are mode-scoped at launch: restricted modes receive console/screenshot/network only, and parent forces console/network buffer `clear=false`; Build may receive the full proxy set (`agent/extensions/subagents/policy.ts`, `agent/extensions/subagents/index.ts`, `agent/extensions/subagents/child.ts`).
- Only final child result text is steered into parent context. Child messages, questions, browser calls, nested spawns, and ownership requests remain on authenticated IPC; child transcript remains in its separate session (`agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/child.ts`).
- Nested spawn is bounded by `subagent_agents:` allowlists and maximum depth two. Explorers are leaves; a requested agent outside its allowlist or above depth cap is refused (`agent/extensions/subagents/agents.ts`, `agent/extensions/subagents/policy.ts`).
- Global child concurrency uses one configurable default lane with capacity three; no reserved explorer lane exists (`agent/extensions/subagents/concurrency.ts`).
- Only repository-mutating children acquire ownership locks; normalized ownership paths/globs cannot overlap across active owners. Locks release on result, exit, disconnect/crash, cancellation, or host close (`agent/extensions/subagents/policy.ts`, `agent/extensions/subagents/ownership.ts`, `agent/extensions/subagents/launch.ts`).
- Progress uses keyed `subagents-progress` widget updates throttled to 250ms; each production run identifies cmux transport and its runtime log; terminal states remove entries and clear widget when no runs remain (`agent/extensions/subagents/progress.ts`).
- Every run owns one Pi-runtime diagnostics log under `<agentDir>/subagents/<parent-session>/`, with directory mode `0700`, file mode `0600`, a 1 MiB persistent cap, an 8 KiB recent-output cap, exact IPC-token redaction, and no full environment/auth capture. Healthy cmux runs write no child output to this log; child stdout/stderr and failed cmux screen output are bounded. Classified failures expose cmux transport, log path, error, and tail once, while cmux surfaces still auto-close (`agent/extensions/subagents/diagnostics.ts`, `agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/cmux.ts`).
- Watchdog idle/max-total budgets count active time. Child `ask_question` changes status to waiting and pauses both timers; answer/cancel resumes or releases it. Throttled child activity heartbeats from `tool_execution_start`, `tool_execution_update`, and `message_update` touch the idle timer; silent active work can still time out (`agent/extensions/subagents/child.ts`, `agent/extensions/subagents/timeout.ts`, `agent/extensions/subagents/launch.ts`).
- IPC request deadlines remain bounded by default. Only explicitly marked `question` and nested `spawn` requests may use no-deadline client waits; disconnect, close, cancellation, and owner reaping reject every pending request and clear timers (`agent/extensions/subagents/ipc.ts`, `agent/extensions/subagents/child.ts`).
- Timeout policy is global-only and validated together: invalid, out-of-range, or inverted settings fall back to 600,000ms idle / 1,200,000ms max-total (`agent/extensions/subagents/timeout-policy.ts`).
- Timeout values are not public spawn parameters. Parent resolves `subagents.idleTimeoutMs` and `subagents.maxTotalMs` from settings once per host; invalid, out-of-range, or inverted values use the shared defaults (`agent/extensions/subagents/index.ts`, `agent/extensions/subagents/timeout-policy.ts`).
- Watchdog timeout rejects active child result, terminates its process/surface, reaps browser page, releases ownership and concurrency slot, and marks parent record failed (`agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/index.ts`).
- Per-role subagent effort remains settings-only: public spawn schemas expose no effort parameter; absent `subagents.effort[role]` inherits parent thinking level, invalid values fall back to inherit (`agent/extensions/subagents/effort.ts`, `agent/extensions/subagents/index.ts`).
- Production child launches omit `--print`, require cmux, classify binary/socket/auth/surface failures, and require authenticated child `hello` within a bounded 30-second handshake deadline; hello or any terminal settle/failure/abort clears that deadline. They steer cached `agent_end` text only after `agent_settled`; explicit `spawnProcess` injection remains test-only (`agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/cmux.ts`, `agent/extensions/subagents/child.ts`).

## Engineering docs extension

- `docs/design/` writes allow only Design/Build/Off; `docs/engineering/` writes remain Build/Off-only. Unknown mode fails closed for both.
- Design manifest `tokenFiles` is sole permission to write token files outside `docs/design/` in Design mode.

- Root entrypoint spokes (`AGENTS.md`, `CLAUDE.md`) must never overwrite content outside the managed `pi-docs` marker block.
- The managed spoke block remains a pure pointer to canonical `docs/engineering/` paths; hand-written workflow discipline may live outside markers but must not add generated project facts or summaries.
- Spoke generation and repair must be idempotent: reruns must not duplicate marker blocks or change bytes when content is already current, and must preserve hand-written content outside markers.

## Memory architecture

- Project truth belongs in `docs/engineering/` and ADRs, not in private agent-only stores.
- Cross-repo personal memory lives only under `~/.pi/memory/` as slugged markdown entries plus generated `MEMORY.md`; legacy `~/.pi/memory.md` is migration input only.
- Only files with conforming `---` frontmatter (`name`, `description`, `metadata.type`) are indexed as personal-memory facts; non-conforming legacy files are ignored and preserved.
- Legacy flat-file migration completion is signalled by renaming `~/.pi/memory.md` to `~/.pi/memory.md.bak`; a pre-existing `~/.pi/memory/` directory must not block migration.
- Bare `/remember` and `/remember <text>` start the same visible user-global curation flow; text is prefilled input, and the first response must not write memory.
- `/remember` must exclude/report project-specific facts and must not modify engineering docs. Persistence requires a later successful `remember` tool result.
- `remember` without a slug remains backward-compatible; an explicit slug must pass `validateSlug`, replace that exact indexed entry, serialize in-process writes around `MEMORY.md`, and regenerate the index.
- `before_agent_start` may inject only the personal-memory index, not full entry bodies.
- `capture_note` updates live discussion notes and the Notes widget only; it must not write project docs or personal memory.
- `recall_memory` returns engineering docs plus the personal-memory index. It must not depend on deleted memory indexes, model retrieval, or full personal-memory body injection.
- `recall_memory_entry` / bridge `recall_entry` must validate slug input and fetch only one entry from `~/.pi/memory/`.
- `save_memory` must write one slug entry through `writeMemoryFact` and regenerate `MEMORY.md`.
- Project facts and decisions discovered during implementation should be captured in engineering docs tasks/ADRs, not `/remember` or `save_memory`.
