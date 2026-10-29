# Changelog

All notable changes to this project are documented here.

## [Unreleased]

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
