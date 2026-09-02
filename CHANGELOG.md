# Changelog

All notable changes to this project are documented here.

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
