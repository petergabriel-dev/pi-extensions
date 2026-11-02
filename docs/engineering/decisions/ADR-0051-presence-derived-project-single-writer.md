---
id: ADR-0051
title: Presence-derived project-wide single writer
status: Active
date: 2026-11-02
decision: A Pi project allows one writer at a time across Pi sessions; another live session in Pi Build or holding an active harness lease blocks lease requests, approvals, ticks, Build entry, harness hook writes, and Pi Build writes, derived from existing presence with no lock file.
why: Per-session leases let two Pi sessions each authorize a writer (F10); presence already records mode, lease, and a five-second heartbeat, so a uniqueness check closes the gap without new state, reclaim logic, or crash cleanup, at the cost of denying every claimant when a race leaves two claims.
affects: agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-sessions.js, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, scripts/security-corpus.json, scripts/test-security-corpus.ts, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md
consequences: F10 closes with no new state and automatic crash recovery; races or a holder stalling past the heartbeat TTL deny every claimant until a human releases one; sessions without an active bridge are invisible; the claim rule is mirrored in JS and TS.
readWhen: changing Build lease scope, presence schema or liveness, the workflow-modes build-guard, Pi Build tool gating, holdsBuildLease, or adding a lock or tie-break between Pi sessions
supersedes: None
extends: ADR-0045, ADR-0047
---

# ADR-0051: Presence-derived project-wide single writer

## Decision

- A writer claim is held by any live session (presence heartbeat within `LIVE_TTL_MS`, five seconds) other than the caller whose presence `mode` is `build` or whose parsed `buildLease` is unexpired. Malformed leases are ignored by the same parser rules in JS and TS.
- Enforcement points:
  - Harness hooks (Claude, Cursor, OpenCode): `holdsBuildLease` returns false while another claim exists, using its existing single `liveSessions()` scan.
  - Pi bridge: a lease request returns `build_lease_held`; `/build-lease approve` refuses before and again after the human confirm; a task tick returns `build_lease_required`; the `workflow-modes:build-guard` handler sets `blockedBy`; `/build-lease` lists the conflict.
  - Workflow modes: in Pi Build, every `write`, `edit`, `bash`, and browser-mutation call asks the build-guard first.
- Conflicting claims deny every claimant. There is no tie-break. A claim ends through `/build-lease release`, leaving Build, quitting, or presence going stale.
- Pi-side checks fail closed when the session's own live presence is missing from the scan.
- Presence stays `schemaVersion: 2` with no new fields. Existing refusal codes and the existing build-guard event are reused; harness command templates are unchanged.
- Pi Off stays intentionally unguarded and never claims.

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
- Live, operator-reported, two Pi sessions from source on macOS: Build in one session blocks `/mode build` in the other and names it; `/build-lease` shows the conflict; leaving Build or quitting frees the other session; an operator-approved single-session lease flow (plan save, MCP dispatch, holder-only ticks) passes **E**.
- Re-check between the approval confirm and grant: source inspection only; `agent/extensions/claude-bridge/index.ts` has no unit harness **C**.
- Concurrent approvals and a resumed former holder: pure-function tests and source inspection; not exercised live **C**.

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
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `scripts/security-corpus.json`
- `scripts/test-security-corpus.ts`

## Consequences

- Good: closes F10 without new state; crash recovery needs no cleanup; one rule applies at every write path.
- Good: presence schema and refusal codes are unchanged, so harness templates and older presence readers keep working.
- Bad/risk: a race, or a holder stalling past the five-second TTL and resuming, leaves two claims; every claimant is denied until a human releases one.
- Bad/risk: a session whose bridge is inactive or passive publishes no presence and is invisible to the check; Pi Off is unguarded by design.
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
