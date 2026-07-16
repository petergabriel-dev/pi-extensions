# Traps

## Engineering docs

- **Root agent entrypoint spokes are shared user files.** `AGENTS.md` and `CLAUDE.md` may contain hand-written content. Engineering-docs generation must update only the `pi-docs` marker block and must preserve bytes outside that block.

## Workflow modes and CCC

- **Review never-auto-post is prompt-enforced, not a hard confirmation hook.** Keep the explicit confirmation instruction in the review prompt; do not claim posting is structurally confirmation-gated.
- **Review posting must use an inline body.** Use `gh pr review --body ...`; Review's read-only filesystem means there is no `--body-file` workflow.
- **The workflow-mode union is duplicated across exactly four files.** Keep `agent/extensions/workflow-modes/index.ts`, `agent/extensions/workflow-modes/caveman.ts`, `agent/extensions/subagents/index.ts`, and `agent/extensions/engineering-docs/constants.ts` aligned when changing modes.
- **`ccc search` is not filesystem-read-only.** CCC may start a daemon, write `~/.cocoindex_code/daemon.log` and index artifacts, and contact an embedding provider. Running it through Plan/Discuss Bash fails under structural sandboxing with `PermissionError` on `daemon.log`. Use dedicated `ccc_search`; do not add broad home-write or network exceptions to generic Bash sandbox.
- **Reload before live tool acceptance.** Running Pi keeps old extension registration after source edits. Run `/reload` before inspecting `ccc_search` metadata or testing Plan/Build behavior.

## Pi ↔ Claude Code bridge

- **Idle widget redraw is load-bearing.** The bridge depends on Pi `ctx.ui.setWidget` updating while Pi is idle. This was manually verified with `idle-widget-spike.ts`; if it regresses, live capture acceptance fails.
- **Do not trust imported extension module state for live handoff.** `save_plan` initially returned OK but `/plan view` showed no plan because the bridge updated an imported workflow module instance. `capture` later overwrote the Notes widget with `Notes: 1` because the bridge imported `discussion-notes` and rendered a private notes array. Use event bus handoff so live extensions own state.
- **Session-plan restart durability requires a persisted session.** Pi may defer creating/flushing a session file until an assistant message exists, and ephemeral sessions never persist. `workflow-plan` entries still own live branch state; do not add a shared fallback file because it leaks plans across sessions. Bridge recall must query live workflow state and must never retain a plan cache.
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
- **Idle timeout still fires for silent provider waits or tools.** The subagent watchdog resets idle on child events, not hidden work. A role agent can be aborted after the global 10-minute idle threshold despite ongoing silent work; tune only global `subagents.idleTimeoutMs`, never a per-call override.
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
