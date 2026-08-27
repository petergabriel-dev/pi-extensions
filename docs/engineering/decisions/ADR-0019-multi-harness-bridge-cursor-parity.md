---
id: ADR-0019
title: Multi-harness bridge and Cursor parity
status: Active
date: 2026-07-08
decision: The Pi bridge is multi-harness: Claude Code and Cursor share the same live Pi file-protocol MCP bridge, Cursor adds project-committed read-only hooks/templates with `preToolUse` Write denial and Cursor's `permission` wire contract, and `sessionId` is the primary capture session field with `claudeSessionId` kept as a deprecated alias.
why: Cursor should get the same recall/capture/save-plan planning workflow as Claude Code without adding client-side Pi-state write paths or copying Pi internals into harness glue. Native Write tools must be denied before execution because Cursor's post-edit event does not provide the exact preimage or supported output fields needed for restoration.
affects: agent/claude-bridge-client/pi-bridge-mcp.js, agent/extensions/claude-bridge/index.ts, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, .cursor/hooks.json, .cursor/mcp.json, .cursor/commands/pi-discuss.md, .cursor/commands/pi-plan.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md
consequences: Cursor parity is enforced by project hooks plus bridge MCP; `preToolUse` denies Write before execution; shell classification is conservative; existing Claude Code callers keep working through the deprecated alias; the superseded `afterFileEdit` exact-byte restoration approach remains historical because its event lacks the required preimage/output contract.
readWhen: changing bridge protocol fields, adding new harness clients, changing Cursor hooks/templates, changing read-only enforcement, or extending ADR-0001 bridge boundaries
extends: ADR-0001
---

# ADR-0019: Multi-harness bridge and Cursor parity

## Decision

- Treat the bridge as a multi-harness Pi planning bridge, not Claude-only.
- Reuse `agent/claude-bridge-client/pi-bridge-mcp.js` as the harness-agnostic MCP client for Claude Code and Cursor.
- Keep Pi-coupled behavior only in `agent/extensions/claude-bridge/index.ts`; client glue imports no Pi internals.
- Rename the capture protocol's session field to `sessionId`.
- Keep `claudeSessionId` as a deprecated alias; either field populates the same response value and `sessionId` wins when both are present.
- Use Option A enforcement for Cursor: project-committed `.cursor/hooks.json`, `.cursor/mcp.json`, and `.cursor/commands/*` templates.
- Cursor read-only enforcement uses:
  - `beforeShellExecution` for shell write deny / read-only allow / ambiguous ask;
  - `beforeMCPExecution` to deny mutating non-bridge MCP calls;
  - `preToolUse` to deny the `Write` tool before execution with `permission: "deny"` and supported message fields.
- No Pi command auto-provisions Cursor files into client projects; templates are committed project artifacts.

## Why

- Cursor should support the same Pi planning loop: recall engineering docs/personal memory, capture Notes widget updates live, validate docs tags, and save plans into Pi build handoff.
- Reusing the existing MCP bridge avoids a second protocol and preserves the live-Pi source-of-truth boundary from ADR-0001.
- Cursor's hook API can enforce shell, MCP, and `Write` calls before execution. The earlier native-edit `afterFileEdit` restoration approach is not viable because Cursor supplies neither exact pre-edit bytes nor supported post-edit output fields.
- `sessionId` removes Claude-specific naming from the core protocol while preserving zero-breakage compatibility for existing Claude Code wiring.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0019-multi-harness-bridge-cursor-parity.md`
- `docs/engineering/decisions/ADR-0001-pi-claude-bridge-boundary.md` (extended)

Code/templates:

- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/extensions/claude-bridge/index.ts`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `.cursor/hooks.json`
- `.cursor/mcp.json`
- `.cursor/commands/pi-discuss.md`
- `.cursor/commands/pi-plan.md`

## Consequences

- Good: Cursor can use Pi's live bridge without new Pi-state write paths.
- Good: Claude Code compatibility remains intact through `claudeSessionId` alias.
- Good: Read-only discovery remains usable in Cursor while obvious mutations are denied before execution.
- Good: `sessionId` makes future harnesses less Claude-specific.
- Historical: The superseded `afterFileEdit` exact-byte restoration approach is retained here for context; current enforcement does not use it because its event lacks exact preimage/output fields.
- Risk: Shell classification can over-block or under-block unusual commands; ambiguous commands ask by default and tests cover expected cases.
- Risk: Cursor hook API behavior may shift; real-Cursor acceptance remains required before declaring full parity.

## Read when

- Changing bridge request/response protocol fields.
- Adding another client harness.
- Changing Cursor `.cursor/hooks.json`, MCP config, or commands.
- Changing read-only enforcement boundaries.
- Interpreting ADR-0001 for non-Claude clients.

## Extends

- ADR-0001
