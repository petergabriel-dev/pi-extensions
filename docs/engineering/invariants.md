# Invariants

## Workspace and package boundary

- Workspace scripts, launchers, tests, and extension source must never modify, delete, repoint, or commit inside the active global `~/.pi` source checkout.
- The public identity is `@lopezpetergabriel/pi-extensions@0.1.0`: one package must expose exactly nine extensions, three skills, and two bundled agent definitions. Its allowlist is runtime TS/helpers, workflow template, agent/skill Markdown, engineering docs, README/LICENSE, and required nested READMEs; tests, nested manifests/locks/tsconfigs, clients, Cursor config, `.pi`, `node_modules`, and runtime/user state are forbidden. Packed/unpacked limits are 512 KiB/1 MiB.
- Bundled agents load module-relatively and always participate: default scope is bundled+user, project is bundled+nearest project, and both is bundled then user then project. Later same-name overrides win, while selected unsafe explorer overrides are rejected by validation. The source checkout `.pi/agents` link is dev/project-only, not npm registration.
- Workspace launcher must disable global extension auto-discovery with `--no-extensions` and explicitly load repository package once.
- Versioned `.pi/` content is limited to internal `agents` symlink. Credentials, trust/settings/model files, sessions, plans, personal memory, bridge IPC, caches, DBs, logs, dependency trees, and CCC indexes must never enter Git.
- Global auth, settings, model catalogs, sessions, and personal memory remain Pi-owned outside repository. Package may reuse host state through Pi APIs/defaults but must not copy that state into workspace.
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
- Cursor client-side file writes in `.pi` projects must be blocked or reverted by project hooks; native edit reverts must restore exact pre-edit bytes and fail loud.
- Cursor must not introduce a client-side Pi-state write path; Pi state changes still go only through live bridge requests.
- Claude Code Bash in `.pi` projects must not depend on bridge `policy.json` freshness, `planBashAllow`, or any Pi round-trip for allow/deny decisions.
- Claude Code Bash in `.pi` projects must deny `dangerouslyDisableSandbox`; sandbox bypass flags are not allowed in read-only bridge mode.
- When `sandbox-exec` is available, Claude Code Bash must be wrapped through `hookSpecificOutput.updatedInput.command` and allowed only through that Seatbelt sandbox.
- When `sandbox-exec` is unavailable, Claude Code Bash in `.pi` projects must deny closed; there is no unsandboxed allowlist fallback.
- Bridge requests are idempotent by UUID. Replayed request IDs return the processed response and must not duplicate notes or saved plans.
- v1 supports one active Pi bridge session per project. A second active watcher must become passive/refuse rather than process the same request stream.
- `save_plan` must update live `workflow-modes` state, not only append a raw `workflow-plan` entry.
- Saved plans belong only to selected Pi session ancestry. `workflow-modes` must append a `workflow-plan` save/clear entry before changing live state, reconstruct from `getBranch()` on session start/tree navigation, and never read or write repository- or Git-branch-scoped plan files.
- Bridge recall must obtain saved-plan state only from live `workflow-modes`; no bridge cache or direct plan-file fallback is allowed.
- Bridge workflow prompts must use `workflow-modes` prompt composition with live `cavemanEnabled`; bridge clients must not copy Caveman text or import Pi code.
- Docs tag validation must use Pi `engineering-docs` validation logic; bare `[DOCS]` is invalid and `[DOCS:decisions]` requires an ADR action tag.
- Bridge capture protocol primary field is `sessionId`; `claudeSessionId` remains a deprecated alias and must keep working for existing Claude Code callers.

## Discussion notes

- `discussion-notes` is sole owner of active note arrays, IDs, snapshots, and Notes UI. Other extensions must request changes over `discussion-notes:add`; they must not import mutable note state.
- Active notes belong to selected Pi session ancestry. Session start/tree navigation must reconstruct from valid `discussion_notes` tool-result details and `discussion-notes` custom entries; no repository/global note file participates.
- Event/manual note additions must append owner snapshot before returning success. Persistence failure must restore previous notes/next ID and surface an error.
- Tool-result and custom-entry snapshots must preserve schema version, complete active notes, and next ID so branch replay is deterministic.
- Note input must use a supported type, non-empty normalized text, 480-character maximum, branch limit, and type/text deduplication.
- Discussion-note capture must not write project docs or user-global personal memory. Promotion to either store is a separate explicit action.

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
- Discuss, Plan, Build, Review, and Design compose their workflow prompt with Caveman when enabled and the explicit normal-style override when disabled.
- Off must inject neither Caveman nor normal-style override. It retains branch preference for the next active workflow mode and reports that preference as inactive.

- Design write/edit gates fail closed: missing, unreadable, or invalid design manifest permits only `docs/design/**`; only validated manifest `tokenFiles` may extend this surface. Design never permits `docs/engineering/**` writes.

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

- `spawn_worker` must query live workflow mode through the event bus before spawning and must refuse unless mode is `build`. This gate lives in the parent tool because worker children have coding tools.
- Child sessions must not inherit the parent workflow-modes `tool_call` hook. `runSubagent()` uses a `DefaultResourceLoader` with `noExtensions: true`, and the parent performs the worker build-mode check before child creation.
- Explorer tools are read-only by construction. `spawn_explorer` refuses agent definitions whose tools include anything outside `read`, `grep`, `find`, and `ls`.
- Only a child subagent's final structured return may enter parent context. The child transcript remains in the persisted child session and is not appended to the parent branch.
- Spawn graph is bounded to `main -> worker -> explorer`, max depth 2. Workers receive nested `spawn_explorer`; workers do not receive `spawn_worker`; explorers receive no spawn tools.
- Global subagent concurrency defaults to 3 via the default lane. Nested worker-spawned explorers use the reserved explorer lane so workers cannot deadlock waiting on default worker slots.
- Parallel worker file ownership must not overlap. `spawn_worker` refuses an overlapping `fileOwnership` request while another worker owns the same path/subtree.
- Progress widget updates must be keyed by `subagents-progress`, throttled to 250 ms, and cleared when all runs finish.
- Subagent idle timeout must measure time since the last child event, not time since spawn. `runSubagent()` in `agent/extensions/subagents/spawn.ts` must call `watchdog.touch()` for every child `AgentSessionEvent`, so `message_update` streaming and tool lifecycle activity cannot trip idle timeout while active.
- Subagent `maxTotalMs` is an absolute backstop and must not be reset by child events. `createSubagentWatchdog()` in `agent/extensions/subagents/timeout.ts` arms it once and only resets the idle timer from `touch()`.
- Role-agent timeouts are global-only: explorer, nested explorer, worker, and debug-run resolve the same validated `subagents` policy. Public role-agent schemas expose no `timeoutMs`, `idleTimeoutMs`, or `maxTotalMs`; invalid, out-of-range, or inverted settings fall back together to 600,000ms idle / 1,200,000ms max-total (`agent/extensions/subagents/timeout-policy.ts`, `agent/extensions/subagents/index.ts`).
- Timed-out subagent failures must preserve recoverable child text and include structured `failureKind` plus `partialWork`; `hasPartialWork()` in `agent/extensions/subagents/spawn.ts` becomes true once any child tool execution has started.

## Engineering docs extension

- `docs/design/` writes allow only Design/Build/Off; `docs/engineering/` writes remain Build/Off-only. Unknown mode fails closed for both.
- Design manifest `tokenFiles` is sole permission to write token files outside `docs/design/` in Design mode.

- Root entrypoint spokes (`AGENTS.md`, `CLAUDE.md`) must never overwrite content outside the managed `pi-docs` marker block.
- Spoke bodies must remain pure pointers to canonical `docs/engineering/` paths; do not add generated project facts or summaries to spokes.
- Spoke generation and repair must be idempotent: reruns must not duplicate marker blocks or change bytes when content is already current.

## Memory architecture

- Project truth belongs in `docs/engineering/` and ADRs, not in private agent-only stores.
- Cross-repo personal memory lives only under `~/.pi/memory/` as slugged markdown entries plus generated `MEMORY.md`; legacy `~/.pi/memory.md` is migration input only.
- Only files with conforming `---` frontmatter (`name`, `description`, `metadata.type`) are indexed as personal-memory facts; non-conforming legacy files are ignored and preserved.
- Legacy flat-file migration completion is signalled by renaming `~/.pi/memory.md` to `~/.pi/memory.md.bak`; a pre-existing `~/.pi/memory/` directory must not block migration.
- `/remember <text>` writes through the indexed store and rebuilds `MEMORY.md`; it must not modify engineering docs.
- `before_agent_start` may inject only the personal-memory index, not full entry bodies.
- `capture_note` updates live discussion notes and the Notes widget only; it must not write project docs or personal memory.
- `recall_memory` returns engineering docs plus the personal-memory index. It must not depend on deleted memory indexes, model retrieval, or full personal-memory body injection.
- `recall_memory_entry` / bridge `recall_entry` must validate slug input and fetch only one entry from `~/.pi/memory/`.
- `save_memory` must write one slug entry through `writeMemoryFact` and regenerate `MEMORY.md`.
- Project facts and decisions discovered during implementation should be captured in engineering docs tasks/ADRs, not `/remember` or `save_memory`.
