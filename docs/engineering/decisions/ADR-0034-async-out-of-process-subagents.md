---
id: ADR-0034
title: Async out-of-process subagents
status: Active
date: 2026-08-30
decision: Run subagents as independent interactive Pi processes behind an authenticated parent-owned IPC host, with loadout snapshots, cmux-required presentation, a bounded 30-second hello handshake, real child transcript-path reporting, settled-only result steering, opt-in live tails, toolset/depth/ownership gates, and parent browser proxying.
why: Separate processes remove stale parent ExtensionAPI coupling and keep delegation non-blocking while preserving bounded capabilities, resumable sessions, browser ownership, and parent context isolation. A bounded handshake turns silent startup hangs into classified failures; transcript paths avoid guessing from child IDs; opt-in tails preserve default list performance while enabling diagnosis.
affects: agent/extensions/subagents/index.ts, agent/extensions/subagents/child.ts, agent/extensions/subagents/ipc.ts, agent/extensions/subagents/launch.ts, agent/extensions/subagents/cmux.ts, agent/extensions/subagents/diagnostics.ts, agent/extensions/subagents/concurrency.ts, agent/extensions/subagents/ownership.ts, agent/extensions/subagents/policy.ts, agent/extensions/subagents/progress.ts, agent/extensions/subagents/timeout.ts, agent/extensions/subagents/test/test_ipc.ts, agent/extensions/subagents/test/test_launch.ts, agent/extensions/subagents/test/test_cmux.ts, agent/extensions/subagents/test/test_interaction.ts, agent/extensions/subagents/test/test_child.ts, agent/extensions/subagents/test/test_progress.ts, agent/extensions/subagents/test/test_tool_surface.ts, agent/extensions/browser/index.ts, agent/extensions/workflow-modes/index.ts, agent/agents/explorer.md, agent/agents/worker.md, agent/skills/worker-orchestration/SKILL.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0004-pi-subagents.md, docs/engineering/decisions/ADR-0007-workflow-modes-subagent-delegation.md, docs/engineering/decisions/ADR-0010-subagent-idle-timeout.md, docs/engineering/decisions/ADR-0031-subagent-browser-access.md, docs/engineering/decisions/ADR-0034-async-out-of-process-subagents.md, docs/engineering/decisions/README.md
consequences: Delegation returns immediately and final text arrives as a parent follow-up; cmux children must handshake within 30 seconds or fail with bounded diagnostics; bounded child transcript paths and opt-in live tails improve diagnosis without reading child sessions into parent context; runtime sockets/loadouts stay in Pi-owned state; child crashes and disconnects can be reaped; nested work, browser pages, ownership paths, concurrency, and timeout budgets remain bounded.
readWhen: changing async child launch, IPC framing/auth, loadout resume, cmux transport, nested agent policy, browser proxy transport, ownership locks, progress, or parked-child timeout behavior
supersedes: ADR-0004
---

# ADR-0034: Async out-of-process subagents

## Decision

- `subagent` resolves the selected agent, live workflow mode, exact tool allowlist, model/effort, depth, nested-agent allowlist, and file ownership before launch. Any mutating toolset requires Build mode.
- `SubagentLaunchHost` writes an atomic `0600` loadout and owns one `0600` Unix socket under Pi runtime state. Frames are 4-byte length-prefixed JSON authenticated by a per-session random token, owner, and correlation ID.
- Children run interactive `pi --no-extensions -e agent/extensions/subagents/child.ts` without `--print`. The child extension registers only loadout-approved tools plus `ask_question`, mode-scoped browser proxies, and allowlisted nested `subagent`. It caches text from extension-level `agent_end`, then steers exactly once on `agent_settled`, after retry, compaction, and queued continuation settle; child transcript stays in its own session.
- `subagent_message` sends live messages, answers parked questions, or resumes the immutable loadout with the same toolset. `ask_question` parks the child and excludes parked time from idle and max-total watchdog budgets.
- cmux is the required production transport. It creates an unfocused named terminal surface and sends the child command only after shell readiness, then requires an authenticated child `hello` within 30 seconds. Missing hello closes the surface and rejects through the classified failure path; binary lookup, socket, auth, and surface failures close partial surfaces and reject with classified errors; `spawnProcess` is reserved for explicit test injection.
- One configurable concurrency lane caps active children at three. Normalized overlapping ownership paths are refused and released on result, exit, disconnect, cancellation, or host close. Nested definitions use `subagent_agents:` and maximum depth two.
- Child sends its session file best-effort in `hello` and authoritatively in `result`; parent retains the last non-empty bounded path while keeping `childSessionId` for correlation. `subagents_list` reports that path and performs no cmux reads by default; `tail: true` reads bounded live output only for running children, with failures isolated per child. Browser tools remain parent-owned: child browser calls travel over IPC to the browser extension event bus, retain child owner keys, and are limited to four pages total. Owner pages are reaped with child lifecycle.

## Why

Separate processes prevent a cached parent extension context from being reused after `/fork`, `/new`, session switching, or `/reload`. Parent-owned capability resolution and IPC keep workflow gates, browser state, ownership, and cleanup in one authority while allowing the parent editor to remain typable.

Design was informed by upstream [`amosblomqvist/pi-interactive-subagents`](https://github.com/amosblomqvist/pi-interactive-subagents), used under its MIT license as the design source. This repository adapts that model to Pi extension loadouts, authenticated Unix IPC, owner-scoped browser pages, cmux tabs, and its workflow-mode contracts.

## Consequences

- Good: launch is non-blocking; parent receives bounded final text without child transcript bloat.
- Good: loadout snapshots make finished-session resume reproduce the same restricted process and toolset.
- Good: process exit, crash, disconnect, timeout, and host teardown release locks, slots, browser pages, and cmux surfaces.
- Good: cmux gives each child a visible interactive session while classified failures preserve actionable diagnostics and test injection remains deterministic.
- Good: missing handshakes fail within 30 seconds with cmux tail/log diagnostics; transcript paths and opt-in live tails make child state diagnosable without reading child sessions into parent context.
- Bad/risk: healthy cmux logs can be empty and live output requires an explicit tail read; IPC adds framing, correlation, timeout, and crash-reaping paths; active child work that emits no IPC activity can still hit idle timeout. Cmux availability is required for production launches.
- Bad/risk: shared browser context retains cookies/storage while page state and buffers remain owner-isolated; Build browser actions can affect external web state.

## Affects

Docs:

- [architecture.md](../architecture.md)
- [dev-workflow.md](../dev-workflow.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [ADR-0004-pi-subagents.md](ADR-0004-pi-subagents.md)
- [ADR-0007-workflow-modes-subagent-delegation.md](ADR-0007-workflow-modes-subagent-delegation.md)
- [ADR-0010-subagent-idle-timeout.md](ADR-0010-subagent-idle-timeout.md)
- [ADR-0031-subagent-browser-access.md](ADR-0031-subagent-browser-access.md)
- [README.md](README.md)

Code:

- [index.ts](../../../agent/extensions/subagents/index.ts)
- [child.ts](../../../agent/extensions/subagents/child.ts)
- [ipc.ts](../../../agent/extensions/subagents/ipc.ts)
- [launch.ts](../../../agent/extensions/subagents/launch.ts)
- [cmux.ts](../../../agent/extensions/subagents/cmux.ts)
- [diagnostics.ts](../../../agent/extensions/subagents/diagnostics.ts)
- [concurrency.ts](../../../agent/extensions/subagents/concurrency.ts)
- [ownership.ts](../../../agent/extensions/subagents/ownership.ts)
- [policy.ts](../../../agent/extensions/subagents/policy.ts)
- [timeout.ts](../../../agent/extensions/subagents/timeout.ts)
- [subagents/test/test_ipc.ts](../../../agent/extensions/subagents/test/test_ipc.ts)
- [browser/index.ts](../../../agent/extensions/browser/index.ts)
- [subagents/test/test_launch.ts](../../../agent/extensions/subagents/test/test_launch.ts)
- [subagents/test/test_cmux.ts](../../../agent/extensions/subagents/test/test_cmux.ts)
- [subagents/test/test_child.ts](../../../agent/extensions/subagents/test/test_child.ts)
- [subagents/test/test_interaction.ts](../../../agent/extensions/subagents/test/test_interaction.ts)
- [subagents/test/test_progress.ts](../../../agent/extensions/subagents/test/test_progress.ts)
- [subagents/test/test_tool_surface.ts](../../../agent/extensions/subagents/test/test_tool_surface.ts)

## Read when

- changing parent/child IPC, launch, resume, or teardown
- changing toolset, workflow, nested-agent, concurrency, ownership, or timeout policy
- changing cmux presentation or browser proxy ownership

## Supersedes

- [ADR-0004-pi-subagents.md](ADR-0004-pi-subagents.md)
