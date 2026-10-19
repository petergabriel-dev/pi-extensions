---
id: ADR-0043
title: Harness build lease and OpenCode integration
status: Active
date: 2026-10-19
decision: Grant one identity-bound Build lease per Pi session to a paired Claude, Cursor, or OpenCode peer while Pi retains plan, mode, and task-progress ownership.
why: Harness-native edits need Pi-owned single-writer authorization without moving saved plans or task tracking into harness-local state.
affects: agent/extensions/claude-bridge/mailbox.ts, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/test/test_mailbox.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_policy.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/pi-readonly-hook.js, agent/claude-bridge-client/test-sessions.js, agent/claude-bridge-client/test-core-protocol.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/opencode-bridge-client/test-opencode-plugin.js, agent/harness-commands/claude/discuss.md, agent/harness-commands/claude/plan.md, agent/harness-commands/claude/build.md, agent/harness-commands/opencode/discuss.md, agent/harness-commands/opencode/plan.md, agent/harness-commands/opencode/build.md, .cursor/commands/pi-build.md, package.json, scripts/check-package.mjs, scripts/check-workspace.mjs, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md, docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md, docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md, docs/engineering/decisions/README.md
consequences: Harness hooks fail closed on absent or stale presence; a disconnected harness can leave its lease held until explicit release, and Pi Off remains unguarded.
readWhen: changing harness mutation enforcement, lease ownership or lifecycle, OpenCode bridge integration, or harness command packaging
supersedes: None
extends: ADR-0001, ADR-0019
---

# ADR-0043: Harness build lease and OpenCode integration

## Context

Pi owns saved plans, workflow mode, and task progress. Claude and Cursor already have read-only project hooks; OpenCode needs a separate plugin surface. Harness-native Build must allow edits without making model instructions or a harness-local flag the authorization boundary.

## Decision

- Grant one in-memory lease per Pi session to a paired `claude`, `cursor`, or `opencode` peer only when an active saved plan exists and Pi is not in Build mode. The lease binds `harness`, host session identity, and `planId`; `pi` peers cannot hold it. Multiple Pi sessions remain independently scoped.
- Publish an optional `buildLease` in schema-version-2 presence. Client hooks read local presence only; authorization requires exactly one fresh paired Pi namespace and a validated lease matching the hook's host identity. Missing, stale, malformed, ambiguous, mismatched, or unreadable state preserves read-only behavior. Hooks make no bridge requests or Pi-state writes.
- Release the lease when its holder recalls Discuss or Plan, the active plan is cleared or changed, all plan tasks are complete, Pi enters Build, the holder runs `/build-lease release`, or the owning bridge/session stops or changes. `/build-lease` reports the holder and supports explicit release. While a lease is held, a synchronous workflow guard refuses Pi's `/mode build` transition.
- Claude, Cursor, and OpenCode keep their existing fail-closed behavior unless host identity matches the lease. OpenCode's plugin replaces MCP identity fields with OpenCode's host `sessionID`; it blocks `edit`, `write`, and worktree mutation tools, sandboxes `shell`, and leaves outer Code Mode `execute` available as a dispatcher so nested tools remain individually guarded.
- Ship Claude and OpenCode discuss/plan/build templates under `agent/harness-commands/`; keep Cursor's explicit `pi-build` command repo-local and leave neutral Cursor commands unchanged. Each build template treats Pi's returned Build prompt as authoritative, reads/ticks the live tracker through the bridge, commits before ticking, and never edits the saved plan body.

## Why

A Pi-mode-only gate does not bind authorization to one harness identity or coordinate a single active builder. Harness-local flags cannot share ownership with Pi or reliably release when the plan changes. The lease keeps workflow state and revocation in the live Pi owner while allowing existing harness tools to perform the task.

Rejected alternatives:

- Pi Build mode as the sole harness authorization: it grants no identity-bound ownership and would conflate the Pi editor with an external harness.
- Harness-local build flags: they are not shared with Pi and cannot reliably guard other paired clients.
- TTL-only lease expiration: elapsed time does not represent plan changes or completion. The five-second presence TTL remains only a liveness check.
- Confirm-takeover: silently evicting a working peer risks concurrent writes; the holder must release explicitly.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md`
- `docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md`
- `docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md`
- `docs/engineering/decisions/README.md`

Code, tests, and shipped surfaces:

- `agent/extensions/claude-bridge/mailbox.ts`
- `agent/extensions/claude-bridge/build-lease.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/claude-bridge/test/test_mailbox.ts`
- `agent/extensions/claude-bridge/test/test_build_lease.ts`
- `agent/extensions/workflow-modes/policy.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/test/test_policy.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/claude-bridge-client/test-sessions.js`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `agent/opencode-bridge-client/pi-opencode-plugin.js`
- `agent/opencode-bridge-client/test-opencode-plugin.js`
- `agent/harness-commands/claude/discuss.md`
- `agent/harness-commands/claude/plan.md`
- `agent/harness-commands/claude/build.md`
- `agent/harness-commands/opencode/discuss.md`
- `agent/harness-commands/opencode/plan.md`
- `agent/harness-commands/opencode/build.md`
- `.cursor/commands/pi-build.md`
- `package.json`
- `scripts/check-package.mjs`
- `scripts/check-workspace.mjs`

## Consequences

- Good: Pi remains the authority for saved plans, task progress, and lease lifecycle while one matching harness identity may build per Pi session.
- Good: hooks use bounded local presence checks instead of bridge round-trips; old clients ignore the optional presence field.
- Good: an expired Pi heartbeat returns harnesses to read-only behavior within the five-second freshness window.
- Bad/risk: if a harness exits while Pi stays live, the lease remains held until lifecycle release or `/build-lease release`.
- Bad/risk: Pi Off mode intentionally opts out of the Build guard; writes may occur outside the lease boundary.
- Bad/risk: OpenCode subagent sessions may have distinct host identities and remain read-only under the parent's lease; live acceptance must verify this assumption. Commit before the final task tick because completion releases the lease.

## Read when

- changing harness write enforcement, lease acquisition/release, or presence validation
- adding a harness peer or changing OpenCode plugin/MCP behavior
- changing harness build templates, package contents, or single-builder rules

## Extends

- ADR-0001
- ADR-0019

## Supersedes

- None
