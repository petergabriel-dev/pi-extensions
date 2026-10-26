---
id: ADR-0048
title: Shared adversarial security regression corpus
status: Active
date: 2026-10-22
decision: Use one validated JSON corpus and isolated runner to exercise installed harness entrypoints and Pi shell policy with OS-confined execution, explicit known-gap pins, and platform-specific evidence limits.
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
- `scripts/test-security-corpus.ts` validates schema, unique ids, and expectations, then lexically lints executable commands for absolute paths other than `/dev/null`, `~`, `$HOME`, and `..` traversal. This lint is not a shell parser or containment guarantee. UI-injection cases remain `execute: false`; their hook and policy decisions are exercised without sending input to any sink.
- Each runner invocation creates temporary `HOME`, Claude/Cursor/OpenCode roots, and Git repo under disposable runtime/work paths. It installs harness setup with `planInstall`/`applyPlan` from `agent/extensions/harness-setup/setup.ts`, invokes installed Claude/Cursor commands, imports installed OpenCode plugin with mock context, and calls Pi `isBashAllowedInMode` and `wrapCommand` from `agent/extensions/workflow-modes/`. Cases run against disposable state with 10-second process timeout; no real harness config, harness CLI, Pi process, model, bridge, or live service is part of corpus.
- Shell execution containment is OS-enforced. On macOS, runner requires `/usr/bin/sandbox-exec`; its wrapper grants writes inside disposable work directory, denies writes to temporary `HOME`, and denies network. Darwin preflight must show `HOME` write denied and repo write allowed. Before execution, wrapper gate accepts only recognized Seatbelt deny-write/network text or bwrap read-only-root/network-isolation markers. Lexical checks rejecting absolute paths (except `/dev/null`), `~`, `$HOME`, and `..` are defense-in-depth, not confinement.
- Pi columns use `wrapCommand` first, then `isBashAllowedInMode` as conservative fallback when no launcher exists or wrapping fails. The sandbox-disabled lane forces Pi `piLauncher: "none"`, so it exercises that fallback too. On Linux, raw unconfined `allow` outcomes are decision-only and skipped; recognized wrapped outcomes still execute.
- For executed shell outcomes, runner snapshots temporary repo before/after. SHA-256 input covers repo files except `.git/index` and includes `git ls-files -s`; this avoids false positives from Git stat-cache rewrites while retaining tracked-file checks. `mutation: "none"` must remain unchanged; `mutation: "allowed"` must change it.
- Crash and malformed-input checks make temporary package copies and exercise installed commands/plugins. They add no crash-test switches to shipped hooks. The only reused switch is existing `PI_READONLY_HOOK_DISABLE_SANDBOX_EXEC=1` for sandbox-disabled lane.

### Known gaps and CI

- A `knownGap` marker must be an `F<n>` finding id and every targeted column must provide its own explicit `expect`; class defaults cannot satisfy this requirement. It records an expected safe outcome current behavior does not meet. If behavior starts meeting that expectation, runner fails with `gap closed: remove knownGap marker`; remove marker and retain safe expectation as regression assertion. F9 `pi-plan-wildcard-test` pins `piLauncher: "none"` and explicit `deny`; F10 `lease-cross-session-write` pins explicit safe outcomes (`wrap`, `deny`, `ask`, or `throw`) for each Claude/Cursor/OpenCode column. Both remain ADR-0045 findings; no new known gap or ADR-0045 finding row is added. Corpus currently has 142 cases.
- `npm run test:security` runs corpus once normally and once with sandbox execution disabled. Summary reports `launcher`, `piLauncher`, `executed`, `confined`, and `skippedUnconfined`. Raw unconfined Linux decisions are skipped rather than executed; recognized wrappers still run. Ubuntu `test` job runs security corpus through `npm test`; `security-macos` runs only this command on `macos-latest` with Node 22. On macOS, runner prints launcher and counts and fails if Seatbelt lane confines zero cases.
- This runner proves installed entrypoint decisions and contained command effects, not harness-host enforcement. Cursor's installed `failClosed: true` config and nonzero broken-hook exit do not prove how Cursor handles that exit. Import failure of a broken OpenCode plugin does not prove OpenCode host behavior. Those limits remain explicit rather than inferred from mock or config tests.

Local verification covered hostile-environment isolation, missing-Git cleanup, wrapper rejection before execution, explicit-expect validation, and gap-closure failures. macOS security run took 47.966 seconds (209 confined executions normally, 45 with product sandboxing disabled); `npm test` passed. Local results do not establish remote CI or Linux timing for final HEAD.

Residual K1: Seatbelt cannot nest. A regression in product wrapper profile could permit writes outside repo before repo snapshot; recognized-wrapper deny-write/network checks and product-profile assertions mitigate this, but do not prove full external-write confinement.

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
