---
id: ADR-0001
title: Pi Claude Code bridge boundary
status: Active
date: 2026-05-26
updated: 2026-06-29
---

# ADR-0001: Pi Claude Code bridge boundary

## Decision

- Pi remains source of truth for engineering docs validation, discussion notes, personal memory recall, and build handoff.
- Project memory is engineering docs; personal cross-repo memory is `~/.pi/memory.md` per ADR-0016.
- Claude Code is a thin read-only planning client for existing Pi projects in v1.
- Claude Code side talks to Pi through a small file protocol under `<project>/.pi/memory/bridge/` and imports no Pi internals.
- The Pi bridge extension is the only Pi-coupled layer and reuses real sibling extension functions.
- `capture_note` updates live discussion notes through the event bus and never writes retired memory queues.
- `recall_memory` returns engineering docs, `~/.pi/memory.md`, workflow prompts, and saved-plan context; it does not read retired private memory indexes.
- A live active Pi session is required for bridge use; bridge tools fail loudly when Pi is not running or bridge heartbeat/policy is stale.
- Claude Code mutation tools are denied in `.pi` projects; Bash is structurally sandboxed or denied closed.

## Why

- Live Notes visibility is core user value: notes captured from Claude Code must appear in the active Pi session.
- Project memory belongs in engineering docs so humans and non-Pi tools can read it.
- Personal memory is host-loaded from a small markdown file, not extracted by model behavior.
- Build should stay in Pi so plan-mode/read-only boundaries remain clear.
- Fail-loud behavior prevents users from believing memory/notes/plans were captured when Pi was not active.
- One active bridge session per project avoids duplicate file watchers processing the same request stream.

## Alternatives rejected

- Direct Claude Code project-memory parsing outside Pi: rejected because docs validation, workflow prompts, saved plans, and Notes widget state belong to live Pi.
- Silent capture queue for later Pi startup: rejected because it breaks live Notes visibility and can mislead users.
- Claude Code write/edit in Pi projects with prompt-only guard: rejected because model instructions are not enforcement.
- Model-driven memory extraction as a reliability boundary: rejected by E2E; gpt-5.5 can skip mandatory tool calls.
- Bootstrap non-Pi projects in v1: rejected to keep v1 focused on existing Pi projects and active session bridge reliability.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0016-memory-engineering-docs-and-personal-memory.md`

Code:

- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/personal-memory/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/claude-bridge-client/test-core-protocol.js`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/discussion-notes.ts`
- `agent/extensions/engineering-docs/filesystem.ts`
- `/Users/petergabrielrlopez/.claude/commands/discuss.md`
- `/Users/petergabrielrlopez/.claude/commands/plan.md`
- `/Users/petergabrielrlopez/.claude/settings.json`

## Consequences

- Good: Claude Code can discuss/plan with Pi docs, Notes, personal memory, and workflow prompts while Pi remains build system.
- Good: `capture_note` remains live and visible without coupling to retired memory queues.
- Good: `recall_memory` survives deletion of the retired memory subsystem.
- Good: read-only enforcement is structural, not prompt-based.
- Good: core protocol tests can be separated from model compliance acceptance tests.
- Bad/risk: users must keep Pi running/focused in the target project for v1.
- Bad/risk: model compliance is still behavioral for Claude slash-command habits; acceptance must verify actual capture/save-plan tool use.
- Bad/risk: multiple Pi sessions in one project are not supported in v1.

## Read when

- changing bridge capture or recall behavior
- changing personal-memory or engineering-docs memory boundaries
- changing Claude Code `/discuss` or `/plan` commands
- changing bridge request/response protocol
- changing Claude Code read-only hooks
- changing Cursor bridge hooks/templates or multi-harness clients
- changing workflow-modes plan save/build handoff

## Extended by

- ADR-0019

## Supersedes

- None
