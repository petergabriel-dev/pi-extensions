---
id: ADR-0051
title: Presence-derived project-wide single writer
status: Active
date: 2026-11-02
decision: A Pi project allows one writer at a time across Pi sessions; another live session in Pi Build or holding an active harness lease blocks lease requests, approvals, ticks, Build entry, harness hook writes, and every Pi Build tool outside a read-only set (including subagents), derived from existing presence with no lock file and failing closed on guard errors.
why: Per-session leases let two Pi sessions each authorize a writer (F10); presence already records mode, lease, and a five-second heartbeat, so a uniqueness check closes the gap without new state, reclaim logic, or crash cleanup, at the cost of denying every claimant when a race leaves two claims.
affects: agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-sessions.js, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/harness-commands/claude/pi-build.md, agent/harness-commands/cursor/pi-build.md, agent/harness-commands/opencode/pi-build.md, agent/claude-bridge-client/pi-readonly-hook.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/opencode-bridge-client/test-opencode-plugin.js, scripts/security-corpus.json, scripts/test-security-corpus.ts, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md
consequences: F10 closes with no new state and automatic crash recovery; races or a holder stalling past the heartbeat TTL deny every claimant until a human releases one; passive-bridge sessions are blocked from Build; restored Build sessions land in Plan, reload included; cross-project Pi Build edits are an accepted limit; already-running worker subagents finish their current run; the claim rule is mirrored in JS and TS.
readWhen: changing Build lease scope, presence schema or liveness, the workflow-modes build-guard, Pi Build tool gating, holdsBuildLease, or adding a lock or tie-break between Pi sessions
supersedes: None
extends: ADR-0045, ADR-0047
---

# ADR-0051: Presence-derived project-wide single writer

## Decision

- A writer claim is held by any live session (presence heartbeat within `LIVE_TTL_MS`, five seconds) other than the caller whose presence `mode` is `build` or whose parsed `buildLease` is unexpired. Malformed leases are ignored by the same parser rules in JS and TS.
- Claims count liberally: a fresh, parseable presence file in a real namespace directory counts even when bridge permissions have drifted. Strict private-directory checks gate only pairing, holder identity, ownership, peer restore, and the `/claude-bridge` listing. JS `scanSessions` reads the directory once and records a per-entry `strict` flag; TS uses `listLiveNamespaces(..., { forClaims: true })` only for claims.
- Enforcement points:
  - Harness hooks (Claude, Cursor, OpenCode): `holdsBuildLease` returns false while another claim exists, and denials name the conflicting session and how to release it there (`writerConflictHint`) instead of telling the user to request or approve a lease.
  - Pi bridge: a lease request and a task tick return `build_lease_held`; `/build-lease approve` refuses before and again after the human confirm; the `workflow-modes:build-guard` handler sets `blockedBy`; `/build-lease` lists the conflict.
  - Workflow modes: in Pi Build, every tool outside `BUILD_READ_ONLY_TOOLS` asks the build-guard first (deny-unknown), so `subagent`, `subagent_message`, plan tick/save, and unknown or future tools are blocked under a conflict, not just writes.
- The guard fails closed: the bridge listener sets a provisional blocker before checking because Pi's event bus swallows listener errors, `getBuildGuardBlocker` returns a blocker when a listener throws, and a passive bridge in a Pi project blocks (it publishes no presence, so it would write while invisible). Bridge `session_start` work that throws after locating the project stops the partial bridge best-effort and goes passive with a reason naming the error, so that session blocks the same way. A session outside any Pi project has no project check.
- Restoring a branch whose latest mode is Build (`session_start`, `session_tree`) lands in Plan with a durable `restoredFrom: "build"` entry and a notice; Build is re-entered only through the guarded `/mode build`, so a restored session never claims the writer unchecked. This includes `/reload`: a round-4 exception that kept Build on reload was removed in round 5, because after a failed save the branch still ends in Build and a reloaded session re-claimed the writer without the guard. Reconstruction's status update is best-effort; landing refreshes the status bar before saving, reports a save failure only when the append fails, and never rejects.
- Blocker phrases carry their own remediation (`agent/extensions/claude-bridge/build-lease.ts`): another session's claim says how to release it there; this session's own stale presence points at `.pi/memory/bridge` permissions or a restart.
- Conflicting claims deny every claimant. There is no tie-break. A claim ends through `/build-lease release`, leaving Build, quitting, or presence going stale.
- Pi-side checks fail closed when the session's own live presence is missing from the scan.
- Presence stays `schemaVersion: 2` with no new fields. The existing build-guard event is reused; harness `pi-build` templates add one `build_lease_held` refusal line.
- Pi Off stays intentionally unguarded and never claims. Worker subagents already running finish their current run (accepted limit).
- The guard checks only this session's project. Pi Build can edit files inside another Pi project while that project's writer is held (accepted limit, ADR-0045 F11).

## Why

- ADR-0045 finding F10: independent per-session leases did not ensure a single writer per project; `lease-cross-session-write` reproduced it on all three harnesses.
- Presence already carries `mode`, `buildLease`, `pid`, and `heartbeatAt`, and every hook already scans all live sessions per call, so the check adds no file reads and no state.
- Stale presence frees a quit or crashed session automatically. Taking the writer still requires the existing human gates from ADR-0047, so no recovery path can grant authority on its own.
- Rejected: an atomic lock file (`writer.lock` with exclusive create and stale reclaim by delete and recreate). It picks one race winner, but adds persistent state, reclaim races that can remove a fresh lock, crash cleanup, and one more file read per hook call.
- Rejected: a tie-break such as newest grant wins. It lets one claimant through while state is ambiguous; denying all claimants is simpler and fails closed.

## Evidence

Legend per ADR-0045: **E** = `verified-exec`, **C** = `code-read`, **N** = `not-verified`.

- Hook-side cross-session denial: `lease-cross-session-write` and `lease-cross-session-pi-build` deny, `lease-cross-session-stale` allows, on Claude, Cursor, and OpenCode in both corpus lanes **E**.
- Claim rule and lease parser: `agent/claude-bridge-client/test-sessions.js` and `agent/extensions/claude-bridge/test/test_build_lease.ts` **E**.
- Pi Build per-write guard: `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`, which fails without the guard **E**.
- Review fix round: blocked Build denies `subagent`, `subagent_message`, plan tick, `remember`, and an unknown tool while read-only tools skip the guard; a throwing listener blocks both tool calls and `/mode build`; a claimant with a non-private `requests` directory still denies the holder; each assertion fails with its fix removed **E**.
- Live, operator-reported, two Pi sessions from source on macOS: Build in one session blocks `/mode build` in the other and names it; `/build-lease` shows the conflict; leaving Build or quitting frees the other session; an operator-approved single-session lease flow (plan save, MCP dispatch, holder-only ticks) passes **E**.
- Re-check between the approval confirm and grant: source inspection only; `agent/extensions/claude-bridge/index.ts` has no unit harness **C**.
- Concurrent approvals and a resumed former holder: pure-function tests and source inspection; not exercised live **C**.
- Round 3: restore from Build lands in Plan via `session_start` and `session_tree`, and Plan/Off restores are unchanged (`test_build_design_prompt.ts`, fails without the fix) **E**; each hook's denial names a conflicting session's Build (`test-sessions.js`, `test-cursor-readonly-hook.js`, `test-opencode-plugin.js`) **E**; `holdsBuildLease` reads the sessions directory once **E**; the passive-bridge blocker phrase is tested, while the listener branch and `listLiveNamespaces` caller scopes are source-inspected **C**.
- Round 4: landing refreshes the status bar at once, a throwing notify after a successful save is not reported as a save failure and does not reject, and a failed save warns and stays in Plan (`test_build_design_prompt.ts`, each failing with its fix removed) **E**; bridge startup fail-closed is source-inspected because `agent/extensions/claude-bridge/index.ts` has no unit harness **C**; cross-project Pi Build edits were found by code review and not exercised **C**.
- Round 5: reload lands in Plan and a throwing `setStatus` during reconstruction still lands in Plan (`test_build_design_prompt.ts`, each failing with its fix removed) **E**; the build-lease holder refusal points at `/build-lease release` in Pi (`test_build_lease.ts`) **E**.

## Affects

Docs:

- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md`
- `docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md`

Code:

- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/test-sessions.js`
- `agent/extensions/claude-bridge/build-lease.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/claude-bridge/test/test_build_lease.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/policy.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/harness-commands/claude/pi-build.md`
- `agent/harness-commands/cursor/pi-build.md`
- `agent/harness-commands/opencode/pi-build.md`
- `scripts/security-corpus.json`
- `scripts/test-security-corpus.ts`
- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `agent/opencode-bridge-client/pi-opencode-plugin.js`
- `agent/opencode-bridge-client/test-opencode-plugin.js`

## Consequences

- Good: closes F10 without new state; crash recovery needs no cleanup; one rule applies at every write path.
- Good: presence schema is unchanged, so older presence readers keep working; harness templates only gained a `build_lease_held` line.
- Good: deny-unknown means new Pi tools are blocked under a conflict by default instead of slipping past a list of known writers.
- Bad/risk: worker subagents do not load workflow-modes; one started before Pi leaves Build or before another session claims the writer finishes its current run. New spawns and steering are blocked.
- Bad/risk: a race, or a holder stalling past the five-second TTL and resuming, leaves two claims; every claimant is denied until a human releases one.
- Bad/risk: a session whose bridge is inactive or passive publishes no presence and is invisible to the check; Pi Off is unguarded by design.
- Bad/risk: the guard is project-scoped, so Pi Build can still write into another Pi project whose writer is held (ADR-0045 F11, accepted).
- Bad/risk: the claim rule is implemented in JS (`hasOtherWriterClaim`) and TS (`otherWriterClaims`, `parseBuildLease`); mirrored tests guard against drift.
- Bad/risk: hosts running an older installed package keep per-session behavior until the package is updated and `/harness` repair is run.
- Bad/risk: this remains a workflow guardrail, not OS-level isolation (ADR-0045).

## Read when

- changing Build lease scope, approval, tick, or revocation
- changing presence schema, the liveness TTL, `listLiveNamespaces`, or `liveSessions`
- changing `workflow-modes:build-guard` or Pi Build tool gating
- adding a lock, a tie-break, or sessions that span machines

## Supersedes

- None. Extends ADR-0045 (closes F10) and ADR-0047 (lease exclusivity becomes project-wide).
