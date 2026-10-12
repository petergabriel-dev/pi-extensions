# Development workflow

## Consumer install and release gates

Install globally, for one project, or temporarily:

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.7.1
pi install -l npm:@lopezpetergabriel/pi-extensions@0.7.1
pi -e npm:@lopezpetergabriel/pi-extensions@0.7.1
pi list
pi update npm:@lopezpetergabriel/pi-extensions
pi remove npm:@lopezpetergabriel/pi-extensions
```

Install commands pin the exact `@0.7.1` release. To upgrade an installed package to latest, run `pi update npm:@lopezpetergabriel/pi-extensions`. Bare `pi update` updates Pi itself, not package extensions.

The package provides eleven extensions, four skills, and two bundled agents. `ccc` must be installed separately for `ccc_search`. Subagent children launch through the parent Pi CLI in RPC mode; no separate terminal transport binary is required. Browser tools additionally require a local Chromium binary; install it with `cd agent/extensions/browser && npx playwright install chromium`. Package-owned global copies stay retired under `~/.pi/agent/extensions.disabled/` and `~/.pi/agent/skills.disabled/`; leave only the non-package `~/.pi/agent/skills/find-skills` symlink active. Use `pi list` to confirm package registration; do not restore raw/global copies, which can register extensions twice.

The package allowlist contains runtime TS/helpers, workflow template, agent/skill Markdown, engineering docs, README.md, LICENSE, CHANGELOG.md, and npm-mandatory nested READMEs. It excludes tests, nested manifests/locks/tsconfigs, bridge clients, Cursor config, `.pi`, `node_modules`, and runtime/user state. Release checks reject forbidden files and enforce ≤512 KiB packed and ≤1 MiB unpacked sizes.

For a clean source/release setup, install the root published dependency/lock, then nested development packages. Pi-managed installs disable peer solving; Pi API imports remain `"*"` peers.

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm test
npm pack --dry-run --json --ignore-scripts
```

Before publication, smoke-test the exact packed artifact without copying normal auth/settings/memory:

```bash
umask 077
PACKAGE_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-package.XXXXXX")"
trap 'rm -rf "$PACKAGE_TEST_DIR"' EXIT INT TERM
npm pack --ignore-scripts --pack-destination "$PACKAGE_TEST_DIR"
mkdir -p "$PACKAGE_TEST_DIR/package" "$PACKAGE_TEST_DIR/agent"
tar -xzf "$PACKAGE_TEST_DIR/lopezpetergabriel-pi-extensions-0.7.1.tgz" \
  -C "$PACKAGE_TEST_DIR/package" --strip-components=1
npm install --prefix "$PACKAGE_TEST_DIR/package" --omit=dev --omit=peer --ignore-scripts
PI_CODING_AGENT_DIR="$PACKAGE_TEST_DIR/agent" \
  pi --no-extensions -e "$PACKAGE_TEST_DIR/package" --list-models
```

`PI_CODING_AGENT_DIR` is honored by workflow plan storage and personal memory. Plan files land under the disposable agent directory; personal-memory files land beside it under `memory/`.

## Release procedure

Run release gates from repository root before publishing:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm test
npm pack --dry-run --json --ignore-scripts
```

Run exact-artifact smoke test above with a disposable `PI_CODING_AGENT_DIR`. Add a `## [0.7.1]` CHANGELOG entry with an explicit `### Breaking` section before publishing. After all gates pass, use `Release v0.7.1` as the release commit message, publish with `npm publish --access public`, then create an annotated `v0.7.1` tag:

```bash
git commit -m "Release v0.7.1"
npm publish --access public
git tag -a v0.7.1 -m "Release v0.7.1"
```

Replace `0.7.1` in commit and tag commands for later releases. Keep annotated tag names in `vX.Y.Z` form and release commit messages in `Release vX.Y.Z` form.

## Bootstrap

Requirements:

- Pi CLI on `PATH`
- Node.js `>=22.19.0`
- npm/network access for first install and uncached `npx` tools
- Optional `ccc` for semantic search and `gh` for live Review-mode GitHub checks

From repository root:

```bash
node --version
pi --version
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm run check
```

`npm run bootstrap` runs nested `npm ci` only in five lockfile-backed development packages:

- `agent/extensions/browser`
- `agent/extensions/ccc-search`
- `agent/extensions/filechanges`
- `agent/extensions/subagents`
- `agent/extensions/workflow-modes`

Root has a production `diff` dependency and lockfile; when preparing a clean source checkout, use `npm ci --ignore-scripts --legacy-peer-deps` before nested bootstrap. Pi-managed package installs disable peer solving. Engineering-docs and personal-memory tests use `npx --yes`, so their first run may still need npm registry access even after bootstrap. If workflow tests report missing nested `tsx`/`tsc` or `@types/node`, treat that as incomplete bootstrap; use `npm run bootstrap` or a temporary ignored `tsx` shim for focused verification, then remove the shim.

## Launch isolated source

```bash
./bin/pi-workspace
```

Launcher resolves repository root from its own path and executes `pi --no-extensions -e <root>`. It disables global **extension** discovery and loads this package explicitly. It does not create a separate Pi home: current auth, settings, model catalogs, sessions, context, and personal memory remain shared.

On first startup:

1. Review project trust prompt before approval.
2. Inspect `[Extensions]` header: exactly eleven paths should resolve inside this repository.
3. Confirm no global extension path appears.
4. Confirm `.pi/agents` resolves to `agent/agents`.
5. Exit with `/quit` when done.

Use `--no-session` for a disposable parent session:

```bash
./bin/pi-workspace --no-session
```

`--no-session` disables session persistence only. Commands such as `/login`, `/settings`, `/trust`, `/remember`, and bridge `save_memory` still target shared Pi-owned user state unless `PI_CODING_AGENT_DIR` is overridden.

## RPC subagent workflow

`subagent` starts a child Pi process and returns immediately. The parent launches it with `process.execPath` and the parent CLI script resolved from `process.argv[1]`, using `--mode rpc`; it does not resolve `pi` from `PATH`. The child receives `--no-extensions`, the module-relative child extension, the exact `--tools` allowlist, `--append-system-prompt`, `--session-id`, `--no-approve`, and optional model/thinking settings. The parent sends the task through RPC `prompt`, not as a positional CLI argument.

Set per-role defaults with `/subagent-model <explorer|worker> <provider/model|inherit>` and `/subagent-effort <explorer|worker> <off|minimal|low|medium|high|xhigh|inherit>`. These commands write Pi settings; no spawn parameter exposes effort. Explorer effort defaults to `low`, worker effort inherits the parent when unset, and explicit explorer `inherit` is persisted to restore parent effort.

Parent-owned runtime state stays outside the repository:

- Unix socket: `$PI_CODING_AGENT_DIR/subagents/<parent-session>.sock`; parent-session socket mode `0600`, directory mode `0700`.
- Loadout: `$PI_CODING_AGENT_DIR/subagents/<parent-session>/<owner>.json`; file mode `0600`.
- Diagnostics: `$PI_CODING_AGENT_DIR/subagents/<parent-session>/<owner>.log`; file mode `0600`, directory mode `0700`, persistent cap 1 MiB. Recent event/text tail is capped at 8 KiB. Child stderr is piped only to this log, never the parent TTY; each line is prefixed once, the exact current-child session warning alone is filtered, and the exact token is redacted across chunks from logs, tail, and failure text. No full environment/auth data is logged.

The parent registers a random IPC token for each run, bound to that owner. The first `hello` frame authenticates the pair; it does not indicate child readiness. Child IPC connects lazily for nested `spawn`, owner-scoped `browser`, and `ownership` requests. Frames are capped at 256 KiB. Questions, follow-ups, results, and activity use RPC; a side-channel disconnect does not fail a run. Only nested `spawn` may use `noDeadline`.

The RPC `prompt` response is readiness and is bounded to 30 seconds. A missing `disposition` means `started`; `handled` means no run started and fails launch. Process exit before `agent_settled` is a classified failure. Final result text is fetched with `get_last_assistant_text` only after `agent_settled`; `get_state` supplies the child session file. Running-child `subagent_message` uses RPC `steer`, delivered at the child's next tool boundary; abort is the hard stop. Child `ask_question` requests are relayed to the user in a FIFO dialog labeled with the nested owner chain. Answering resolves only the matching RPC UI request and queues a redacted main-agent-only `nextTurn` note; dismissing the dialog or lacking UI leaves the question pending. Results return once through an automatic parent follow-up turn; do not poll `subagents_list` for delivery.

Every supported RPC event touches the watchdog. Open tool-call IDs pause idle timeout while max-total continues; parent question waiting pauses both budgets. Every launched run settles exactly once and releases its RPC process, ownership lock, concurrency slot, watchdog, browser page, pending question/IPC requests, and per-run token. RPC children exit on stdin EOF. Cancellation sends RPC `abort`, closes stdin, then escalates to `SIGTERM` after one second and `SIGKILL` 500ms later. Do not hand-run the child command without the parent loadout and socket; use the parent tool for launches.

Run focused tests from the repository root:

```bash
npm --prefix agent/extensions/subagents test
npm --prefix agent/extensions/subagents run typecheck
```

Run the installed-Pi live smoke separately:

```bash
npm run smoke:subagents
```

The smoke resolves installed Pi through global npm metadata, binds its scripted endpoint and test page to loopback, filters inherited Pi/API-secret environment variables, uses a fresh `0700` `PI_CODING_AGENT_DIR` instead of normal `~/.pi` state, and deletes that directory afterward. It exercises parent-to-explorer launch, a child question relayed through the question owner's built-in `ctx.ui.select`/`ctx.ui.input` path in RPC mode (the parent model must not call `subagent_message`), worker-to-nested-explorer spawn, and browser proxy navigation to a local page. It verifies no child processes remain; its main-response deadline is 120 seconds. This checkout's smoke passed on installed Pi 1.1.0; unit/type tests use vendored Pi 0.80.9. Browser reports explicit `PASS` or `SKIP` when Chromium is unavailable. The smoke is not part of `npm test`; `npm test` remains the full automated gate after `npm run bootstrap`.

### Interactive `/agents` and question-relay acceptance

Use `./bin/pi-workspace` in a saved Build-mode TUI session, not `-p` and not after `/new`. Verify:

1. Keep a model question open, trigger a child question, and confirm FIFO order, correct routing for both answers, and parent-turn completion.
2. Dismiss a child dialog with Esc, then answer the still-pending question through `/agents`; confirm the answer reaches the child once.
3. Esc with a queued result: submit restored editor text once, or verify one `nextTurn` fallback when the editor does not own it. `subagents_list` stays pending until matching `message_start`; no turn auto-starts.
4. Quit with a live child; confirm no host-closed failure follow-up, socket removal, and no leftover RPC process.
5. In a disposable Pi home, add a local `worker.md` shadow missing `subagent_agents`; verify one warning names the file and missing key, then remove the fixture.

`npm run smoke:subagents` separately covers RPC child-question UI, nested spawn, and browser proxy. Model questions opening over `/agents` remain out of scope.

## Standard verification gate

After bootstrap:

```bash
npm test
```

GitHub Actions runs the same bootstrap and `npm test` gate for pull requests and branch pushes via `.github/workflows/ci.yml` on Node.js 22.

This runs:

1. Workspace inventory/integrity, package artifact, and read-only engineering-doc checks (full-content decision index, root spokes, and ADR validity).
2. Focused ask-user-question queue test, then CCC, engineering-docs, personal-memory, subagent RPC/timeout/lifecycle, and workflow-mode tests.
3. Configured TypeScript checks.
4. Cursor read-only hook and neutral Cursor-kit tests.

It does not start Pi, call a model, run live bridge protocol tests, exercise file-change rollback interactively, or verify terminal notification rendering.

Useful focused commands:

```bash
npm run check
npm run check:docs
npm run test:ask-user-question
npm run test:extensions
npm run typecheck
npm run test:cursor
npm run test:cursor-kit
bash -n bin/pi-workspace
python3 -m json.tool .cursor/hooks.json >/dev/null
python3 -m json.tool .cursor/mcp.json >/dev/null
```

Production dependency audits:

```bash
for package in ccc-search filechanges subagents workflow-modes; do
  npm --prefix "agent/extensions/$package" audit --omit=dev
done
```

## Test matrix

| Component | Automated gate | Live/manual acceptance |
|---|---|---|
| Root package, eleven entrypoints, four skills, two agents | `npm run check` (includes read-only `check:docs`) | Source header lists eleven extensions once; clean packed artifact loads and discovers bundled explorer/worker; decision index, spokes, and ADRs are current. |
| `browser` | `npm --prefix agent/extensions/browser test` and `npm --prefix agent/extensions/browser run typecheck` | After `npx playwright install chromium`, `/browser on` enables tools; live navigation, console/network inspection, page actions, and screenshots work without orphaning Chromium. |
| `ccc-search` | `npm --prefix agent/extensions/ccc-search test` and `npm --prefix agent/extensions/ccc-search run typecheck` | `ccc_search` works in Build and Plan after project index exists; uninitialized error points to Build. |
| `claude-bridge` | Live `test-core-protocol.js` procedure below | Footer says active; recall/capture/save/validation plus plan task read/tick are visible through live owners. |
| `discussion-notes` | Core protocol exercises event-bus capture/idempotency | `/notes` restores branch state across tree navigation; clear affects selected branch. |
| `engineering-docs` | `npm --prefix agent/extensions/engineering-docs test`; `npm run check:docs` | `/docs check --check` reports managed docs, healthy spokes/ADRs/tags, and full-content current index. |
| `filechanges` | Package load/inventory; no dedicated unit suite | Make disposable `edit`/`write`, inspect cumulative diff, verify accept keeps and decline restores/deletes. |
| `notify` | Package load/inventory; no dedicated unit suite | Finish one assistant turn and confirm terminal-native “Ready for input” notification. |
| `personal-memory` | `npm --prefix agent/extensions/personal-memory test` and `npm --prefix agent/extensions/personal-memory run typecheck` | In isolated Pi home, save slug, inspect generated `MEMORY.md`, fetch one entry. |
| `subagents` | `npm --prefix agent/extensions/subagents test` and `npm --prefix agent/extensions/subagents run typecheck` | `npm run smoke:subagents` exercises installed-Pi RPC launch, question round-trip, nested spawn, and browser proxy; browser reports explicit PASS/SKIP. Smoke is separate from `npm test`. |
| `workflow-modes` | `npm --prefix agent/extensions/workflow-modes test` and `npm --prefix agent/extensions/workflow-modes run typecheck` | Switch modes; verify session-scoped plan body/pointer restoration, tracker progress, Caveman restoration, and read-only gates. |
| `ask-user-question` | `npm run test:ask-user-question` | Queue/relay tests cover model-child FIFO, source-scoped cancellation, RPC select/input, Other, free text, and unavailable/dismissed paths. |
| Claude MCP client + read-only hook | Live core protocol test covers MCP dispatch, bridge-down failure, sandbox allow/deny | `claude mcp list`; real `/discuss` and `/plan` capture/save handoff plus `read_plan_tasks`/`tick_plan_task`. |
| Cursor MCP/hooks/commands | `npm run test:cursor` and `npm run test:cursor-kit` | Real Cursor bridge commands, shell/MCP denial, `Write` pre-tool denial, neutral commands, and commit nudge. |
| Bridge clients under load | Not in root gate | Run dedicated stress harness only against an active disposable bridge and clean all state afterward. |

## Saved plan workflow

`/plan` operates on plans visible in selected session ancestry:

- `/plan save` writes a new immutable plan body to `<agentDir>/plans/<sessionId>/<planId>.md`, seeds tasks from top-level unchecked Section 4 items, appends its pointer, then activates it. It does not overwrite another plan.
- `/plan select` changes active pointer; `/plan view` shows active plan and available ancestry plans; `/plan clear` deactivates the selected plan but leaves its file for retention GC.
- Build progress is branch-backed. Complete and verify one tracker task, then call `workflow_plan_tick`; never edit plan-file checkboxes. The per-turn marker carries only plan identity/path/time, progress counts, and next task.
- Claude Code and Cursor use the same live owner through `save_plan`, `read_plan_tasks`, and `tick_plan_task`; they must not read plan files directly.

## Isolated live bridge protocol test

Core protocol test writes discussion notes, saved-plan state, and personal memory. Never point it at normal user state or the current project bridge. `PI_CODING_AGENT_DIR` is honored by workflow plan storage and personal memory, so use a disposable agent root. Use two terminals and a disposable project marker.

Terminal A, from repository root:

```bash
ROOT="$PWD"
umask 077
PI_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-workspace-bridge.XXXXXX")"
PI_PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-workspace-project.XXXXXX")"
cleanup() {
  rm -rf "$PI_TEST_DIR" "$PI_PROJECT_DIR"
}
trap cleanup EXIT INT TERM
mkdir -p "$PI_TEST_DIR/agent" "$PI_PROJECT_DIR/.pi"
printf 'PI_PROJECT_DIR=%s\n' "$PI_PROJECT_DIR"
for name in auth.json settings.json models-store.json; do
  if [ -f "$HOME/.pi/agent/$name" ]; then
    cp "$HOME/.pi/agent/$name" "$PI_TEST_DIR/agent/$name"
  fi
done
(
  cd "$PI_PROJECT_DIR"
  PI_SKIP_VERSION_CHECK=1 \
  PI_CODING_AGENT_DIR="$PI_TEST_DIR/agent" \
  pi --no-extensions --approve --no-session -e "$ROOT"
)
```

Wait for `Claude bridge: active`. Copy the printed `PI_PROJECT_DIR` value into Terminal B. Temporary credentials and project marker are mode-protected by `umask 077`, live outside repository, and are removed only after the child Pi exits.

Terminal B, same repository root:

```bash
node agent/claude-bridge-client/test-core-protocol.js "/path/to/PI_PROJECT_DIR"
```

Expected: all core protocol checks pass, including MCP plan-task dispatch. Return to Terminal A, enter `/quit`, wait for process exit, then let `cleanup` remove temporary state.

Confirm cleanup:

```bash
find "/path/to/PI_PROJECT_DIR/.pi/memory" -type f -print 2>/dev/null
ps -ax -o pid=,command= | grep -F "/path/to/PI_PROJECT_DIR" | grep '[p]i ' || true
```

Both commands should print nothing. Do not signal the current Pi, delete its bridge state, or leave temporary Pi, tmux, or bridge processes running after tests.

## Claude Code bridge workflow

1. Launch workspace Pi in the target project; confirm `Claude bridge: active` and intended nearest `.pi` root.
2. Register the repo MCP client in Claude's active user registration. Inspect before changing it; remove stale registration before re-adding:

   ```bash
   claude mcp get pi-claude-bridge
   claude mcp list
   claude mcp remove -s user pi-claude-bridge # only when replacing stale registration
   claude mcp add -s user pi-claude-bridge -- node "$PWD/agent/claude-bridge-client/pi-bridge-mcp.js"
   claude mcp get pi-claude-bridge
   claude mcp list
   ```

   Confirm active registration points to the repo client, not an installed copy. `claude mcp add -s user` updates active user registration; do not edit an assumed sidecar config.

3. Merge hooks into existing Claude settings without replacing other settings or hooks. Append these command-hook entries to the existing `UserPromptSubmit` and `SessionEnd` arrays, preserving all existing entries/matchers; set the single `statusLine` command as shown. Replace `<repo-root>` with repo path in your settings:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<repo-root>/agent/claude-bridge-client/pi-peer-hook.js\"" }] }],
       "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node \"<repo-root>/agent/claude-bridge-client/pi-peer-hook.js\"" }] }]
     },
     "statusLine": {
       "type": "command",
       "command": "node \"<repo-root>/agent/claude-bridge-client/pi-statusline.js\"",
       "refreshInterval": 5
     }
   }
   ```

   Keep unrelated settings and hooks. Validate active settings JSON and run `claude doctor`.

4. Use `/discuss` or `/plan`; state-changing bridge tools require active Pi. Implement only in Pi Build mode.

### Claude bridge live acceptance

Run against a disposable project with isolated Pi agent roots. Register the repo MCP client and hooks above, then verify:

1. `claude mcp get pi-claude-bridge` and `claude mcp list` show the repo client connected; settings JSON parses, `claude doctor` passes.
2. Two Pi RPC sessions in one project report active under separate namespaces. Session IDs were captured separately.
3. Through actual Claude CLI MCP calls, run `list_sessions`, `pair_session`, then `send_message`. Confirm message becomes pending and Pi receives it on its next prompt. Send Pi→Claude with `bridge_message`; statusline script outputs exact `Pi ✉1`; next actual Claude CLI prompt receives injected peer message; acknowledge it and confirm pending count clears. `SessionEnd` unpairs.
4. Live bridge-client check with `harness: "cursor"` sends Cursor identity to a second Pi; Pi replies with `bridge_message`; `read_messages` retrieves and acknowledges reply. This exercises client protocol, not an interactive Cursor model session.
5. Claude Code 2.1.296 print-mode `/clear` without session persistence changes session ID. This verifies CLI behavior, not interactive TUI behavior; explicit supplied `sessionId` takes precedence over stale `CLAUDE_CODE_SESSION_ID` in a separate live client check.
6. Clean shutdown retains an owned namespace with non-live presence and peers; stale namespaces are collected after 10m. Pending mailbox messages are still dropped with a count warning.

The idle statusline script output and `refreshInterval: 5` settings were verified; interactive idle redraw timing/appearance was not separately verified.

#### Restart pairing acceptance (2026-10-12)

Ran in a disposable project with isolated `PI_CODING_AGENT_DIR`, mode-0600 auth/config copies, and current repo extension source loaded in Pi RPC. Temp files and processes were removed after test. `pi --help` showed `--session <path|id>` and `--resume [session]`; `--resume <id>` opened an interactive picker in RPC, so same-ID resumes used `--session <id>` after initial `--session-id <id>`.

- (a) Cleanly stopping Pi A kept `presence.json` and its peer, wrote a non-live heartbeat with both pending counts at zero, and made A disappear from `list_sessions`.
- (b) Resuming A in 406ms restored its peer and showed `(restored 1 peer)`. Pi `bridge_message` then reached the `UserPromptSubmit` hook without an intervening harness request; hook output included the peer message and ack cleared `pendingCount`. Repeated after 5,684ms with same result. Hook was invoked directly with real `UserPromptSubmit` input; interactive Claude TUI rendering was not tested.
- (c) With A down, the client's first live request auto-paired Claude to B. Restarting A dropped that peer; client resolved to B only.
- (d) Backdating A's heartbeat by more than 10m and claiming another namespace triggered GC; A's old namespace disappeared, and same-ID resume restored no peers.
- (e) Shutting down with one outbound message pending dropped it and emitted `claude-bridge dropped 1 pending peer message(s) on shutdown`.

Existing bridge acceptance remains: `recall_memory` returns canonical docs, compact personal-memory index, live prompts, and selected-branch saved plan; `capture_note` updates live Pi Notes UI through `discussion-notes`; `validate_docs_tags` uses engineering-docs validator; `save_plan` appears in Pi `/plan view`; `read_plan_tasks` and `tick_plan_task` use the live branch-backed tracker; Claude mutation tools deny and Bash is sandbox-wrapped where supported, otherwise denied closed.

## Cursor bridge workflow

Repository `.cursor/mcp.json`, `.cursor/hooks.json`, and bridge command templates are relative and ready from workspace root.

1. Launch Pi and confirm intended bridge root.
2. Open same root in Cursor.
3. Use `/pi-discuss` or `/pi-plan`; pass `conversation_id` as `sessionId` when available.
4. Verify recall/capture/save plus `read_plan_tasks`/`tick_plan_task` through `pi-claude-bridge`.
5. Verify read-only shell, non-bridge MCP, and `Write` denial from `preToolUse`.
6. Return to Pi Build for mutations.

Focused hook gates:

```bash
npm run test:cursor
npm run test:cursor-kit
```

## Cursor-neutral workflow

`.cursor/commands/discuss.md`, `.cursor/commands/plan.md`, and `.cursor/commands/build.md` form a standalone workflow for repositories without Pi or bridge configuration.

- `/discuss` asks one focused question at a time, records the working handoff in conversation, and does not edit files.
- `/plan` produces Evidence, Target files, and atomic Given/When/Then tasks with NFRs, verification gates, and commit boundaries. It creates no files during planning and creates only task-named docs during implementation.
- `/build` executes one task at a time, verifies before commit, stops on failure, and reports each checkpoint.
- `npm run test:cursor-kit` covers the commit nudge hook. The nudge asks, never denies, when a commit stages non-doc changes without `docs/engineering/**`; docs-staged, empty, malformed, and Git-failure cases allow.

## Engineering docs

Canonical docs live under `docs/engineering/`; `AGENTS.md`, `CLAUDE.md`, and decisions index are generated outputs.

Inside workspace Pi:

```text
/docs status
/docs check --check
/docs update-index
```

`/docs check --check` is validation-only. `/docs update-index` writes and therefore requires Build/Off. Run index update after ADR changes, then rerun validation.

## Design docs workflow

Use `/mode design` for design-system docs. `/docs init --design` creates missing `docs/design/` files without overwriting curated content. List each token CSS file in `docs/design/manifest.json`, use `/* @primitive */` and `/* @semantic */` sections with `:root` and optional `[data-theme="dark"]`, then run `/docs update-tokens`. `/docs check` reports invalid manifests, stale `tokens.md`, unmarked properties, and preview style literals. Use `/mode build` for component source.

## CCC indexing

Search tool never initializes project. In Build mode, from repository root:

```bash
ccc init
ccc index
ccc search --limit 5 -- "workflow mode state"
```

Use `ccc_search` for agent semantic discovery after initialization. If a query times out or returns no results, retry narrowly, then use `rg`/`read` for exact fallback discovery. Inspect `git diff` after indexing because CCC may update ignored-project metadata such as `.gitignore`; revert unrelated changes. `.cocoindex_code/` is ignored generated state. Do not run `ccc init`, `ccc index`, or daemon maintenance in Discuss/Plan.

## Review mode

Before live GitHub review:

```bash
command -v gh
gh auth status
```

Unit/typecheck success does not prove live GitHub access. Review mode keeps filesystem read-only, allows only scoped read/approved `gh` commands, drafts verdict first, and requires explicit confirmation before posting.

## Plan-mode test restrictions

Plan is source-read-only. Structural sandbox denies repository/home writes and network while allowing a scratch temp directory. Consequences:

- `npm ci`, uncached `npx`, package repair, CCC init/index, live bridge IPC, and tests that write repository fixtures require Build.
- Read-only tests may run when dependencies are already installed and all writes stay in scratch temp.
- `EPERM` creating temp/cache paths or `ENOTFOUND registry.npmjs.org` in Plan can be sandbox/environment failures, not source failures.
- Rerun blocked verification in Build before diagnosing code or recording pass/fail.

## Shutdown and cleanup

- Exit interactive Pi with `/quit` or foreground interrupt; wait for process exit.
- Stop any temporary tmux session explicitly.
- Remove only ignored `.pi/memory/` after bridge process exits; never remove `.pi/agents` or broad `.pi/`.
- Check `git status --short` after tests. Runtime credentials, sessions, memory, logs, DBs, caches, and bridge files must remain absent from Git.
