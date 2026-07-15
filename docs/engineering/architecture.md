## Pi ↔ multi-harness bridge

Claude Code and Cursor are read-only planning surfaces for existing Pi projects. Pi remains source of truth for engineering docs validation, discussion notes, personal memory recall, workflow prompts, saved-plan handoff, and build execution.

Flow:

1. Pi loads `agent/extensions/claude-bridge/index.ts` in an active interactive session.
2. Bridge resolves the project root from the nearest `.pi/` marker.
3. Bridge creates `<project>/.pi/memory/bridge/{requests,responses,processed}` plus `session.json` and `policy.json` for IPC and liveness.
4. Harness clients use `agent/claude-bridge-client/pi-bridge-mcp.js` to write UUID request JSON files and poll matching responses for up to 2s. Cursor registers the same client through `.cursor/mcp.json`.
5. Pi bridge handles `recall`, `recall_entry`, `save_memory`, `capture`, `validate_tags`, and `save_plan` by reusing Pi-side extension functions.
6. Bridge recall responses include engineering docs, indexed personal memory from `~/.pi/memory/MEMORY.md`, workflow-mode prompts composed with live Caveman preference, and saved-plan context.
7. Client-side bridge code never imports Pi internals; only the Pi bridge extension imports sibling Pi extension code.

Core boundaries:

- **Pi bridge extension:** Pi-coupled layer. Reuses workflow-modes, discussion-notes, engineering-docs, and personal-memory code.
- **MCP bridge client:** Thin file-protocol client. Node stdlib only; no Pi imports. It is shared by Claude Code and Cursor.
- **Claude PreToolUse hook:** Fail-closed read-only guard for any cwd under a `.pi` marker. It blocks mutation tools and `dangerouslyDisableSandbox`. On macOS with `/usr/bin/sandbox-exec`, Bash is allowed only by rewriting the command through a Seatbelt sandbox. If that sandbox is unavailable, Bash denies closed.
- **Cursor hooks:** Project-committed `.cursor/hooks.json` wires `agent/cursor-bridge-client/cursor-readonly-hook.js` for `beforeShellExecution`, `beforeMCPExecution`, and `afterFileEdit`. Shell writes deny, ambiguous shell asks, mutating non-bridge MCP calls deny, and native file edits are reverted from pre-edit bytes with a visible failure message.

Bridge request protocol lives under `<project>/.pi/memory/bridge/`:

- `requests/<uuid>.json`: `{ id, type, payload, ts }`
- `responses/<uuid>.json`: `{ id, ok, result | error }`
- `processed/<uuid>.json`: idempotency cache
- `policy.json`: fresh Bash/read-only policy snapshot sourced from Pi workflow-modes exports
- `session.json`: active bridge session lock + heartbeat

`capture` accepts primary `sessionId` plus deprecated `claudeSessionId`; if both are present, `sessionId` wins. `capture` and `save_plan` use the Pi event bus rather than imported extension module state. `claude-bridge` emits `discussion-notes:add`; the live `discussion-notes` extension updates its own notes array, appends the session snapshot, and redraws the Notes widget. It does not stage memory candidates. `claude-bridge` emits `workflow-modes:save-plan`; the live `workflow-modes` extension appends a `workflow-plan` entry to the active session branch before updating live state, then returns `workflow-modes:save-plan-result`. Recall gets saved-plan state only through live `workflow-modes:get`; unavailable live state is an error, never a bridge cache or direct file read.

`recall_memory` returns project docs and a compact personal-memory index instead of retired private indexes. Project truth comes from `docs/engineering/`; cross-repo personal preferences/traps live under `~/.pi/memory/` through `agent/extensions/personal-memory/store.ts` and are fetched on demand by slug. See ADR-0016 and ADR-0017.

## Workflow modes read-only Bash sandbox

`agent/extensions/workflow-modes/plan-state.ts` resolves saved plans from ordered `workflow-plan` custom entries in the selected Pi session branch. Latest ancestral save or clear wins. New sessions have no plan; forks inherit only state present before their fork point; session resume and tree navigation reconstruct state from the selected ancestry. No repository- or Git-branch-scoped plan file participates.

`agent/extensions/workflow-modes/index.ts` owns Pi-side mode prompts, branch-local Caveman preference, prompt composition, and discuss/plan tool gating. `agent/extensions/workflow-modes/caveman.ts` preserves the `caveman-mode-state` entry contract, defaults branches without an explicit entry to ON, and supplies the shared Caveman/normal-style composition logic. `/caveman` changes the retained preference; Discuss, Plan, and Build apply it, while Off injects no workflow or Caveman-related prompt and reports the preference as inactive. Claude/Cursor bridge recall reads live `cavemanEnabled` through `workflow-modes:get` and uses the same composition export for all three workflow prompt fields.

Mode prompt constants are also the single source of truth for the ponytail lazy-senior-dev reflex: Build carries the full minimal-code ruleset, while Discuss and Plan carry the scope-time subset that questions need, separates required behavior from nice-to-haves, and preserves non-negotiable correctness guardrails. Prompt injection in `before_agent_start` directs subagent delegation when the subagents extension is available: Discuss keeps quick lookups inline and uses `spawn_explorer` only for genuine multi-file/symbol sweeps; Plan defaults multi-file/symbol fan-out to `spawn_explorer` while the parent synthesizes; Build uses the worker-orchestration A+B model and spawns one `spawn_worker` per substantial confirmed saved-plan Section-4 task, with the parent retaining task selection, verification, commit, and confirmation. This integration is prompt-only; structural gates remain unchanged.

Mutation tools remain blocked in discuss/plan. For Bash, the hook first tries `wrapCommand()` from `agent/extensions/workflow-modes/sandbox.ts`; when a launcher is detected, the command is rewritten in place before execution. If no launcher exists, or wrapping throws, the hook falls back to the shared regex policy from `policy.ts`.

Supported launcher paths:

- macOS: `/usr/bin/sandbox-exec`, with a Seatbelt profile denying `network*` and `file-write*`, then re-allowing writes under a scratch `TMPDIR` and `/dev/null`.
- Linux: `bwrap`, with `--unshare-net`, a read-only bind of `/`, scratch `TMPDIR`, and `PYTHONDONTWRITEBYTECODE=1`.
- No launcher: conservative read-only allowlist plus mutation/redirect denies.

The Pi bridge still writes `policy.json` snapshots for clients and compatibility, but Claude bridge read-only Bash no longer depends on policy freshness or `planBashAllow` gating. Its Node-stdlib PreToolUse hook returns `hookSpecificOutput.updatedInput` so macOS Claude Code Bash calls under `.pi` projects are wrapped in `sandbox-exec` whenever available. Missing, stale, or expired bridge policy does not block sandboxed Bash; absence of `sandbox-exec` blocks Bash entirely.

## CCC semantic search boundary

`agent/extensions/ccc-search/index.ts` registers `ccc_search` as the semantic discovery path in every workflow mode. The tool invokes fixed `ccc search` argv through Node `execFile`; query text and filters never enter a shell. Its schema and runtime checks bound query, language filters, project-relative path glob, pagination, timeout, and output. Abort signals terminate the child process.

This narrow tool sits outside generic Plan/Discuss Bash sandboxing because CCC search uses its daemon under `~/.cocoindex_code/`, may refresh ignored index artifacts under project `.cocoindex_code/`, and may contact its configured embedding provider. The tool exposes search plus optional refresh only. It never initializes projects or exposes daemon/reset commands; initialization and index management remain explicit Build-mode CLI operations.

## Pi subagents

Pi subagents live in `agent/extensions/subagents/` and run as persisted in-process child `AgentSession`s created from extension tool execution. The parent exposes `spawn_explorer` and `spawn_worker`; both call `runSubagent()` in `agent/extensions/subagents/spawn.ts`, which creates a fresh `SessionManager.create(ctx.cwd)`, disables child extension/theme/skill/context-file discovery, and captures only the final structured return for the parent.

Roles:

- **Explorer:** read-only discovery role. `spawn_explorer` validates tools are limited to `read`, `grep`, `find`, and `ls` before spawning. It works in all workflow modes and returns parsed summary/findings/files/open questions. Workflow mode prompts use it with thresholds: sparse in Discuss, default for Plan fan-out.
- **Worker:** coding role. `spawn_worker` first queries `workflow-modes:get` and refuses unless `workflow-modes:state.mode === "build"`. Worker children receive coding tools plus a nested `spawn_explorer` custom tool; they do not receive `spawn_worker`. Build-mode prompts direct sequential one-worker-per-substantial-saved-task delegation while keeping verification, commits, and confirmation in the parent.

Child sessions are persisted as normal Pi sessions, making each subagent run inspectable after completion and providing the session-file foundation for future Context Transfer branch artifacts. The child transcript is not appended to the parent branch; parent context receives only the structured result object and short tool result text.

Concurrency is managed by `agent/extensions/subagents/concurrency.ts`: a configurable default lane (default cap 3), a reserved explorer lane for nested worker→explorer calls, and a worker file-ownership overlap guard. Progress visibility is handled by `agent/extensions/subagents/progress.ts`, which renders the keyed `subagents-progress` widget at a 250 ms throttle and clears it when runs finish.

Subagent timeouts are idle-based with an absolute backstop. `agent/extensions/subagents/timeout.ts` provides a host-import-free watchdog with `touch()` resetting only the idle timer and `maxTotalMs` remaining absolute. `runSubagent()` touches the watchdog on every child `AgentSessionEvent`, so streaming `message_update` events and tool lifecycle events keep an active child alive while silence past `idleTimeoutMs` aborts as `failureKind: "idle"`. `maxTotalMs` aborts continuously active runaway children as `failureKind: "max_total"`; timeout failures preserve partial output and include `partialWork`. `timeout-policy.ts` resolves one policy for `spawn_explorer`, nested explorer, `spawn_worker`, and `subagents_debug_run_agent`: validated global `subagents` settings or 600,000ms idle / 1,200,000ms max-total defaults. Role-agent schemas expose no per-call timeout fields.

## Engineering docs extension

`agent/extensions/engineering-docs/` owns managed project docs under `docs/engineering/`. `/docs init` scaffolds canonical docs, writes `docs/engineering/manifest.json`, regenerates the decisions index, and emits root entrypoint spokes (`AGENTS.md`, `CLAUDE.md`) through a non-destructive `pi-docs` marker block. The spokes are pure pointers to canonical docs; the manifest `generated` list tracks the decisions index plus spoke files. `/docs check` validates spoke marker blocks and linked doc paths, then repairs missing/stale blocks only when writes are allowed.

## Memory architecture

Project memory now lives in engineering docs under `docs/engineering/`:

- `architecture.md` for system shape and component boundaries.
- `dev-workflow.md` for how to operate and verify the system.
- `conventions.md`, `invariants.md`, and `traps.md` for rules and known failure modes.
- `decisions/ADR-*.md` for decisions and superseded history.

Cross-repo personal memory is a user-global markdown store under `~/.pi/memory/`. `agent/extensions/personal-memory/store.ts` owns the indexed store and `agent/extensions/personal-memory/index.ts` wires it into Pi:

1. Entries are slugged markdown files with frontmatter and body text.
2. `MEMORY.md` is a generated index of entry names, descriptions, and links.
3. `/remember <text>` validates a small text snippet, saves or overwrites a slug entry, and rebuilds `MEMORY.md`.
4. `before_agent_start` injects only the compact index block when present; full entry bodies stay out of default prompt context.
5. `recall_memory_entry(slug)` fetches one full entry when the injected index shows it is relevant.
6. Legacy `~/.pi/memory.md` migrates once into `~/.pi/memory/`, then moves to `memory.md.bak`.

There is no automatic model extraction or reconciliation pipeline. Reliability comes from host file writes/reads for personal memory and explicit docs edits for project truth. The personal index is injected by default; full entries require explicit fetch.

Claude bridge recall combines the two sources: engineering docs plus the personal-memory index. Bridge `recall_entry` fetches one personal entry, `save_memory` writes one personal entry, and `capture` updates live discussion notes only. See ADR-0016 and ADR-0017.
