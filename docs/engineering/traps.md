# Traps

## Engineering docs

- **Root agent entrypoint spokes are shared user files.** `AGENTS.md` and `CLAUDE.md` may contain hand-written content. Engineering-docs generation must update only the `pi-docs` marker block and must preserve bytes outside that block.

## Pi ↔ Claude Code bridge

- **Idle widget redraw is load-bearing.** The bridge depends on Pi `ctx.ui.setWidget` updating while Pi is idle. This was manually verified with `idle-widget-spike.ts`; if it regresses, live capture acceptance fails.
- **Do not trust imported extension module state for live handoff.** `save_plan` initially returned OK but `/plan view` showed no plan because the bridge updated an imported workflow module instance. `capture` later overwrote the Notes widget with `Notes: 1` because the bridge imported `discussion-notes` and rendered a private notes array. Use event bus handoff so live extensions own state.
- **Pi session entries are not durable saved-plan storage.** Pi core `appendEntry` can report success while `_persist` silently skips a session write (for example, no session file or no assistant message). `workflow-modes` therefore writes `plan-store.ts`'s project+branch file before changing live state; bridge recall must query that live state, never retain a plan cache.
- **Claude models may skip tool checkpoints.** A direct `/discuss` smoke once answered without capture. Polite, task-natural prompts worked; coercive “MUST call tool” phrasing was refused as prompt injection. Acceptance must audit transcript vs Pi notes.
- **Docs validator sees bracketed examples.** Literal `[DOCS:*]` or `[DOCS]` in plan boilerplate can be treated as tags and rejected. Avoid bracketed wildcard examples in generated plan text.
- **fs.watch can miss request creates.** Bridge uses `fs.watch` plus a polling scan fallback because a smoke test missed a request event.
- **Target project root follows nearest ancestor `.pi`.** A Pi session under `~/Documents/Projects/claude-bridge` resolved to `/Users/petergabrielrlopez` because `~/.pi` existed as ancestor marker.
- **Claude MCP config source matters.** Editing `~/.claude/mcp.json` did not make `claude mcp list` show the server. `claude mcp add -s user ...` wrote the active config to `~/.claude.json`.
- **Hook failures should deny closed.** The read-only hook intentionally denies invalid hook input and denies Bash when macOS `sandbox-exec` is unavailable; sandboxed Bash no longer depends on fresh bridge policy.
- **Claude bridge structural Bash wrapping depends on `updatedInput`.** PreToolUse hooks can rewrite tool input. If that support changes, Claude bridge must deny Bash rather than fall back to regex policy enforcement.
- **Sandbox bypass flags must be denied explicitly.** Claude Code Bash `dangerouslyDisableSandbox` would undermine structural read-only; the Pi bridge hook rejects it before sandbox wrapping.
- **Cursor native edits have a revert window.** Cursor has no pre-edit deny hook in v1; `afterFileEdit` restores pre-edit bytes and fails loud after the write lands. This preserves Pi-state boundaries but still creates a brief on-disk mutation window.
- **Cursor shell classification is conservative, not complete.** `beforeShellExecution` denies obvious writers, allows known read-only discovery, and asks on ambiguous commands. Exotic write paths can require new deny patterns after real-Cursor acceptance.
- **Only the active bridge owner processes protocol changes.** A newly opened Pi session may not own the bridge if an older Pi process is still heartbeating; stop the old owner before verifying changed bridge behavior.

## Pi subagents

- **In-process child sessions are viable but must be isolated.** The spike verified a child `AgentSession` can be created from a tool's `execute()`, read a file, persist a session, and leave parent branch/UI state unchanged. Keep child sessions on a fresh `SessionManager.create(ctx.cwd)` and dispose them in `finally`.
- **Worker build-gate belongs in the parent tool.** Child sessions disable extensions, so they do not inherit workflow-modes mutation blocking. `spawn_worker` must fail closed before spawning unless workflow mode is build.
- **Do not rely on child transcripts for parent context.** Parse and return the final assistant text into structured explorer/worker fields; inspect persisted child sessions only out-of-band.
- **Progress redraws can outlive JSON-mode teardown.** Scheduled widget redraws may hit stale extension contexts after session teardown. Widget rendering must tolerate stale `ctx` and clear scheduled redraws when a progress handle finishes.
- **Widget keys must not clobber other extensions.** Use the dedicated `subagents-progress` widget key; do not reuse discussion-notes or TPS footer widget/status keys.
- **Faux-provider verification order matters.** For nested worker→explorer smokes, faux responses must match the parent worker call, nested explorer call, explorer final answer, then worker final answer.
- **Agent scope in smokes must match file placement.** A project-scoped test agent must live under `<cwd>/.pi/agents`; placing it in a temp user agent dir while passing `agentScope: "project"` makes discovery return no agents.
- **Idle timeout still fires for silent tools.** The subagent watchdog resets idle on child events, not on hidden process activity. A tool that legitimately runs with no child events longer than `idleTimeoutMs` can be aborted even though it is doing work; tune `subagents.idleTimeoutMs` or pass per-call `idleTimeoutMs` for those jobs.
- **Current-process extension tools may be stale after local edits.** The already-running Pi process can keep old extension code loaded. Verify changed subagent tool behavior in a fresh `pi -p --no-extensions -e agent/extensions/subagents/index.ts ...` subprocess when checking new timeout fields or structured failure details.

## Memory architecture

- **Do not put project truth in `/remember` or `save_memory`.** Personal memory is user-global. Project facts, architecture, conventions, invariants, traps, and decisions belong under `docs/engineering/`.
- **Personal memory index can still bloat context.** `~/.pi/memory/MEMORY.md` loads by default. Keep names/descriptions concise; migrate project-specific facts into docs instead.
- **Legacy `~/.pi/memory/` can contain retired persistent-memory files.** A pre-existing directory must not block `~/.pi/memory.md` migration, and files without conforming frontmatter must stay out of `MEMORY.md` without being bulk-deleted.
- **Full personal entries require explicit fetch.** Default recall/injection includes only the index. Use `recall_memory_entry(slug)` / bridge `recall_entry` when an indexed entry is relevant.
- **Bridge capture is not memory capture.** `capture_note` updates live discussion notes/Notes widget only. It does not write engineering docs or personal memory.
- **Model-obedience memory capture failed E2E.** Do not reintroduce a design where reliable capture depends on a model choosing to call a tool.
- **Running Pi can have stale bridge code.** After bridge handler changes, live protocol tests can still fail with old request-type lists until Pi bridge reloads.
- **Overlay key handling belongs to TUI primitives.** Do not compare raw input bytes like `data === "\u001b"` or `"\u001b[A"` in `ctx.ui.custom` overlays; Pi may not deliver those exact strings. Delegate to `SelectList.handleInput` or use framework key helpers such as `matchesKey`.
