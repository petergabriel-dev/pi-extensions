---
id: ADR-0047
title: Human-approved harness Build lease
status: Active
date: 2026-10-21
decision: A harness Build request becomes a four-hour identity-bound lease only after explicit Pi TUI approval; only its active holder may tick plan tasks.
why: A bridge request is agent-controlled, so lease authorization must come from a human event at Pi while host-supplied identity and bounded expiry constrain its authority.
affects: agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/pi-readonly-hook.js, agent/claude-bridge-client/test-sessions.js, agent/claude-bridge-client/test-core-protocol.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/opencode-bridge-client/test-opencode-plugin.js, agent/harness-commands/claude/pi-build.md, agent/harness-commands/cursor/pi-build.md, agent/harness-commands/opencode/pi-build.md, .cursor/commands/pi-build.md, docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md, docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md, docs/engineering/decisions/README.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md
consequences: Human approval adds a round trip and leases can expire mid-build; headless requests fail closed; TUI trust is verified for the probed read-only input-isolation states; this is not OS-level enforcement.
readWhen: changing bridge Build authorization, lease expiry or revocation, harness identity binding, holder-only task ticks, Pi approval UI, or TUI input-isolation assumptions
supersedes: None
extends: ADR-0043, ADR-0045
---

# ADR-0047: Human-approved harness Build lease

## Context

ADR-0043 introduced a Pi-owned Build lease, but lease requests could grant themselves authority and Claude/Cursor MCP arguments could assert another peer's identity. ADR-0045 records those defects as F1 (self-escalation) and F2 (agent-asserted identity). Phase 3 closes both without moving plan ownership or replacing Phase 2 hook policy.

## Decision

### Request is not authorization

- `recall(mode: "build")` may confirm that its peer already holds the active lease or create/refresh that peer's pending request. It never grants a lease. Requests require a paired Claude, Cursor, or OpenCode peer, an active saved plan, and Pi outside Build mode.
- Pending requests are per-peer, capped at ten, and notify only when new. The response names `<harness>:<first 8 id chars>`, `/build-lease approve`, and rerun `/pi-build`. Headless Pi returns `build_lease_no_approval` before recording a request.
- Only `/build-lease approve` in interactive Pi can grant. The TUI shows peer id, request age, plan id/progress, and four-hour expiry. Decline or cancellation grants nothing. After confirmation, Pi re-reads workflow and pairing state; changed plan, lost pairing, Pi Build mode, or another active holder refuses approval.

### Lease bounds and authority

- One peer holds one in-memory lease per Pi session. `expiresAt` is exactly `grantedAt + BUILD_LEASE_TTL_MS` (four hours); the TTL is fixed, not configurable. Presence publishes the expiry. Pi and Claude, Cursor, and OpenCode clients fail closed for expired leases or leases missing valid expiry.
- Only the active lease holder may tick a saved-plan task through the bridge. Non-holder ticks return `build_lease_required`. Pi's own `workflow_plan_tick` behavior is unchanged.
- Expiry, holder unpair, holder Discuss/Plan recall, plan clear/change/completion, Pi entering Build, `/build-lease release`, and bridge/session shutdown revoke the lease. Pending requests are pruned on plan/workflow changes and removed on unpair or decline.

### Harness identity

- Claude's PreToolUse hook requires a safe harness `session_id`; it rejects mismatched `sessionId`, `claudeSessionId`, or `harness`, then stamps `sessionId` and `harness: "claude"` before the lease-holder allow path.
- Cursor's bridge MCP hook parses object or JSON-string arguments and requires safe `conversation_id`, matching `sessionId`, and `harness: "cursor"`; missing, malformed, or mismatched input denies.
- OpenCode continues to overwrite bridge identity from host `sessionID` and `harness: "opencode"`.
- Phase 2 allowlists, Seatbelt wrapping, catch-all deny, and Claude exit-2 guard remain unchanged.

### TUI trust assumption

Human approval treats Pi TUI confirmation as a human signal. Assumption A1: an agent cannot drive Pi's TUI through keystroke injection. Phase 4 P11 probed Apple Events keystroke, tmux/cmux send-keys, and TIOCSTI from Claude, Cursor, and OpenCode read-only shells against a dummy sink, with no real Pi approval pending or targeted. Claude and OpenCode blocked all three vectors at the Seatbelt boundary; Cursor's classifier returned ask for all three; no sink received input. Host controls reached the sink, so A1 is **verified** for the probed read-only states. Cursor operator-approved or Build-mode execution and OS-level enforcement remain outside this claim.

## Why

A lease is write authority, not an agent-selected workflow mode. The bridge must answer within the two-second client budget, so it cannot wait on UI; a pending response keeps requests non-blocking and makes approval a separate, explicit Pi action. Host-bound identity prevents MCP arguments from substituting another peer, while fixed expiry bounds stale grants without new configuration.

Rejected alternatives:

- **Automatic pop-up during the bridge request:** would couple a two-second protocol response to UI timing and could block the request handler.
- **Pre-grant peer picker:** could approve a peer that had not made this request or whose plan/pairing changed before use.
- **Single pending slot:** hides concurrent requesters and makes selection ambiguous; bounded per-peer entries preserve provenance.
- **MCP-server backstop:** agent-facing MCP arguments cannot establish human intent; only Pi's TUI approval is the grant event.
- **Configurable TTL:** adds policy configuration and divergent expiry behavior; one fixed four-hour maximum is easier to audit.
- **OS-level authentication:** adds platform-specific machinery outside this phase and would still not replace lease ownership and lifecycle rules.

## Live acceptance

Operator-reported acceptance ran in an isolated disposable project with harness configuration pointed at the development checkout. All listed flows were reported passing; these are operator results, not independently observed by this session.

| Check | Result |
|---|---|
| Core protocol, pending request, operator approval, expiry presence, holder tick and non-holder tick | Pass **E** |
| Claude pending/no writes, decline/no lease, approval/write, status expiry | Pass **E** |
| Cursor and OpenCode approval/write flows | Pass **E** |
| Forged bridge identity denied in Claude and Cursor | Pass **E** |
| Holder unpair / Claude SessionEnd clears lease | Pass **E** |
| Headless Build request returns no-approval refusal | Pass **E** |
| Automated `npm test` gate after acceptance | Pass **E** |

Assumption checks: A2 (Claude honors `updatedInput`) **verified** by matching calls succeeding and forged identity denial; A3 (Cursor supplies hook arguments and `conversation_id`) **verified** by matching calls succeeding and forged identity denial; A4 (`hasUI` distinguishes interactive approval from headless refusal) **verified** by the reported interactive and headless flows; A1 **verified** by the P11 read-only probe: all three injection vectors were blocked or operator-gated, the sink stayed empty, and host controls reached it.

## Affects

Docs:

- `docs/engineering/decisions/ADR-0043-harness-build-lease-and-opencode-harness.md`
- `docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md`
- `docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`

Code and harness surfaces:

- `agent/extensions/claude-bridge/build-lease.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/claude-bridge/test/test_build_lease.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/claude-bridge-client/test-sessions.js`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `agent/opencode-bridge-client/pi-opencode-plugin.js`
- `agent/opencode-bridge-client/test-opencode-plugin.js`
- `agent/harness-commands/claude/pi-build.md`
- `agent/harness-commands/cursor/pi-build.md`
- `agent/harness-commands/opencode/pi-build.md`
- `.cursor/commands/pi-build.md`

## Consequences

- Good: no bridge request self-grants; Pi owns approval, lease state, and task progress; identity is bound at each harness boundary; expired authority fails closed.
- Bad/risk: approval adds a round trip, four hours may expire mid-build, and requesters must stop and ask for re-approval. Human intent depends on the TUI trust assumption; P11 verified it for the probed read-only states only.
- Bad/risk: if a harness disappears without unpairing, the lease remains until another lifecycle event or expiry; `/build-lease release` remains the operator escape hatch.

## Read when

- changing the human approval UI, Build request protocol, four-hour expiry, lease release, bridge task ticks, or harness identity stamping
- updating ADR-0043's lease lifecycle or ADR-0045's F1/F2 evidence

## Supersedes

- None
