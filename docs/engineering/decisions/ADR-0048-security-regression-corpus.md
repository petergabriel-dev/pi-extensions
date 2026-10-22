---
id: ADR-0048
title: Shared adversarial security regression corpus
status: Active
date: 2026-10-22
decision: Use one validated JSON corpus and isolated runner to exercise installed harness entrypoints, Pi shell policy, mutation outcomes, and Linux/macOS CI lanes.
why: Cross-harness policy can drift despite focused tests; contained installed-entrypoint cases test decisions and filesystem effects without real harness binaries or user config.
affects: docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/ADR-0046-cross-harness-tool-classification.md, docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md, docs/engineering/decisions/ADR-0048-security-regression-corpus.md, docs/engineering/decisions/README.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, scripts/security-corpus.json, scripts/test-security-corpus.ts, package.json, .github/workflows/ci.yml, agent/extensions/harness-setup/setup.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/sandbox.ts, agent/claude-bridge-client/pi-readonly-hook.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/extensions/claude-bridge/test/test_build_lease.ts
consequences: Shared cases expose policy drift and unintended mutations; host-level CLI behavior remains outside coverage, and each known gap needs a finding id and explicit lifecycle.
readWhen: Changing corpus schema or loader, installed hook/plugin execution, mutation oracle, known-gap convention, or security CI lanes.
supersedes: None
extends: ADR-0045, ADR-0046, ADR-0047
---

# ADR-0048: Shared adversarial security regression corpus

## Context

ADR-0045 defines the cross-harness threat model, ADR-0046 sets the tool-classification rule, and ADR-0047 defines the human-approved Build lease. Separate unit tests cover parts of those boundaries, but do not provide one corpus that compares harness decisions and filesystem effects across platforms. Phase 4 adds that shared regression surface.

## Decision

### One corpus, installed entrypoints

- `scripts/security-corpus.json` is the sole source for adversarial case text. Cases identify a class (`read`, `write`, or `ambiguous`), kind, target columns, execution eligibility, and expected outcome. The runner normalizes decisions to `allow`, `wrap`, `ask`, `deny`, or `throw`; `ask` is blocking for mutation. Per-platform pins represent deliberate differences.
- `scripts/test-security-corpus.ts` validates schema, unique ids, expectations, and executable-shell containment before running cases. Executable commands are rejected if they use an absolute path other than `/dev/null`, a `~` or `$HOME` reference, or `..` traversal. UI-injection cases remain `execute: false`; their hook and policy decisions are exercised without sending input to any sink.
- Each runner invocation creates a temporary `HOME`, Claude/Cursor/OpenCode roots, and Git repo. It installs harness setup with `planInstall`/`applyPlan` from `agent/extensions/harness-setup/setup.ts`, invokes the installed Claude and Cursor commands, imports the installed OpenCode plugin with a mock context, and calls Pi's `isBashAllowedInMode` and `wrapCommand` from `agent/extensions/workflow-modes/`. Cases run against disposable state with a 10-second process timeout; no real harness config, harness CLI, Pi process, model, bridge, or live service is part of the corpus.
- For executable shell outcomes, the runner snapshots the temporary repo before and after execution. The SHA-256 input covers repo files except `.git/index` and includes `git ls-files -s`; this avoids false positives from Git stat-cache rewrites while retaining tracked-file checks. `mutation: "none"` must remain unchanged; `mutation: "allowed"` must change it.
- Crash and malformed-input checks make temporary package copies and exercise installed commands/plugins. They do not add crash-test switches to shipped hooks. The only reused switch is existing `PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC=1` for the separate sandbox-disabled lane.

### Known gaps and CI

- A `knownGap` marker must be an `F<n>` finding id. It records an expected safe outcome that the current behavior does not meet. If behavior starts meeting that expectation, the runner fails with `gap closed: remove knownGap marker`; remove the marker and retain the safe expectation as a regression assertion. Keep marker ids synchronized with ADR-0045 findings. Current markers identify `pi-plan-wildcard-test` (F9) and `lease-cross-session-write` (F10).
- `npm run test:security` runs the corpus once normally and once with sandbox execution disabled. The Ubuntu `test` job runs it through `npm test`; the `security-macos` job runs only this security command on `macos-latest` with Node 22. On macOS, the runner prints the detected launcher and execution count and fails if the Seatbelt lane executes zero cases.
- This runner proves installed entrypoint decisions and contained command effects, not harness-host enforcement. Cursor's installed `failClosed: true` config and nonzero broken-hook exit do not prove how Cursor handles that exit. Import failure of a broken OpenCode plugin does not prove OpenCode host behavior. Those limits remain explicit rather than inferred from mock or config tests.

## Why

The shared corpus makes additions small and comparable: new coverage is normally a JSON case rather than a new harness-specific fixture framework. Executing allowed cases and checking mutations tests more than returned decisions alone, while temporary roots avoid touching user configuration.

Rejected alternatives:

- **Gap-fill tests only:** cover known failures but leave previously passing columns and behavior free to drift.
- **Real-CLI end-to-end tests:** require installed harnesses and host-specific config, add nondeterminism, and risk touching user state; installed entrypoints provide deterministic coverage without claiming host behavior.
- **Decision-only tests:** miss side effects after a shell command is allowed or wrapped; the repository snapshot is part of the oracle.
- **New environment switch for hook crashes:** adds test-only behavior to shipped security code; temporary package copies exercise missing, malformed, and throwing assets instead.

## Affects

Docs:

- `docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md`
- `docs/engineering/decisions/ADR-0046-cross-harness-tool-classification.md`
- `docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md`
- `docs/engineering/decisions/ADR-0048-security-regression-corpus.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/traps.md`

Code and tests:

- `scripts/security-corpus.json`
- `scripts/test-security-corpus.ts`
- `package.json`
- `.github/workflows/ci.yml`
- `agent/extensions/harness-setup/setup.ts`
- `agent/extensions/workflow-modes/policy.ts`
- `agent/extensions/workflow-modes/sandbox.ts`
- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/opencode-bridge-client/pi-opencode-plugin.js`
- `agent/extensions/claude-bridge/test/test_build_lease.ts`

## Consequences

- Good: one versioned adversarial corpus keeps per-harness and per-platform expectations reviewable; loader validation and repo snapshots catch unsafe cases and unintended writes.
- Good: known gaps stay visible and become failing regressions when closed.
- Bad/risk: real CLI startup and host enforcement remain untested, including Cursor `failClosed` handling and OpenCode plugin-load failure.
- Bad/risk: the Pi Plan fallback still has a wildcard-expansion gap, and Build leases remain per-session rather than project-wide; see F9/F10 cases and ADR-0045.

## Read when

- changing corpus schema, validation, installed hook/plugin entrypoints, mutation snapshots, case expectations, known-gap handling, or security CI jobs
- interpreting corpus results as proof of actual Claude, Cursor, or OpenCode host behavior

## Extends

- ADR-0045
- ADR-0046
- ADR-0047

## Supersedes

- None
