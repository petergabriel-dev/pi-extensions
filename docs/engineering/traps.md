# Traps

## Package and dependency boundary

- **Root has two dependency roles.** The published root owns production `diff` plus `"*"` Pi peers and its lockfile; clean setup uses `npm ci --ignore-scripts --legacy-peer-deps`. Nested extension manifests/locks are development bootstrap only; use `npm run bootstrap` for their installs. Pi managed installs disable peer solving.
- **Bootstrap does not eliminate all network use.** Engineering-docs and personal-memory scripts invoke `npx --yes`; uncached TypeScript/tsx packages still require npm registry access during tests/typecheck.
- **Extension dependencies are split.** A test passing in one package does not prove another package is installed. After cloning or lock changes, run root `npm ci --ignore-scripts --legacy-peer-deps`, nested `npm run bootstrap`, then root gate.
- **Runtime Pi API and extension dependency versions can differ.** Package-load smoke plus extension typechecks are both required; one does not replace other.
- **Inline `tsx -e` is unreliable for ESM-only Pi peers.** Eval may compile as CJS and fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` even after `NODE_PATH` changes. Use package tests for runtime behavior or non-bundled esbuild transpilation for syntax-only checks.

## Source isolation versus runtime sharing

- **Workspace isolates source, not Pi home.** Normal launcher reuses global auth, settings, model catalogs, sessions, context, and personal memory. `/login`, `/settings`, `/trust`, `/remember`, and bridge `save_memory` can change shared user state.
- **`--no-session` is not full isolation.** It prevents parent session persistence only. Use secure temporary `PI_CODING_AGENT_DIR` for live tests that save memory or alter settings, then remove it.
- **Provider overload is not source failure.** For live acceptance, retry a fresh disposable session or another suitable configured model before diagnosing code; keep all temporary auth and state isolated.
- **Never copy runtime state into repository.** Temporary auth/settings copies belong in mode-protected OS temp directories and must be deleted after test.
- **Only `.pi/agents` is tracked below `.pi/`.** Bridge creates ignored `.pi/memory/bridge/`; broad `rm -rf .pi` destroys project agent link.

## Duplicate loading and stale code

- **Extension auto-discovery ignores `settings.json` removal.** `loader.js:534-539` unconditionally discovers `cwd/.pi/extensions/` then `agentDir/extensions/` before configured paths. Removing `extensions` entries cannot disable either location. Keep retired global copies under `~/.pi/agent/extensions.disabled/`; use `./bin/pi-workspace` for source runs.
- **`pi -e .` can load duplicate extensions.** Without `--no-extensions`, any project-local or restored global copies remain discoverable beside workspace package. Duplicate commands, event listeners, watchers, widgets, and notifications can result.
- **`--no-extensions` disables extensions only.** Global context/settings and other Pi-owned state remain available. Do not describe launcher as fully hermetic.
- **Running Pi keeps loaded source.** After edits, use `/reload` when supported or restart launcher before live acceptance. A passing test against disk does not prove old process reloaded.
- **Upstream docs links can lag package metadata.** When locating Pi host source, prefer the installed package's `repository` field; current `@earendil-works/pi-coding-agent` points to `earendil-works/pi`, package directory `packages/coding-agent`.

## Project marker precedence

- **Nearest ancestor `.pi` wins bridge/project discovery.** Starting below unintended marker can bind bridge IPC, project agents, and project settings to wrong root.
- **This repository’s `.pi/agents` is also marker.** Before bridge tests, verify `pwd`, repository `.pi`, Pi bridge status root, and test argument all refer same checkout.
- **Bundled agents are always in scope.** Definitions load module-relatively. Default user scope is bundled+user; project is bundled+nearest project; both is bundled then user then project, with later same-name definitions winning. The source checkout `.pi/agents` link is only a dev/project mechanism, not npm registration. A selected valid unsafe explorer override is rejected by validation, not replaced silently. Use `agentScope: "project"` or `"both"` to add project definitions.

## Plan-mode verification limits

- **Plan sandbox is not a general test environment.** Repository/home writes and network are denied. `npm ci`, uncached `npx`, CCC init/index, live bridge IPC, and write-heavy tests require Build.
- **Sandbox failures can mimic code failures.** `EPERM` for temp/cache creation and `ENOTFOUND registry.npmjs.org` may indicate Plan restrictions. Rerun in Build before diagnosing source.
- **CCC search is an external prerequisite and not filesystem-read-only.** Install/configure the separate `ccc` CLI before using `ccc_search`; it may start a daemon, write user/project index state, and contact an embedding provider. Use dedicated `ccc_search`; never broaden generic Bash sandbox permissions.

## Pi ↔ harness bridge

- **One active owner per project.** Fresh heartbeat from older Pi makes newer bridge passive. Stop old process before testing changed protocol.
- **Bridge root follows nearest marker, not client config path.** MCP `cwd`, Pi cwd, and intended project marker must agree.
- **Bridge protocol tests mutate state.** Core tests save notes, plan, and personal memory. Run against disposable `PI_CODING_AGENT_DIR`, not normal user memory.
- **Bridge uses `fs.watch` without polling fallback.** Missed request events become two-second client timeouts. Preserve watcher lifecycle/coalescing behavior and diagnose request files before changing protocol. Plan reads/ticks must remain live workflow-owner requests; never add a direct MCP plan-file fallback.
- **Session lock may be enveloped.** Consumers should read `session.lock ?? session` for compatibility; assuming top-level heartbeat/status breaks against current bridge output.
- **Do not import live owner state.** Earlier direct workflow/discussion module imports produced false plan success and clobbered Notes UI. Use event-bus request/result handoff.
- **Idle widget redraw is load-bearing.** Capture success requires live owner update while Pi waits for input. Unit tests cannot replace real idle UI acceptance.
- **Bridge-down behavior is intentional.** Recall/capture/save must fail loud; no direct memory or plan-file fallback.
- **Claude MCP config source matters.** `claude mcp add -s user` writes active user registration; editing an assumed sidecar config may not affect `claude mcp list`.
- **Claude Bash rewriting depends on PreToolUse `updatedInput`.** If host stops honoring rewritten input, deny Bash rather than fall back to unsandboxed regex approval.
- **Sandbox bypass flags require explicit denial.** `dangerouslyDisableSandbox` must be rejected before wrapping.
- **Cursor native edits have a revert window.** `afterFileEdit` restores pre-edit text after write lands. Exact preimage is required; missing preimage denies closed.
- **Cursor shell classification is conservative.** Known reads allow, obvious writes deny, unknown commands ask. New exotic write forms require deny-pattern coverage.

## Workflow modes and review

- **Mode union is mirrored.** Keep `workflow-modes/index.ts`, `workflow-modes/caveman.ts`, `subagents/index.ts`, and `engineering-docs/constants.ts` aligned when adding/changing modes.
- **Review confirmation is prompt-enforced.** No structural hook proves user confirmed posting. Keep never-auto-post instruction and perform one explicit confirmation immediately before `gh pr review`.
- **Review body must be inline.** Read-only filesystem rules exclude body-file workflows.
- **Live GitHub checks require installed/authenticated `gh`.** Unit and typecheck success do not validate GitHub access.
- **Saved-plan pointers and progress are session ancestry; bodies are session-scoped agent files.** Bodies live under `<agentDir>/plans/<sessionId>/<planId>.md`, not in the repository, Git-branch store, or bridge directory. Ephemeral sessions do not promise restart persistence; never add a shared fallback plan file.
- **Plan files are immutable specs during Build.** `/plan save` writes the body atomically, Section 4 seeds branch-backed tasks, and `workflow_plan_tick` records progress. Do not edit plan checkboxes to claim completion; do not delete a referenced body. Age GC is limited to unreferenced files in the current session.
- **Stale saved plans anchor every active mode.** Active plan body and compact identity/progress marker enter Discuss, Plan, Build, Review, and Design prompts every turn; use `/plan select` or `/plan clear` when active selection changes.
- **Section 4 completion is not full-plan completion.** Tracker progress uses Section 4 only; Section 5 Definition of Done remains a separate closure gate. Report both statuses instead of claiming the whole plan complete.
- **Custom entries and custom messages use different context channels.** Pi `pi.appendEntry()` custom entries stay out of LLM context; `before_agent_start.message` and `pi.sendMessage()` custom messages enter it, and `@earendil-works/pi-coding-agent/dist/core/messages.js#convertToLlm` maps them to LLM role `user`. Prefix harness-authored content, as in `agent/extensions/workflow-modes/index.ts`.
- **One-shot custom messages do not survive compaction reliably.** `@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js#findValidCutPoints` treats `custom_message` entries as valid cut points, so active-mode authority must be regenerated per turn; reserve one-shot announcements for Off transitions.

## Engineering docs

- **Root spokes contain mixed ownership.** Generator may replace only managed `pi-docs` marker block in `AGENTS.md`/`CLAUDE.md`; surrounding bytes are user-owned.
- **Decision index is generated.** ADR changes can leave `/docs check --check` reporting stale index until `/docs update-index` runs in Build/Off.
- **Tag validator sees literal bracketed examples.** Plan boilerplate containing bare docs tags can be interpreted as real tags. Use exact valid area/action pairs in plan tasks.
- **Docs writes fail closed before workflow state arrives.** If workflow extension is absent/stale, docs extension reports Unknown and blocks writes.

## File changes

- **Only successful Pi `edit`/`write` establishes baseline.** Bash, external editor, Cursor, or manual changes are not new tracked baselines.
- **Original text is stored in session.** Sensitive file edits can place preimage in Pi session history even if later declined.
- **Decline is destructive and text-oriented.** It deletes files created after absent baseline and overwrites existing files with recorded UTF-8 content.
- **Partial decline clears tracking after reporting errors.** Inspect warning/console and filesystem immediately; do not assume failed paths remain available for another tracked retry.
- **Accept/decline is not Git.** Neither action stages, commits, or restores untracked changes outside extension log.

## Pi subagents

- **Worker gate belongs in parent.** Child loaders disable extensions, so child does not inherit workflow mutation hook. `spawn_worker` must verify live Build before child creation.
- **Child transcript stays out of parent context.** Only parsed final structured result returns; persisted child session is out-of-band evidence.
- **Nested graph is bounded.** Parent → worker → explorer only. Giving worker another worker tool or explorer any spawn tool breaks recursion bound.
- **Default scope is user.** Project test agent placed under `.pi/agents` is invisible when caller leaves `agentScope` at default.
- **Idle timeout observes emitted events, not hidden work.** Silent provider/tool wait can hit global idle threshold despite underlying activity.
- **Progress callbacks can outlive teardown.** Clear scheduled redraws and tolerate stale UI context on finish/failure.
- **Worker ownership guards are process-local.** They prevent overlap among concurrent runs in same Pi process, not another process or external editor.

## Personal memory and discussion notes

- **Current personal memory is indexed directory, not flat append file.** `~/.pi/memory.md` is legacy migration input only; active entries live under `~/.pi/memory/` with generated `MEMORY.md`.
- **Index can still bloat prompt.** Keep entry names/descriptions concise; fetch full body only by validated slug.
- **Non-conforming legacy Markdown is preserved but not indexed.** Do not bulk-delete unknown files during migration/cleanup.
- **Bridge capture is not memory capture.** It updates selected-branch discussion notes only. `/notes promote` is current-project engineering-doc curation; `/remember` is Pi user-global curation. Never swap destinations.
- **Curation is visible but model-behavioral.** Command dispatch and deterministic writes are host-owned, but classification/merging uses the current session model. Require successful `remember` or edit/write results before claiming persistence.
- **Pi 0.83.0 print command dispatch cannot start curation turns.** Direct/follow-up `sendUserMessage` hangs, `sendMessage({ triggerTurn: true })` exits without a turn, and deferred sends use stale context. Print-mode curation therefore bypasses command registration and transforms input; deterministic notices use `writeSync(1, ...)` because ordinary extension stdout is redirected to stderr. Remove shim when command dispatch becomes awaitable.
- **Explicit slug means replacement.** `remember` with a slug overwrites that exact indexed entry after validation; recall it first and send the complete merged lesson.
- **Memory write serialization is process-local.** Parallel writes in one Pi process queue around `MEMORY.md`; separate Pi processes can still race until cross-process locking is introduced.
- **Discussion notes and prompts are bounded.** Note text over 480 characters fails; filtered listing uses 50-note/50-KiB pages, and oversized project-promotion prompts fail rather than truncate lessons silently.

## Terminal notification

- **Notification protocol depends on terminal environment.** Windows Terminal, Kitty, and OSC-777 terminals use different paths; unsupported terminals may show nothing or render escape sequences.
- **`agent_end` may fire during automated/non-interactive work.** Notification output is side effect, not proof verification succeeded.

## Cleanup

- **Foreground exit is safest.** Use `/quit` or interrupt, wait for process, then remove ignored bridge state.
- **Do not leave tmux/background Pi alive.** Old heartbeat causes passive bridge and tests hit wrong code.
- **Cleanup order matters.** Stop bridge owner before deleting `.pi/memory/bridge`; otherwise watcher can recreate files or emit errors.
