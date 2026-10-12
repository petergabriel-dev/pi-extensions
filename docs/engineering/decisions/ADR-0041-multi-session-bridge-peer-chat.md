---
id: ADR-0041
title: Multi-session bridge and peer chat
status: Active
date: 2026-10-30
decision: Each Pi session owns a namespaced bridge; Pi brokers pairing and routing for Claude and Cursor peers.
why: Independent session namespaces allow concurrent Pi sessions while keeping peer state and routing under live Pi ownership.
affects: agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/mailbox.ts, agent/extensions/claude-bridge/test/test_mailbox.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/pi-peer-hook.js, agent/claude-bridge-client/pi-statusline.js, agent/claude-bridge-client/test-sessions.js, agent/claude-bridge-client/test-core-protocol.js, agent/claude-bridge-client/test-burst.js, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, package.json, scripts/check-workspace.mjs, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md, docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md, docs/engineering/decisions/ADR-0041-multi-session-bridge-peer-chat.md, docs/engineering/decisions/README.md
consequences: Peer routing stays Pi-mediated and session-scoped; peer delivery is bounded and at-least-once; inbound content is advisory only.
readWhen: changing bridge ownership, pairing, peer routing, delivery, wake behavior, or adding a harness peer.
extends: ADR-0001, ADR-0019
---

# ADR-0041: Multi-session bridge and peer chat

## Context

A project may have multiple live Pi sessions and Claude Code or Cursor peers. Bridge ownership, pairing, and peer-message delivery must remain scoped to each Pi session.

## Decision

- Use a star topology: each Pi session owns its own namespaced bridge; Pi acts as pairing and routing broker for Claude and Cursor peers.
- Keep sticky pairing in Pi, keyed by harness identity. Pair and unpair only through live bridge requests. Explicit `sessionId` wins over deprecated `claudeSessionId`, which wins over `CLAUDE_CODE_SESSION_ID`. `SessionEnd` best-effort unpairs.
- Use bounded ephemeral inbox/outbox queues: at most 10 peers per Pi session, 4,000 characters per message, and 20 pending messages per peer per direction. Outbound IDs remain pending until the paired peer acks; failed ack redelivers the same IDs (at-least-once).
- Notify Pi when inbound mail arrives; inject it as advisory JSON context on the next prompt only. Never auto-wake, send a follow-up turn, or use Channels to wake Pi.
- Carry sender identity, message ID, timestamp, and text inside JSON in a fixed delimited advisory block. Escape delimiter-sensitive characters; message text cannot forge envelope provenance or grant approval/instructions.
- Claude `UserPromptSubmit` emits bounded context before ack; Claude statusline reads presence only. Cursor uses `read_messages` pull, not a peer hook.
- Keep a future mesh as a possible Pi-brokered extension; do not introduce direct peer mesh now.

## Why

- Per-session namespaces allow concurrent Pi sessions without shared bridge ownership or cross-session mailbox state.
- Pi remains the live authority for pairing and routing; ephemeral queues bound retained state and preserve explicit acknowledgement semantics.
- Next-prompt advisory delivery avoids unsolicited agent turns and keeps peer text outside trusted control channels.

## Rejected alternatives

- Direct peer mesh now: rejected; Pi remains broker and owner of session-scoped routing.
- Channels or automatic wake: rejected; peer messages wait for the next prompt and never trigger a turn.
- Durable mailbox: rejected; inbox and outbox remain bounded and ephemeral.
- MCP-memory pairing: rejected; pairing state belongs to Pi's live bridge, not memory tools or stores.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md`
- `docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md`
- `docs/engineering/decisions/ADR-0041-multi-session-bridge-peer-chat.md`
- `docs/engineering/decisions/README.md`

Code and clients:

- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/claude-bridge/mailbox.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/pi-peer-hook.js`
- `agent/claude-bridge-client/pi-statusline.js`
- `.cursor/commands/pi-discuss.md`
- `.cursor/commands/pi-plan.md`

Tests and workspace checks:

- `agent/extensions/claude-bridge/test/test_mailbox.ts`
- `agent/claude-bridge-client/test-burst.js`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/claude-bridge-client/test-sessions.js`
- `package.json`
- `scripts/check-workspace.mjs`

## Consequences

- Good: multiple Pi sessions can independently pair and route Claude and Cursor peer traffic.
- Good: bounded ephemeral queues and stable IDs permit retry without claiming exactly-once delivery.
- Good: inbound peer content cannot wake Pi or cross into trusted instructions, approvals, or provenance.
- Risk: offline peers cannot rely on mailbox persistence; unacked messages are session-scoped and can be dropped when bridge ownership ends.
- Risk: at-least-once delivery can repeat messages after failed ack; consumers must use message IDs to recognize retries.
- Future mesh must remain brokered by Pi if introduced; direct peer-to-peer routing is outside this decision.

## Read when

- Changing bridge ownership, pairing, peer routing, queue bounds, acknowledgements, or message injection.
- Adding peer wake behavior, durable mailbox storage, or a harness client.

## Extends

- ADR-0001
- ADR-0019
