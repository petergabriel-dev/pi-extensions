# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.14.0] - 2026-11-12

### Added

- Bridge request lifecycle (ADR-0054): a request moves `requests/` → `inflight/` (Pi claims it by atomic rename, so overlapping scans never run one request twice) → `processed/` + `responses/`. A 500 ms poll backs up `fs.watch`, claimed files over 1 MiB are answered `payload_too_large` unread, and answers are kept 10 minutes so a repeated request ID is replayed, not re-run.
- Two-stage client deadlines for Claude, Cursor, OpenCode, and Codex. Pi must claim a request within the pickup deadline (default 2 s, `PI_BRIDGE_PICKUP_TIMEOUT_MS`), or the client withdraws it and reports `not_delivered`. A claimed request with no answer by the completion deadline (default 30 s, `PI_BRIDGE_COMPLETION_TIMEOUT_MS`) is `outcome_unknown`, never bridge-down. Pi also answers `outcome_unknown` for requests a crash left in flight (never re-run) and for timed-out write-side waits. Reads answered `outcome_unknown` are re-sent once; writes never are.
- Budgeted, query-ranked recall. `recall` returns the requested mode's prompt, the saved plan and lease, a one-line doc index, and the best-matching doc sections and personal-memory entries (BM25) within a 32 KB default budget (`PI_BRIDGE_RECALL_BUDGET_BYTES`). Sections carry `path` and a line range for follow-up reads. `recall_memory` returns compact text only. Recall in this repository drops from about 723 KB to about 32 KB.
- Bridge health: a 500-entry `health.jsonl` ring (codes, timings, sizes, and `replay`/`retry` flags only; no payloads or ids) and `/bridge-health`, which prints p50/p95 latency and response size per request type plus withdrawn, `outcome_unknown`, replay, restart-conversion, slow-completion, and client read-retry counts.
- Cross-process bridge e2e (`test:bridge-e2e`) in CI: a real headless Pi in RPC mode, driven through the real MCP client, with a Build lease approved through Pi's own confirm dialog and injected faults.

### Changed

- An identical bridge `save_plan` returns the active plan with `idempotent: true` instead of writing a second plan, unless the caller names a different `planId`. Pi-native saves are unchanged.

### Fixed

- The doc index no longer starves ranked recall. A build-mode recall with a large saved plan returned no doc sections; packing now reserves room for sections before the index. A query that matches nothing falls back to the `invariants.md` sections.
- Request-queue claim edge cases: a same-ID duplicate waits and is replayed instead of running twice, a scan with a stale listing writes nothing, and a request file that is not a regular `0600` file is answered `invalid_request` instead of being dropped silently.
- The bwrap sandbox mounts a fresh `/dev`, so login-shell profiles and sandboxed git reads no longer fail on `/dev/null` with "Permission denied" on current Ubuntu runners. The root stays read-only.

### Known issues

- Plan state saved and ticked through the bridge stays in memory until the Pi session's first assistant message, because Pi writes no session file before then. Restarting such a session loses it; git commits remain the record.

### Upgrade

- Installs pinned to a version need `pi install npm:@lopezpetergabriel/pi-extensions@0.14.0`.
- Restart Pi, and any open Claude, Cursor, OpenCode, or Codex session, so both the bridge and its clients load the new code. Until Pi restarts, its namespace has no `inflight/`, so clients fall back to legacy mode (one 2 s deadline, no withdraw) and recall stays unbudgeted.

## [0.13.0] - 2026-11-05

### Added

- `impeccable` Direction playbook (`agent/skills/impeccable/references/direction.md`), the single redesign rulebook: Redesign target, design-input order (snapshot, optional `prototype` and pick, specs/tokens, components, cleanup), 2–3 named directions that differ pairwise on at least two axes, Design deltas, and relative links to six design skills. Plan's short `PLAN_DESIGN_DIRECTION_PROMPT` trigger points at it (ADR-0053).
- Plan template Redesign target section, `Design delta` component field, reuse/restyle/replace/new base components, and a `[DOCS:design]` tag row (ADR-0053).

### Changed

- Ponytail minimalism in Discuss, Plan, Build, and worker delegation now governs code, wiring, dependencies, and structure, not visual design; fidelity to a confirmed design target is non-negotiable (ADR-0053).
- A confirmed redesign target wins over existing components and tokens by promotion into `docs/design/` specs first; design inputs are step 0 of the plan task order; Build routes `[DOCS:design]` tasks to `docs/design/`, snapshots out-of-repo targets inside the first design task, deletes superseded parts only in a scheduled cleanup task after a broad reference search, and verifies redesigns against target HTML or each Design delta (ADR-0053).
- Harness plan commands for Claude, Cursor, OpenCode, and Codex name `[DOCS:design]`; prompt budget tests ignore checkout path length (ADR-0053).
- `impeccable` polish defers identity and reuse-first to a confirmed redesign's saved spec while still refusing unplanned redesign (ADR-0053).

## [0.12.0] - 2026-11-04

### Added

- Codex harness peer for the Codex CLI and desktop app (ADR-0052): `codex` bridge harness kind and Build-lease peer, a fail-closed PreToolUse hook (`agent/codex-bridge-client/pi-codex-hook.js`) with host `session_id` injection for bridge calls and `apply_patch` target checks (a patch into any Pi project needs that project's lease, wherever the session started), and explicit-only `$pi-discuss`, `$pi-plan`, `$pi-build` skills.
- `/harness` manages Codex under `CODEX_HOME` (default `~/.codex`): a guarded `hooks.json` hook in its own group, only the `[mcp_servers.pi-claude-bridge]` table in `config.toml` (other bytes untouched; new file `0600`), and 26 skill links, with a re-trust reminder when hooks change (on install and uninstall). An `mcp_servers` set as one value or as `[[mcp_servers]]` is skipped, never edited.
- Security corpus Codex column scored by Codex's own hook semantics, plus a `silent` crash variant for every harness.

### Fixed

- `/harness` no longer backs up symlinks: a sibling `<name>.harness-bak-<ts>` link loaded as a duplicate skill. The preview diff and results show each link's previous target; regular-file backups are unchanged.
- `/harness` Install / repair and Uninstall remove `.harness-bak-` links left by earlier versions when they point at a Pi package; backup-named files and other links stay.
- Claude Pi hooks now get their own hook group without a `matcher`. Earlier installs could join a foreign group whose `matcher` (for example `Bash`) narrowed the read-only guard; inspection flags such a hook and Install / repair moves it. A `.*` matcher counts as matching every tool.
- `/harness` and the startup check report old `.harness-bak-` links as a warning, so upgraded installs are told to run Install / repair.
- The `/harness` preview warns for Claude and Codex, as well as Cursor, to uninstall before `pi remove`, since their fail-closed hooks block tools once the package is gone. The Cursor warning named a `/harness uninstall cursor` command that does not exist; it now names the menu path.
- Plan template: the Definition of Done line for `[LOAD-BEARING]` tasks now matches Build (invariants restated before editing, each verified before commit), and the tag is defined.

### Upgrade

- Installs pinned to a version (for example `npm:@lopezpetergabriel/pi-extensions@0.11.0`) need `pi install npm:@lopezpetergabriel/pi-extensions@0.12.0`; then restart Pi.
- After updating, run `/harness` Install / repair once per harness to remove old backup links and move a misplaced Claude hook, then restart the harness.
- Trust the Pi hook in each Codex surface you use (CLI `/hooks`, desktop Settings > Hooks), and only that hook. Commits from `$pi-build` need Codex approval because its sandbox keeps `.git` read-only.

## [0.11.0] - 2026-11-03

### Breaking

- Remove Design workflow mode. Plan now owns frozen frontend component specs; Build writes design docs/tokens in Build/Off and implements specs literally.

### Added

- Bundle 19 pinned Markdown-only design and verification skills with license notices; `/harness` manages all 23 package skills as harness-specific directory links.
- Add optional trimmed 1–500 character notes to `workflow_plan_tick` and bridge `tick_plan_task`.

### Changed

- Build prompts require reviewed screenshots against frontend specs and `web-design-guidelines` before claiming visual verification; unavailable browsers use an honest `unverified:` tick note.
- Raise the package unpacked-size limit to 2 MiB; packed-size limit remains 512 KiB.
- Make existing package skills describe non-Pi tool fallbacks while preserving Pi behavior.

### Fixed

- Enforce one writer per project across Pi, Claude, Cursor, and OpenCode sessions: Build entry, lease requests, task ticks, and writes are refused while another live session claims the project; hook denials name the conflict.
- Restore workflow state fail-closed: unreadable session state opens as read-only Unknown, restored Build sessions land in Plan, and active plans load before mode announcement.
- Without a sandbox, Bash never auto-runs; Plan and Review ask approval per permitted command. Build's writer check also covers non-read tools, including unknown tools and subagents.
- Command confirmation dialogs visibly escape invisible Unicode and mark runs of four or more blank characters.
- Cursor read-only shell commands require explicitly safe-listed flags; unquoted globs trigger approval.
- In Pi projects, bridge startup errors and passive bridges block Build; abandoned namespaces are reclaimed, and heartbeat write failures retry without ending the bridge.
- Plan saves verify session state is readable before writing the plan file.

### Upgrade

- After `pi update`, restart Pi and harness sessions; rerun `/harness` → Install / repair.
- Sessions saved in Design mode open read-only (Unknown) until a supported mode is selected.
- Expect more Bash approval prompts when no sandbox is available.

## [0.10.0] - 2026-10-29

### Added

- `/docs pull-design` snapshots linked Open Design projects into `docs/design/reference/open-design/<slug>-<id8>/`: read-only discovery, an interactive one/all picker with replace confirmation, bounded HTML/Markdown/artifact copies, and a headless listing mode.

### Changed

- Review-mode `gh pr review` and `gh pr comment` commands require per-command Pi confirmation; headless Pi, declined confirmation, or confirmation failure blocks posting.
- Pi read-only Bash deny list blocks `$(…)`, backticks, `xargs`, `find -exec` variants, `git apply`/`git am`/`git config`, `git diff --output`, and `awk system()`.
- Seatbelt profiles deny `appleevent-send`.

### Fixed

- Home `~/.pi` (Pi's global agent dir) no longer marks a project, so harnesses started under `$HOME` without a nearer marker are not treated as read-only Pi projects.
- Dedicated edit tools now resolve their target's nearest Pi root: writing into another Pi project requires that project's own Build lease, and relative or symlinked targets cannot bypass the check.

### Upgrade

- Restart Pi and harness sessions after `pi update`; no `/harness` rerun is needed.
- Pi started outside a project under `$HOME` no longer loads the bridge.
- Edit tools in sessions started outside a Pi project cannot write into Pi repos without that repo's Build lease.

## [0.9.2] - 2026-10-21

### Changed

- External `/pi-build` leases need human approval: the first build recall returns `build_lease_pending`; run Pi `/build-lease approve` for the shown short id, then rerun. Headless Pi returns `build_lease_no_approval`.
- Leases expire 4 hours after grant; unpairing the holder revokes it; only the holder can tick plan tasks (`build_lease_required`). `/build-lease` shows remaining time and pending requests.
- Claude PreToolUse hook asks on unknown tools, `Task`/`Agent`, and foreign MCP tools; hook errors deny.
- Cursor shell commands are classified per segment against a read allowlist; dynamic syntax, interpreters, and unknown commands ask; unknown `preToolUse` tools deny.
- OpenCode plugin passes only read, bridge, sandboxed shell, and Code Mode tools; others throw.

### Fixed

- Claude and Cursor hooks bind Pi bridge MCP identity to the host session; forged `sessionId`/`harness` arguments deny.
- `/harness` adds `|| exit 2` to the Claude PreToolUse hook so a hook that cannot start blocks the call.

### Upgrade

- Rerun `/harness` → Install / repair for Claude (inspection reports `unguarded-hook`). Leases from before 0.9.2 (no `expiresAt`) are not honored; request and approve a new one.

## [0.9.1] - 2026-10-21

### Fixed

- Retarget owned `/harness` command/plugin symlinks from other package roots, including dangling links.

## [0.9.0] - 2026-10-21

### Added

- Add `/harness` to inspect, install/repair, and uninstall Claude, Cursor, and OpenCode setup.
- Add optional `docs/design/reference/` context to Build and Design prompts.
- Add `/agents` TUI overlay for recent/live child activity, pending-question answers, and steering running children.
- Add a single-owner child-question relay through the shared `ask-user-question` FIFO, with source-scoped cancellation, redacted payloads, and RPC-safe `select`/`input` dialogs.

### Changed

- `/harness` Install / repair replaces hand-copied Pi command files (backed up) with package links.
- Keep `/harness` preview navigation controls visible with arrow and page-key scrolling.
- Prefix shipped Claude, Cursor, and OpenCode workflow command names with `pi-`.
- Allow up to two within-task worker slices for substantial disjoint work; parent waits for all results and owns consolidation, verification, commit, and tick.
- Keep subagent result/failure bodies pending until parent receipt; queue at most one displayed `nextTurn` fallback without auto-starting a turn, and suppress shutdown failure follow-ups.
- Canonicalize writer ownership paths to case-folded real-path keys; warn once per session when local agent definitions shadow bundled keys.
- Enforce read-only full-content decision-index, root-spoke, and ADR freshness in root `npm run check`.
- Route live subagent messages through next-tool-boundary RPC steer; default explorer effort to `low` and prefix/filter bounded child diagnostics safely.

### Fixed

- Restore trusted-project skills for child agents and clarify browser proxy gate usage.
- Flag failed child browser-proxy and nested-subagent calls as tool errors so parent progress shows `error`, not `ok`.

## [0.8.0] - 2026-10-13

### Breaking

- Bridge protocol v2 replaces the single lock with per-session namespaces; 0.7.x and 0.8.0 bridge clients do not interoperate. Re-register clients from the installed 0.8.0 package after upgrading.
- The npm package and stripped `release` branch exclude `docs/engineering/**`.
- Removed `cmux`-based subagent launches in favor of Pi RPC; side-channel tokens are now per-run and owner-bound.

### Added

- Add per-session namespaces plus `list_sessions` and `pair_session`.
- Add peer chat with `send_message`/`read_messages` and Pi-side `bridge_message`.
- Add the Claude peer hook and `Pi ✉N` statusline.
- Include Claude and Cursor bridge clients in the npm package.
- Add a stripped `release` branch for Git installs.

### Changed

- Pairing survives a clean restart of the same Pi session within 10 minutes; a live namespace wins.
- A clean stop retains only `presence.json`.

## [0.7.1] - 2026-09-18

### Added

- Added design-token adherence advisories for successful source writes.

### Changed

- Added design-token advisory architecture docs and ADR-0037.

## [0.7.0] - 2026-09-02

### Breaking

- Replaced the subagent tool surface with asynchronous interactive Pi child processes, authenticated IPC, resumable sessions, and parent-owned browser proxying.
- Made `cmux` required for production subagent launches; missing binaries, surfaces, sockets, authentication, or handshakes now fail with classified diagnostics.

### Added

- Added context-aware `ask-user-question` deferral that preserves answered tool results and resumes after Pi compaction.
- Added subagent runtime diagnostics, transcript-path reporting, opt-in live output tails, activity-aware timeout handling, and messaging/resume support.
- Added neutral Cursor workflow commands, read-only hook enforcement, and docs write-back guidance.

### Changed

- Hardened restricted subagent launches with fail-closed toolsets, nested-agent limits, browser isolation, and parked-question timeout handling.
- Expanded engineering docs and ADRs for async delegation, compaction deferral, subagent policy, and Cursor workflow parity.
- Staged subagent discovery and follow-up handling to keep agent selection and delegation bounded.

## [0.6.0] - 2026-08-27

### Added

- Added `ask-user-question`, a queued question UI with cancellation and selection handling.
- Added browser automation tools for navigation, evaluation, interaction, screenshots, console output, and network inspection.
- Added the `web-debug` skill with reproducible browser-debugging workflows and troubleshooting guidance.
- Added browser-tool access for eligible subagents with per-agent page isolation.

### Changed

- Integrated browser actions with workflow-mode and browser-gate enforcement.
- Strengthened request-header curation, browser lifecycle handling, and read-only explorer access.
- Expanded engineering docs, extension tooling guidance, and cross-harness question prompt guidance.
