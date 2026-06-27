# Traps

## Pi ↔ Claude Code bridge

- **Idle widget redraw is load-bearing.** The bridge depends on Pi `ctx.ui.setWidget` updating while Pi is idle. This was manually verified with `idle-widget-spike.ts`; if it regresses, live capture acceptance fails.
- **Do not trust imported extension module state for live handoff.** `save_plan` initially returned OK but `/plan view` showed no plan because the bridge updated an imported workflow module instance. `capture` later overwrote the Notes widget with `Notes: 1` because the bridge imported `discussion-notes` and rendered a private notes array. Use event bus handoff so live extensions own state.
- **Claude models may skip tool checkpoints.** A direct `/discuss` smoke once answered without capture. Polite, task-natural prompts worked; coercive “MUST call tool” phrasing was refused as prompt injection. Acceptance must audit transcript vs Pi notes.
- **Docs validator sees bracketed examples.** Literal `[DOCS:*]` or `[DOCS]` in plan boilerplate can be treated as tags and rejected. Avoid bracketed wildcard examples in generated plan text.
- **fs.watch can miss request creates.** Bridge uses `fs.watch` plus a polling scan fallback because a smoke test missed a request event.
- **Staging must handle all note types.** Initial capture staging ignored `implementation` notes; now non-lesson/preference/decision/requirement/constraint notes map to domain candidates with typed detail.
- **Target project root follows nearest ancestor `.pi`.** A Pi session under `~/Documents/Projects/claude-bridge` resolved to `/Users/petergabrielrlopez` because `~/.pi` existed as ancestor marker.
- **Claude MCP config source matters.** Editing `~/.claude/mcp.json` did not make `claude mcp list` show the server. `claude mcp add -s user ...` wrote the active config to `~/.claude.json`.
- **Hook failures should deny closed.** The read-only hook intentionally denies invalid hook input and denies Bash when macOS `sandbox-exec` is unavailable; sandboxed Bash no longer depends on fresh bridge policy.
- **Claude bridge structural Bash wrapping depends on `updatedInput`.** PreToolUse hooks can rewrite tool input. If that support changes, Claude bridge must deny Bash rather than fall back to regex policy enforcement.
- **Sandbox bypass flags must be denied explicitly.** Claude Code Bash `dangerouslyDisableSandbox` would undermine structural read-only; the Pi bridge hook rejects it before sandbox wrapping.

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

## Persistent-Memory Manual Consolidation

- **Memory only updates on manual command.** Discussion notes and retrieved lesson firings do not update canonical memory by themselves. Run `/memory consolidate` to extract the current session, reconcile staging, apply reinforcement, and clear firing telemetry.
- **Mode reminder is only a reminder.** Leaving discuss/plan/build with high-value content can show “run /memory consolidate” once per session. It must not write staging or canonical memory. Dismissal snoozes for the session.
- **Never-attempted candidates are not terminal.** Interruption, budget exhaustion, missing model, or model-error before a ref is attempted must re-stage the candidate unchanged. Dead-lettering these cases is data loss.
- **Only attempted validation leftovers count toward retry cap.** Increment `reconcile_attempts` only when a candidate was genuinely attempted and left unresolved after validation/adjudication. Dead-letter only at/over cap 3.
- **Refs are positional and diagnostic.** Ref IDs like `session_id:category:index` are generated from candidate array position. Do not use refs as durable retry keys; `reconcile_attempts` travels on the candidate.
- **Immediate ref matching blocks re-staging.** `normalizeCandidateRefs` must not register refs as seen until the action has passed validation. Eager registration can make failed actions look consumed and prevent re-staging.
- **Applied refs tracking scope matters.** Tracking variables like `appliedRefs` must be scoped to the whole reconcile run; narrowing them inside model-only blocks can re-stage already applied candidates.
- **Malformed staging evidence crashes loader.** Validate `source_evidence` before reading `discussion_note_ids` or `lesson_candidate_marker_ids`.
- **Bridge-captured lesson candidates need triggers.** Lesson candidates with empty/missing triggers are structurally invalid unless write-path derivation or loader repair fills them.
- **normalizeExtractionResult strips unknown fields.** Candidate properties not explicitly normalized are dropped during read/rewrite cycles. Preserve `reconcile_attempts` in every `normalize*Candidate` path.
- **Manual canonical writers must share one lock.** `/memory consolidate`, `/memory reconcile`, and `/memory recover` all mutate staging/canonical memory and must fail fast under `canonical-writer.lock` instead of interleaving.
- **Bare `/memory` must not default to Consolidate.** Consolidate can start an agent save turn, so the menu cursor starts on a neutral row (Inspect / advanced), not Consolidate, even when Consolidate is marked recommended.
- **Modal save turns are best-effort.** Pi extensions can send a user message and register `save_to_memory`, but cannot force the main agent to call that tool. Always keep the missed-turn nudge and typed `/memory consolidate` fallback; otherwise a skipped tool call becomes silent data loss.
- **Non-interactive `/memory` has no menu.** When `ctx.hasUI` is false, bare `/memory` must show typed usage instead of trying to render an overlay.
- **Recover must delete deadletters only after staging write.** If validation or write fails, leave the deadletter file in place and report it. Never drop malformed deadletters silently.
- **Consolidate needs the live branch.** `/memory consolidate` depends on `ctx.sessionManager.getBranch()`. If that API is unavailable, fail before extraction instead of staging an empty or stale snapshot.
- **Firing telemetry spans sessions.** Do not clear `firings.jsonl`/session firing state on shutdown. Clear only after `/memory consolidate` successfully applies reinforcement.
- **No memory model fallback exists.** Persistent-memory model calls inherit `ctx.model`; if it is unavailable, fail clearly instead of silently picking another model or resurrecting pinned/env override behavior.
- **Domain-heavy backlogs can time out as one prompt.** Prefer deterministic shortlist/add paths and bounded adjudication; legacy non-lesson model reconciliation still needs chunk-size checks.
- **Host-import limitation in standalone testing:** Standard Node test scripts can fail when index.ts imports Pi host packages or optional provider deps. Pure logic belongs in isolated modules; optional dynamic imports should warn rather than crash tests.
- **`setFooter` is single-owner UI surface:** Persistent-memory metering must use `ui.setStatus` and `ui.setWidget` only. Do not use `ui.setFooter`; `tps-footer.ts` may own the footer and a second owner would clobber it.
- **TUI surfaces are context UI, not host UI:** Do not use `pi.ui` for `setStatus`/`setWidget`; persistent-memory gates `ctx.ui` calls with `ctx.hasUI` before updating the memory meter.
- **Optional-call does not guard the receiver:** `ui.setStatus?.(...)` only guards an absent method; it still throws if `ui` itself is undefined. Check the receiver first, as `updateMemoryMeter` does.
- **Overlay key handling belongs to TUI primitives:** Do not compare raw input bytes like `data === "\u001b"` or `"\u001b[A"` in `ctx.ui.custom` overlays; Pi may not deliver those exact strings. Delegate to `SelectList.handleInput` (see `agent/extensions/persistent-memory/index.ts`) or use framework key helpers such as `matchesKey` (see `agent/extensions/workflow-modes/index.ts`).
