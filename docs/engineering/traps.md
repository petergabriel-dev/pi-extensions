# Traps

## Package and dependency boundary

- **Root has two dependency roles.** The published root owns production `diff` plus `"*"` Pi peers and its lockfile; clean setup uses `npm ci --ignore-scripts --legacy-peer-deps`. Nested extension manifests/locks are development bootstrap only; use `npm run bootstrap` for their installs. Pi managed installs disable peer solving.
- **Bootstrap does not eliminate all network use.** Engineering-docs and personal-memory scripts invoke `npx --yes`; uncached TypeScript/tsx packages still require npm registry access during tests/typecheck.
- **Extension dependencies are split.** A test passing in one package does not prove another package is installed. After cloning or lock changes, run root `npm ci --ignore-scripts --legacy-peer-deps`, nested `npm run bootstrap`, then root gate. If nested workflow tests fail before source execution because `node_modules/.bin/tsx`, `tsc`, or `@types/node` is absent, bootstrap first; a temporary ignored `tsx` shim may unblock tests, but remove it afterward.
- **Runtime Pi API and extension dependency versions can differ.** Package-load smoke plus extension typechecks are both required; one does not replace other. Missing nested `tsc` is a dependency/bootstrap failure, not proof of source failure.
- **`npm pack` can fail on cache ownership.** A root-owned entry under `~/.npm/_cacache` causes `npm pack` to return `EPERM`; repair ownership for the current user, then rerun `npm run check:package`.

## Browser verification

- **Chromium is a separate prerequisite.** `playwright-core` does not download a browser; the first browser tool call fails until `cd agent/extensions/browser && npx playwright install chromium` completes.
- **Playwright and Chromium versions can mismatch.** Browser launch errors name `npx playwright install chromium`; reinstall the managed Chromium binary before diagnosing extension behavior.
- **Browser lifecycle has page and context scopes.** `browser_close`/`browser_kill` close only caller's owner page; `/browser off`, `/new`, tree reconstruction to disabled, and `session_shutdown` close the shared persistent context. Verify no Chromium child remains after live tests.
- **Pages are lazy but explicitly capped.** Parent plus `DEFAULT_BROWSER_CONCURRENCY_CAP` child pages are allowed (four pages currently). An agent that never calls a browser tool creates no page; a fifth owner fails with page-cap exhaustion instead of silently sharing a page.
- **Buffers are per-page.** Console and network output belongs to its owner and is capped at 1,000 entries. Parent inspection cannot see child output; restricted explorer proxies force `clear:false` so read-only discovery does not drain buffers.
- **Timeout scope matters.** Browser operation timeout or abort reaps only caller's page, not the shared context or sibling pages. Channel requests also have bounded waits and require matching `requestId` and owner.
- **Explorer browser access follows parent mode.** Build injects all eight browser proxies; Discuss/Plan/Review/Design inject only `browser_console`, `browser_screenshot`, and `browser_network`. Restricted explorers cannot retry mutation proxies; browser mutations are workflow-gated in the parent.
- **Persistent profiles retain site state.** Cookies and storage survive browser relaunches by default; set `PI_BROWSER_PROFILE` to a disposable temp directory when testing clean state.
- **Navigation waits only for DOM readiness.** `browser_goto` uses `waitUntil: "domcontentloaded"`; async requests may still be pending (`agent/extensions/browser/index.ts:579-585`).
- **Eval returns node placeholders.** DOM nodes serialize as exact `"ref: <Node>"`; Task 1 live output matched (`agent/extensions/browser/index.ts:474-496`).
- **Network failures expose Chromium error text.** `requestfailed` stores `request.failure()?.errorText`; Task 1 recorded exact `net::ERR_EMPTY_RESPONSE` for an unread fetch (`agent/extensions/browser/index.ts:756-763`).
- **`pi-tui` resize can trip its width guard.** Resize calls `requestRender()` without `invalidate()`, so stale wider lines can crash the process. Keep `ask-user-question` render caches keyed by width (`agent/extensions/ask-user-question/index.ts:243-249`, `:378-384`, `:565-571`).
- **Inline `tsx -e` is unreliable for ESM-only Pi peers.** Eval may compile as CJS and fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` even after `NODE_PATH` changes. Use package tests for runtime behavior or esbuild bundling with Pi peers externalized for syntax-only checks; live behavior still needs a real Pi session.

## Source isolation versus runtime sharing

- **Workspace isolates source, not Pi home.** Normal launcher reuses global auth, settings, model catalogs, sessions, context, and personal memory. `/login`, `/settings`, `/trust`, `/remember`, and bridge `save_memory` can change shared user state.
- **`--no-session` is not full isolation.** It prevents parent session persistence only. Use secure temporary `PI_CODING_AGENT_DIR` for live tests that save memory or alter settings, then remove it. Workflow plan storage and personal-memory writes honor this override.
- **Bridge plan saves depend on live host resolution.** If historical `MCP error -32000: Pi getAgentDir() unavailable` returns, `save_plan` failed before `writePlanFile`; preserve plan text in chat and retry only in a disposable `PI_CODING_AGENT_DIR` session. Do not add a bridge-side file fallback or use normal user state.
- **Provider overload is not source failure.** For live acceptance, retry a fresh disposable session or another suitable configured model before diagnosing code; keep all temporary auth and state isolated.
- **Never copy runtime state into repository.** Temporary auth/settings copies belong in mode-protected OS temp directories and must be deleted after test.
- **Only `.pi/agents` is tracked below `.pi/`.** Bridge creates ignored `.pi/memory/bridge/`; broad `rm -rf .pi` destroys project agent link.

## Duplicate loading and stale code

- **Pi loader aliases are build-time only.** Static bare imports are required for Pi APIs. `createRequire` and variable-specifier `import()` bypass the alias; broad catches in plan-file host discovery or `gcSessionPlans()` can hide the failure as unavailable host state or an empty plan store. `scripts/check-workspace.mjs` guards shipped entrypoints.
- **Extension auto-discovery ignores `settings.json` removal.** `loader.js:534-539` unconditionally discovers `cwd/.pi/extensions/` then `agentDir/extensions/` before configured paths. Removing `extensions` entries cannot disable either location. Keep retired global copies under `~/.pi/agent/extensions.disabled/`; use `./bin/pi-workspace` for source runs.
- **`pi -e .` can load duplicate extensions.** Without `--no-extensions`, any project-local or restored global copies remain discoverable beside workspace package. Duplicate commands, event listeners, watchers, widgets, and notifications can result.
- **`--no-extensions` disables extensions only.** Global context/settings and other Pi-owned state remain available. Do not describe launcher as fully hermetic.
- **Captured `ExtensionAPI` contexts die after session replacement.** `/fork`, `/new`, session switch, or `/reload` can dispose old extension state: `@earendil-works/pi-coding-agent/dist/core/agent-session.js:573` calls runner `invalidate()` (`@earendil-works/pi-coding-agent/dist/core/runner.js:324,331`), then later API use throws from `assertActive()`. Never cache activation `pi` at module scope; thread current activation `pi` through functions/closures, as `agent/extensions/subagents/index.ts` does for effort and browser-proxy calls.
- **Running Pi keeps loaded source.** After edits, use `/reload` when supported or restart launcher before live acceptance. A passing test against disk does not prove old process reloaded.
- **Upstream docs links can lag package metadata.** When locating Pi host source, prefer the installed package's `repository` field; current `@earendil-works/pi-coding-agent` points to `earendil-works/pi`, package directory `packages/coding-agent`.

## Project marker precedence

- **Nearest ancestor `.pi` wins bridge/project discovery.** Starting below unintended marker can bind bridge IPC, project agents, and project settings to wrong root.
- **This repository’s `.pi/agents` symlink is also the project marker.** Before bridge tests, verify `pwd`, repository `.pi`, Pi bridge status root, and test argument all refer same checkout. Never delete or replace it during cleanup; remove only ignored `.pi/memory/bridge/` or project agents and hook enforcement can disappear unexpectedly.
- **Bundled agents are always in scope.** Definitions load module-relatively. Default user scope is bundled+user; project is bundled+nearest project; both is bundled then user then project, with later same-name definitions winning. The source checkout `.pi/agents` link is only a dev/project mechanism, not npm registration. A selected valid unsafe explorer override is rejected by validation, not replaced silently. Use `agentScope: "project"` or `"both"` to add project definitions.

## Plan-mode verification limits

- **Plan sandbox is not a general test environment.** Repository/home writes and network are denied. `npm ci`, uncached `npx`, CCC init/index, live bridge IPC, and write-heavy tests require Build.
- **Sandbox failures can mimic code failures.** `EPERM` for temp/cache creation and `ENOTFOUND registry.npmjs.org` may indicate Plan restrictions. Rerun in Build before diagnosing source.
- **CCC search is an external prerequisite and not filesystem-read-only.** Install/configure the separate `ccc` CLI before using `ccc_search`; it may start a daemon, write user/project index state, and contact an embedding provider. Use dedicated `ccc_search`; never broaden generic Bash sandbox permissions. Inspect `git diff` afterward: indexing can add ignored-project metadata such as `.gitignore` entries.
- **CCC fallback is deliberate.** A timed-out or empty `ccc_search` result is not source evidence; retry with a narrower query, then use exact `rg`/`read` discovery when the index is unavailable.

## Pi ↔ harness bridge

- **One active owner per project.** Fresh heartbeat from older Pi makes newer bridge passive. Stop old process before testing changed protocol.
- **Bridge root follows nearest marker, not client config path.** MCP `cwd`, Pi cwd, and intended project marker must agree.
- **Bridge protocol tests mutate state.** Core tests save notes, plan, and personal memory. Run against disposable `PI_CODING_AGENT_DIR`, not normal user memory; workflow plans and personal-memory paths now use that injected root.
- **Bridge uses `fs.watch` without polling fallback.** Missed request events become two-second client timeouts. Preserve watcher lifecycle/coalescing behavior and diagnose request files before changing protocol. Plan reads/ticks must remain live workflow-owner requests; never add a direct MCP plan-file fallback.
- **Session lock may be enveloped.** Consumers should read `session.lock ?? session` for compatibility; assuming top-level heartbeat/status breaks against current bridge output.
- **Do not import live owner state.** Earlier direct workflow/discussion module imports produced false plan success and clobbered Notes UI. Use event-bus request/result handoff.
- **Idle widget redraw is load-bearing.** Capture success requires live owner update while Pi waits for input. Unit tests cannot replace real idle UI acceptance.
- **Bridge-down behavior is intentional.** Recall/capture/save must fail loud; no direct memory or plan-file fallback.
- **Large bridge recalls exceed some harness result limits.** Inspect the saved response JSON with `jq`, selecting `.result.prompts` or `.result.memory`, instead of loading a full response into the chat/tool result.
- **Live bridge tests must load current source.** Use `--no-extensions -e <repo-root>` (or explicit repository extension paths), not a stale installed package. Automated PTY runners must continuously drain Pi terminal output or the child can block and cause false request timeouts.
- **Claude MCP config source matters.** `claude mcp add -s user` writes active user registration; editing an assumed sidecar config may not affect `claude mcp list`.
- **Claude Bash rewriting depends on PreToolUse `updatedInput`.** If host stops honoring rewritten input, deny Bash rather than fall back to unsandboxed regex approval.
- **Sandbox bypass flags require explicit denial.** `dangerouslyDisableSandbox` must be rejected before wrapping.
- **Cursor hook verdicts use `permission`, not `decision`.** Command hooks must return `permission` plus supported `user_message`/`agent_message` fields; a `decision` key silently fails to enforce the verdict.
- **`afterFileEdit` has no preimage/output contract.** Cursor supplies edit metadata such as `edits[].old_string`, not exact pre-edit bytes or supported post-edit output fields. Do not attempt a post-write revert; `preToolUse` denies `Write` before execution.
- **Cursor shell classification is conservative.** Known reads allow, obvious writes deny, unknown commands ask. New exotic write forms require deny-pattern coverage.
- **Cursor docs nudge is not a gate.** `.cursor/hooks/docs-nudge.js` asks on `git commit` when staged non-doc changes omit `docs/engineering/**`; malformed input and Git errors allow so commits are never blocked by the nudge.

## Workflow modes and review

- **Shared workflow prompt fragments cross harnesses.** Fragments added to `composeWorkflowPrompt` reach Claude Code and Cursor through `agent/extensions/claude-bridge/index.ts:444-448`, where all five mode prompts are composed. Keep wording harness-neutral; a Pi-only tool name pushes other harnesses onto prose fallback.
- **Mode union is mirrored and has drifted before.** Keep the owner, Caveman union, engineering-docs union, subagents union, and subagents boolean guard aligned (`agent/extensions/workflow-modes/index.ts:16`, `agent/extensions/workflow-modes/caveman.ts:1`, `agent/extensions/engineering-docs/constants.ts:33`, `agent/extensions/subagents/index.ts:156`, `agent/extensions/subagents/index.ts:494-495`). The prose rule alone failed; `scripts/check-workspace.mjs:97-110` now parses all five sites, and the root check runs that guard (`package.json:56-58`).
- **Mode label maps retain a residual gap.** The guard does not parse either typed label record (`agent/extensions/workflow-modes/caveman.ts:5-12`, `agent/extensions/engineering-docs/mode.ts:28-35`). Workflow-modes runs `tsc` (`agent/extensions/workflow-modes/package.json:10-12`), but engineering-docs declares tests only and the root typecheck omits it (`agent/extensions/engineering-docs/package.json:5-7`, `package.json:62`); keep that label map aligned manually.
- **Review confirmation is prompt-enforced.** No structural hook proves user confirmed posting. Keep never-auto-post instruction and perform one explicit confirmation immediately before `gh pr review`.
- **Review body must be inline.** Read-only filesystem rules exclude body-file workflows.
- **Live GitHub checks require installed/authenticated `gh`.** Unit and typecheck success do not validate GitHub access.
- **Saved-plan pointers and progress are session ancestry; bodies are session-scoped agent files.** Bodies live under `<agentDir>/plans/<sessionId>/<planId>.md`, not in the repository, Git-branch store, or bridge directory. Ephemeral sessions do not promise restart persistence; never add a shared fallback plan file.
- **Plan files are immutable specs during Build.** `/plan save` writes the body atomically, Section 4 seeds branch-backed tasks, and `workflow_plan_tick` records progress. Do not edit plan checkboxes to claim completion; do not delete a referenced body. Age GC is limited to unreferenced files in the current session. Reconstruct plan state synchronously before awaiting session-start GC so prompt hooks cannot observe default mode/empty state.
- **Plan-file API changes require focused test updates.** Changing agentDir-first signatures without updating test call sites causes typecheck failures and misleading runtime path-safe errors; update fixtures before interpreting suite results.
- **Section 4 metadata is tolerant by design.** `plan-tasks.ts` accepts `**Given**`, `**When**`, and `**Then**` labels with or without a colon, including the template's same-line Given/When/Then form; keep malformed input on the empty-task path.
- **Stale saved plans anchor every active mode.** Active plan body and compact identity/progress marker enter Discuss, Plan, Build, Review, and Design prompts every turn; use `/plan select` or `/plan clear` when active selection changes.
- **Section 4 completion is not full-plan completion.** Tracker progress uses Section 4 only; Section 5 Definition of Done remains a separate closure gate. Report both statuses instead of claiming the whole plan complete.
- **Custom entries and custom messages use different context channels.** Pi `pi.appendEntry()` custom entries stay out of LLM context; `before_agent_start.message` and `pi.sendMessage()` custom messages enter it, and `@earendil-works/pi-coding-agent/dist/core/messages.js:89-96` maps them to LLM role `user` while dropping `CustomMessage.details`. Put model-required tracker data in message `content`, not only `details`; prefix harness-authored content, as in `agent/extensions/workflow-modes/index.ts`.
- **One-shot custom messages do not survive compaction reliably.** `@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js#findValidCutPoints` treats `custom_message` entries as valid cut points, so active-mode authority must be regenerated per turn; reserve one-shot announcements for Off transitions.

## Engineering docs

- **Root spokes contain mixed ownership.** Generator may replace only managed `pi-docs` marker block in `AGENTS.md`/`CLAUDE.md`; surrounding bytes are user-owned.
- **Decision index is generated.** ADR changes can leave `/docs check --check` reporting stale index until `/docs update-index` runs in Build/Off.
- **ADR filenames carry descriptive suffixes.** Do not guess `ADR-0021.md`; discover exact paths with `find docs/engineering/decisions -maxdepth 1 -type f -print` before reading or editing.
- **Tag validator sees literal bracketed examples.** Plan boilerplate containing bare docs tags can be interpreted as real tags. Use exact valid area/action pairs in plan tasks.
- **Docs writes fail closed before workflow state arrives.** If workflow extension is absent/stale, docs extension reports Unknown and blocks writes.
- **Edit/write observers disagree on path identity.** `filechanges` resolves paths against `ctx.cwd` and captures at `tool_call` (`agent/extensions/filechanges/index.ts:51-56`, `agent/extensions/filechanges/index.ts:530-533`); engineering-docs observes successful `tool_result` without `ctx`, slash-normalizes the raw input, then uses substring checks (`agent/extensions/engineering-docs/tracking.ts:15-34`, `agent/extensions/engineering-docs/tracking.ts:63-82`). Their tracked sets can differ; inspect both paths when file-change UI and docs reminders disagree.

## File changes

- **Only successful Pi `edit`/`write` establishes baseline.** Bash, external editor, Cursor, or manual changes are not new tracked baselines.
- **Original text is stored in session.** Sensitive file edits can place preimage in Pi session history even if later declined.
- **Decline is destructive and text-oriented.** It deletes files created after absent baseline and overwrites existing files with recorded UTF-8 content.
- **Partial decline clears tracking after reporting errors.** Inspect warning/console and filesystem immediately; do not assume failed paths remain available for another tracked retry.
- **Accept/decline is not Git.** Neither action stages, commits, or restores untracked changes outside extension log.

## Pi subagents

- **Child tool surface is explicit.** Out-of-process children launch with `--no-extensions` and `agent/extensions/subagents/child.ts`; only loadout-approved tools, `ask_question`, browser proxies, and allowlisted nested `subagent` are registered. Parent verifies toolset mode before launch.
- **Child extension path follows module location.** `resolveSubagentExtensionPath()` derives `child.ts` from `import.meta.url` (`agent/extensions/subagents/launch.ts`); do not hard-code checkout paths. Source and npm installs have different absolute locations, and a missing path causes launch failure before child work starts.
- **cmux send has shell-readiness race.** `new-surface` creates terminal without a command; `CmuxTransport` must poll `read-screen` for a shell prompt before `send`. If readiness or any cmux command fails, close the partial surface and use headless spawn (`agent/extensions/subagents/cmux.ts`, `launch.ts`).
- **Child transcript stays out of parent context.** Only parsed final structured result returns; persisted child session is out-of-band evidence.
- **Nested graph is bounded.** `subagent_agents:` plus depth two controls recursion. Bundled worker allowlists explorer; explorer is leaf. User/project definitions can choose other names only within the same allowlist/depth checks (`agent/extensions/subagents/agents.ts`, `policy.ts`, `index.ts`).
- **Default scope is user.** Project test agent placed under `.pi/agents` is invisible when caller leaves `agentScope` at default.
- **Idle timeout observes IPC activity, not hidden work.** Active child work that emits no IPC activity can hit global idle threshold; `ask_question` parks the child and pauses idle/max-total timers until answer or cancellation.
- **Parked IPC requests need an explicit exemption.** `question` and nested `spawn` use `noDeadline: true`; normal requests keep bounded client timers. Restrict no-deadline mode to those two types, and ensure disconnect/close rejects pending promises so parked work cannot leak (`agent/extensions/subagents/ipc.ts`, `agent/extensions/subagents/child.ts`).
- **Failure tabs are not diagnostics.** cmux surfaces auto-close on failure; inspect the Pi-owned per-run log and bounded recent-output tail instead. Logs are `0600`, directories `0700`, capped at 1 MiB/8 KiB, and redact the exact IPC token. Start/list/progress/failure output identifies `cmux` versus `headless` and exposes log path.
- **Progress callbacks can outlive teardown.** Clear scheduled redraws and tolerate stale UI context on finish/failure.
- **Worker ownership guards are host-local.** `OwnershipLockManager` prevents overlap among children served by one parent host; it does not coordinate another Pi process or external editor (`agent/extensions/subagents/ownership.ts`).
- **Browser proxy owner is IPC identity.** Child browser requests must retain child owner and request correlation; parent browser event handling must not fall back to `parent` owner, or pages/buffers can be shared accidentally (`agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/index.ts`, `agent/extensions/browser/index.ts`).

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
