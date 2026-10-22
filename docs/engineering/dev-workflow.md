# Development workflow

## Consumer install and release gates

For release version `0.9.2`, install globally, for one project, or temporarily:

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.9.2
pi install -l npm:@lopezpetergabriel/pi-extensions@0.9.2
pi -e npm:@lopezpetergabriel/pi-extensions@0.9.2
pi list
pi update npm:@lopezpetergabriel/pi-extensions
pi remove npm:@lopezpetergabriel/pi-extensions
```

Install commands pin the exact `@0.9.2` version. Upgrade an installed package to latest with `pi update npm:@lopezpetergabriel/pi-extensions`. Bare `pi update` updates Pi itself, not package extensions.

The package provides twelve extensions, four skills, and two bundled agents. `ccc` must be installed separately for `ccc_search`. Subagent children launch through the parent Pi CLI in RPC mode; no separate terminal transport binary is required. Browser tools additionally require a local Chromium binary; install it with `cd agent/extensions/browser && npx playwright install chromium`. Package-owned global copies stay retired under `~/.pi/agent/extensions.disabled/` and `~/.pi/agent/skills.disabled/`; leave only the non-package `~/.pi/agent/skills/find-skills` symlink active. Use `pi list` to confirm package registration; do not restore raw/global copies, which can register extensions twice.

Starting with release `0.8.0`, the npm tarball includes runtime TS/helpers, workflow template, agent/skill Markdown, README.md, LICENSE, CHANGELOG.md, required nested READMEs, and exactly six bridge-client runtime files: `agent/claude-bridge-client/pi-bridge-mcp.js`, `agent/claude-bridge-client/pi-readonly-hook.js`, `agent/claude-bridge-client/pi-peer-hook.js`, `agent/claude-bridge-client/pi-statusline.js`, `agent/cursor-bridge-client/cursor-readonly-hook.js`, and `agent/opencode-bridge-client/pi-opencode-plugin.js`. It also ships nine `pi-*` command templates across `agent/harness-commands/{claude,cursor,opencode}/`. It excludes `docs/engineering/**`, `.cursor/**`, tests, nested manifests/locks/tsconfigs, `.pi`, `node_modules`, and runtime/user state. Main retains engineering docs and development material; `.cursor/` commands/config, including Cursor's `pi-build.md`, are repository-only and never ship. The `release` branch mirrors the unpacked tarball file-for-file, with only an optional root `.npmrc` extra. Release checks reject forbidden files and enforce ≤512 KiB packed and ≤1 MiB unpacked sizes.

For a clean source/release setup, install the root published dependency/lock, then nested development packages. Pi-managed installs disable peer solving; Pi API imports remain `"*"` peers.

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm test
npm pack --dry-run --json --ignore-scripts
```

Smoke-test the exact tarball already built at `dist/<tgz>`; never call `npm pack` again. Set `TGZ` to the actual artifact path in the same shell session before running this block:

```bash
umask 077
PACKAGE_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-package.XXXXXX")"
trap 'rm -rf "$PACKAGE_TEST_DIR"' EXIT INT TERM
mkdir -p "$PACKAGE_TEST_DIR/package" "$PACKAGE_TEST_DIR/agent"
tar -xzf "$TGZ" -C "$PACKAGE_TEST_DIR/package" --strip-components=1
npm install --prefix "$PACKAGE_TEST_DIR/package" --omit=dev --omit=peer --ignore-scripts
PI_CODING_AGENT_DIR="$PACKAGE_TEST_DIR/agent" \
  pi --no-extensions -e "$PACKAGE_TEST_DIR/package" --list-models
```

`PI_CODING_AGENT_DIR` is honored by workflow plan storage and personal memory. Plan files land under the disposable agent directory; personal-memory files land beside it under `memory/`.

## Release procedure

Run release gates on main from the repository root:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm run check
npm test
```

After gates pass, build one artifact and smoke-test that same file. For version `X.Y.Z`, `npm pack` writes `dist/lopezpetergabriel-pi-extensions-X.Y.Z.tgz`:

```bash
mkdir -p dist
npm pack --pack-destination dist/
TGZ="dist/lopezpetergabriel-pi-extensions-X.Y.Z.tgz"
```

Run the [exact-artifact smoke test](#consumer-install-and-release-gates) with `TGZ` set to that path. Pi's Git installer uses production dependency installation (`npm install --omit=dev`); check whether that adds Pi peers:

```bash
PEER_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-peer-check.XXXXXX")"
trap 'rm -rf "$PEER_TEST_DIR"' EXIT INT TERM
mkdir -p "$PEER_TEST_DIR/package"
tar -xzf "$TGZ" -C "$PEER_TEST_DIR/package" --strip-components=1
(cd "$PEER_TEST_DIR/package" && npm install --omit=dev)
find "$PEER_TEST_DIR/package/node_modules" \
  \( -path '*/@earendil-works' -o -name typebox \) -print
```

Record whether the command prints `@earendil-works` or `typebox`. If either appears, repeat from a fresh extraction with `.npmrc` containing only `legacy-peer-deps=true` plus a trailing newline; confirm neither appears, then pass `--npmrc` to the release script. Do not create the release tag until this peer check passes.

After gates, smoke test, and peer check pass, create the preparation commit on main and build the stripped release commit/tag from the same artifact:

```bash
git commit -m "Prepare vX.Y.Z"
node scripts/release-branch.mjs --tgz dist/<tgz> --version X.Y.Z [--npmrc]
```

The command is a template; pass the exact `dist/lopezpetergabriel-pi-extensions-X.Y.Z.tgz` produced above and add `--npmrc` only when needed. Script requires clean main, creates a `Release vX.Y.Z` commit on `release` and annotated local tag `vX.Y.Z`, and never pushes. Stop here and wait for explicit approval before publication:

```bash
npm publish dist/<tgz>
```

After publish succeeds, wait for separate explicit push approval before pushing main, release, and tag:

```bash
git push <remote> main
git push <remote> release
git push <remote> vX.Y.Z
```

From `v0.8.0` onward, release tags point to release commits; earlier tags remain on main. Do not infer permission to publish or push from successful checks; wait for explicit approval at each outward-facing step.

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
2. Inspect `[Extensions]` header: exactly twelve paths should resolve inside this repository.
3. Confirm no global extension path appears.
4. Confirm `.pi/agents` resolves to `agent/agents`.
5. Exit with `/quit` when done.

Use `--no-session` for a disposable parent session:

```bash
./bin/pi-workspace --no-session
```

`--no-session` disables session persistence only. Commands such as `/login`, `/settings`, `/trust`, `/remember`, and bridge `save_memory` still target shared Pi-owned user state unless `PI_CODING_AGENT_DIR` is overridden.

## RPC subagent workflow

`subagent` starts a child Pi process and returns immediately. The parent launches it with `process.execPath` and the parent CLI script resolved from `process.argv[1]`, using `--mode rpc`; it does not resolve `pi` from `PATH`. The child receives `--no-extensions`, the module-relative child extension, the exact `--tools` allowlist, `--append-system-prompt`, `--session-id`, and either `--approve` when the parent trusts the project or `--no-approve` otherwise, plus optional model/thinking settings. The parent sends the task through RPC `prompt`, not as a positional CLI argument.

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

## Security corpus regression test

Run the shared adversarial corpus with:

```bash
npm run test:security
```

The runner exercises installed Claude and Cursor hook commands and the installed OpenCode plugin against disposable harness roots, `HOME`, and a temporary Git repo. It evaluates Pi Discuss/Plan shell policy and sandbox wrapping, executes only loader-validated contained cases, and compares repo snapshots before/after each case. The snapshot excludes `.git/index` stat-cache rewrites and includes `git ls-files -s` so tracked-file changes still count. The command runs both the normal lane and the existing sandbox-disabled lane, then reports launcher, execution totals, and pass/fail/known-gap counts by column.

The runner does not launch Claude Code, Cursor, OpenCode, or Pi CLIs; it does not use a model or live bridge. It tests installed config/plugin entrypoints and policy decisions, not host enforcement behavior such as Cursor's reaction to `failClosed` or OpenCode's response to a failed plugin load. GitHub Actions runs `npm run test:security` in the `security-macos` job on `macos-latest` with Node 22; the Ubuntu `test` job also runs it through `npm test`.

Add cases by editing only `scripts/security-corpus.json`: assign a unique id, class, kind, expected outcomes, and columns where needed. For executable shell cases, the loader allows no absolute path except `/dev/null` and rejects `~`, `$HOME`, and `..` references; mark uncontained or UI-injection cases `execute: false`. Keep runnable adversarial text in the corpus, not engineering docs or ADRs.

Use `knownGap: "F<n>"` only for a reproduced, documented finding. The case passes as a known gap only while actual behavior differs from its expected safe outcome. When it starts matching, the runner fails with `gap closed: remove knownGap marker`; remove the marker and keep the safe expectation as a regression check. Record each remaining gap in ADR-0045 by finding id.

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
| Root package, twelve entrypoints, four skills, two agents, six bridge runtimes, nine harness templates | `npm run check` (includes read-only `check:docs`) | Source header lists twelve extensions once; clean packed artifact loads and discovers bundled explorer/worker; decision index, spokes, and ADRs are current. |
| `browser` | `npm --prefix agent/extensions/browser test` and `npm --prefix agent/extensions/browser run typecheck` | After `npx playwright install chromium`, `/browser on` enables tools; live navigation, console/network inspection, page actions, and screenshots work without orphaning Chromium. |
| `ccc-search` | `npm --prefix agent/extensions/ccc-search test` and `npm --prefix agent/extensions/ccc-search run typecheck` | `ccc_search` works in Build and Plan after project index exists; uninitialized error points to Build. |
| `claude-bridge` | Live `test-core-protocol.js` procedure below; interactive Pi approval required, bounded wait ≤120s | Footer says active; protocol covers pending/no lease, operator-approved lease with four-hour expiry, holder/non-holder ticks, and live owner dispatch. |
| `discussion-notes` | Core protocol exercises event-bus capture/idempotency | `/notes` restores branch state across tree navigation; clear affects selected branch. |
| `engineering-docs` | `npm --prefix agent/extensions/engineering-docs test`; `npm run check:docs` | `/docs check --check` reports managed docs, healthy spokes/ADRs/tags, and full-content current index. |
| `filechanges` | Package load/inventory; no dedicated unit suite | Make disposable `edit`/`write`, inspect cumulative diff, verify accept keeps and decline restores/deletes. |
| `notify` | Package load/inventory; no dedicated unit suite | Finish one assistant turn and confirm terminal-native “Ready for input” notification. |
| `personal-memory` | `npm --prefix agent/extensions/personal-memory test` and `npm --prefix agent/extensions/personal-memory run typecheck` | In isolated Pi home, save slug, inspect generated `MEMORY.md`, fetch one entry. |
| `subagents` | `npm --prefix agent/extensions/subagents test` and `npm --prefix agent/extensions/subagents run typecheck` | `npm run smoke:subagents` exercises installed-Pi RPC launch, question round-trip, nested spawn, and browser proxy; browser reports explicit PASS/SKIP. Smoke is separate from `npm test`. |
| `workflow-modes` | `npm --prefix agent/extensions/workflow-modes test` and `npm --prefix agent/extensions/workflow-modes run typecheck` | Switch modes; verify session-scoped plan body/pointer restoration, tracker progress, Caveman restoration, and read-only gates. |
| `ask-user-question` | `npm run test:ask-user-question` | Queue/relay tests cover model-child FIFO, source-scoped cancellation, RPC select/input, Other, free text, and unavailable/dismissed paths. |
| `harness-setup` | `npm run test:harness-setup` | Isolated setup acceptance covers install/repair/idempotence/uninstall, backups, startup warning, root classification, re-extraction, the Claude PreToolUse exit-2 guard, and unguarded-own-entry repair; Cursor real global-command discovery remains unverified. |
| Claude MCP client + read-only hook | `npm run test:bridge-client`; live core protocol test covers MCP dispatch and bridge-down behavior | `claude mcp list`; no-lease mutation denial, unknown/foreign ask, crash deny, sandbox behavior, and Phase 3 lease approval/expiry acceptance (ADR-0047). |
| Cursor MCP/hooks/commands | `npm run test:cursor` and `npm run test:cursor-kit` | Hook/MCP classification, identity mismatch denial, lease-holder allow, neutral commands, and commit nudge; approval/identity flow passed in operator-reported isolated acceptance; real Cursor global-command discovery remains unverified. |
| OpenCode plugin and shipped commands | `npm run test:opencode` plus root package check | `/harness` installs user-global plugin/MCP/commands; OpenCode v2.0.32 loaded the plugin and `pi-*` commands in isolated acceptance. The plugin allowlists reads/bridge/shell/`execute` and throws on unknown/foreign names. Lease approval flow passed in operator-reported isolated acceptance (ADR-0047); subagent `sessionID` inheritance remains not-verified. |
| Bridge clients under load | Not in root gate | Run dedicated stress harness only against an active disposable bridge and clean all state afterward. |

## Saved plan workflow

`/plan` operates on plans visible in selected session ancestry:

- `/plan save` writes a new immutable plan body to `<agentDir>/plans/<sessionId>/<planId>.md`, seeds tasks from top-level unchecked Section 4 items, appends its pointer, then activates it. It does not overwrite another plan.
- `/plan select` changes active pointer; `/plan view` shows active plan and available ancestry plans; `/plan clear` deactivates the selected plan but leaves its file for retention GC.
- Build progress is branch-backed. Complete and verify one tracker task, then call `workflow_plan_tick`; never edit plan-file checkboxes. The per-turn marker carries only plan identity/path/time, progress counts, and next task.
- Claude Code, Cursor, and OpenCode use the same live owner through `save_plan`, `read_plan_tasks`, and `tick_plan_task`; they must not read plan files directly. OpenCode's plugin injects host `sessionID` into bridge MCP calls.

## Harness Build leases

External `/pi-build` needs an active saved plan, paired harness peer, and Pi outside Build. First request returns `build_lease_pending` with no writes; only interactive Pi `/build-lease approve` can grant after confirmation and fresh plan/pairing/mode/holder checks. Approve the exact short id shown, then rerun `/pi-build`; headless Pi returns `build_lease_no_approval` without recording a request. A grant expires at `expiresAt = grantedAt + 4 hours`; hooks require fresh presence, unexpired lease, and matching host identity. Only the active holder may tick tasks; a non-holder or expired lease returns `build_lease_required`. `/build-lease` shows holder, remaining time, and pending requests; `/build-lease release` clears the lease. Holder Discuss/Plan recall or unpair, plan clear/switch/completion, Pi Build mode, expiry, and bridge/session lifecycle revoke it. Expiry mid-build denies the next write or tick; stop and ask for re-approval. Pi `/mode build` is blocked while leased; Pi Off is intentionally unguarded. Commit before the final task tick because completion releases the lease.

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

The test prints `ACTION REQUIRED` with the exact `<harness>:<first 8 id chars>` short id and waits up to 120 seconds. In Terminal A, run `/build-lease approve`, review that exact peer, plan/progress, and four-hour expiry, then confirm. Do not approve a different id. The test then verifies the four-hour expiry field in presence and holder-only ticks. Expected: all core protocol checks pass, including pending-without-lease and MCP plan-task dispatch. Return to Terminal A, enter `/quit`, wait for process exit, then let `cleanup` remove temporary state.

Confirm cleanup:

```bash
find "/path/to/PI_PROJECT_DIR/.pi/memory" -type f -print 2>/dev/null
ps -ax -o pid=,command= | grep -F "/path/to/PI_PROJECT_DIR" | grep '[p]i ' || true
```

Both commands should print nothing. Do not signal the current Pi, delete its bridge state, or leave temporary Pi, tmux, or bridge processes running after tests.

## Installed-package harness setup

After `pi install …`, start Pi interactively and run `/harness`. Select Claude, Cursor, or OpenCode → **Install / repair**, inspect the planned diff, then confirm. The extension owns package-managed MCP, hooks/plugin, and `pi-*` command setup; consumers do not hand-merge config or create symlinks. Re-run `/harness` to inspect or repair. In non-TUI mode it reports status and instructs users to open the interactive TUI to apply.

Uninstall owned setup before removing the package: run `/harness`, select the harness → **Uninstall**, then `pi remove …`. Cursor's `failClosed: true` hooks and Claude's exit-2 `PreToolUse` guard can block tools globally if the package is removed first. Claude no-lease Bash is Seatbelt-sandboxed only on macOS; it is denied closed elsewhere.

Cursor global commands are named `pi-discuss`, `pi-plan`, and `pi-build`. If real Cursor does not discover them globally, copy the packaged `agent/harness-commands/cursor/pi-*.md` files into the consumer project's `.cursor/commands/`. Real Cursor global-command discovery remains unverified. This repository's `.cursor/commands/pi-*` symlinks point to those packaged Cursor templates, but `.cursor/**` remains repo-only and is excluded from the package.

OpenCode v2.0.32 loaded the managed plugin and `pi-*` commands in isolated acceptance. Its bridge calls use Code Mode `execute` and synchronous `search({ query, namespace: "pi-claude-bridge" })`; the plugin injects host `sessionID`, not a model-supplied identity.

### Isolated harness-setup acceptance

Build the tarball and set `TGZ` as in the exact-artifact procedure above. From the repository root, extract it under a disposable Pi agent directory and start Pi with isolated harness roots:

```bash
: "${TGZ:?Set TGZ to dist/<tgz>}"
umask 077
HARNESS_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-harness.XXXXXX")"
trap 'rm -rf "$HARNESS_TEST_ROOT"' EXIT INT TERM
export HOME="$HARNESS_TEST_ROOT/home"
export XDG_CONFIG_HOME="$HARNESS_TEST_ROOT/xdg"
export CLAUDE_CONFIG_DIR="$HOME/.claude"
export PI_CODING_AGENT_DIR="$HARNESS_TEST_ROOT/pi-agent"
PKG_ROOT="$PI_CODING_AGENT_DIR/npm/node_modules/@lopezpetergabriel/pi-extensions"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$PKG_ROOT" "$HARNESS_TEST_ROOT/project/.pi"
tar -xzf "$TGZ" -C "$PKG_ROOT" --strip-components=1
npm install --prefix "$PKG_ROOT" --omit=dev --omit=peer --ignore-scripts
(
  cd "$HARNESS_TEST_ROOT/project"
  pi --no-extensions --approve --no-session -e "$PKG_ROOT"
)
(
  cd "$HARNESS_TEST_ROOT/project"
  opencode --standalone
)
```

In Pi, run `/harness` and install each harness. Seed foreign hook and statusLine entries, plain command fixtures at both Pi command-name sets, and unrelated command fixtures only in disposable roots. Confirm Install / repair previews the plain Pi-name files as backed-up replacements, creates byte-verified sibling backups, and preserves unrelated command fixtures. Repeat install and verify no planned changes; re-extract the tarball into the same package root and confirm status stays `ok`. Also install from the checkout root, switch Pi to the extracted tarball root using the same disposable harness roots, and confirm `/harness` Install / repair previews owned command/plugin symlink retargets and status becomes `ok`; Uninstall and confirm `not-installed`. Check `claude mcp get pi-claude-bridge` points at the extracted package. Delete one stamped symlink, restart Pi, and verify one startup warning. Invoke the Cursor hook with a sample `Write` in the temp `.pi` project and expect denial. Uninstall each harness; verify owned entries are gone, plain files and foreign fixtures survive, and backups exist. Also verify a dev-checkout warning and refusal for a temporary/project package root. Use `opencode --standalone` with the same temp roots to check plugin and command loading without reusing a user server.

Expected: Claude settings parse and MCP points at the extracted absolute package path; Cursor hooks retain `failClosed: true` and config/commands are present; OpenCode v2.0.32 loads its plugin and `pi-*` commands. Real Cursor global-command discovery remains unverified; use the project-local template fallback without launching real Cursor. Never print or copy real harness config contents. If checking real-home integrity, record SHA-256 hashes only and compare before/after; mtime alone does not establish attribution. Exit Pi and harness CLIs, verify no test processes remain, then allow the trap to remove the temp root.

## Claude Code bridge workflow

1. Launch Pi in the target project; confirm `Claude bridge: active` and intended nearest `.pi` root.
2. In Pi, run `/harness`, choose Claude → **Install / repair**, review the preview, and confirm. The extension manages its MCP registration, hooks, statusLine, and `pi-*` commands without replacing foreign settings. Verify with `claude mcp get pi-claude-bridge` and `claude mcp list`.
3. Use `/pi-discuss` or `/pi-plan` for read-only work. Use `/pi-build` only with an active saved plan while Pi is not in Build mode. On `build_lease_pending`, stop before edits or shell, show the short id, and ask the user to approve it in interactive Pi with `/build-lease approve`; then rerun `/pi-build`. On `build_lease_no_approval` or `build_lease_required`, stop and ask for interactive approval/re-approval. Never retry with another identity. `/build-lease` shows holder, expiry, and pending requests.

### Claude bridge live acceptance

Run against a disposable project with isolated `HOME`, `XDG_CONFIG_HOME`, and `PI_CODING_AGENT_DIR`. Use the installed package and `/harness` to install Claude setup, then verify:

1. `claude mcp get pi-claude-bridge` and `claude mcp list` show the installed package client connected; settings JSON parses, `claude doctor` passes.
2. Two Pi RPC sessions in one project report active under separate namespaces. Session IDs were captured separately.
3. Through actual Claude CLI MCP calls, run `list_sessions`, `pair_session`, then `send_message`. Confirm message becomes pending and Pi receives it on its next prompt. Send Pi→Claude with `bridge_message`; statusline script outputs exact `Pi ✉1`; next actual Claude CLI prompt receives injected peer message; acknowledge it and confirm pending count clears. `SessionEnd` unpairs.
4. Live bridge-client check with `harness: "cursor"` sends Cursor identity to a second Pi; Pi replies with `bridge_message`; `read_messages` retrieves and acknowledges reply. This exercises client protocol, not an interactive Cursor model session.
5. Claude Code 2.1.296 print-mode `/clear` without session persistence changes session ID. This verifies CLI behavior, not interactive TUI behavior; explicit supplied `sessionId` takes precedence over stale `CLAUDE_CODE_SESSION_ID` in a separate live client check.
6. Clean shutdown retains an owned namespace with non-live presence and peers; stale namespaces are collected after 10m. Pending mailbox messages are still dropped with a count warning.

The idle statusline script output and `refreshInterval: 5` settings were verified; interactive idle redraw timing/appearance was not separately verified.

#### Restart pairing acceptance (2026-10-12)

Ran in a disposable project with isolated `PI_CODING_AGENT_DIR`, mode-0600 auth/config copies, and current repo extension source loaded in Pi RPC. Temporary project/auth copies and Pi processes were removed after test; global config/auth file hashes were unchanged. `pi --help` showed `--session <path|id>` and `--resume [session]`; `--resume <id>` opened an interactive picker in RPC, so same-ID resumes used `--session <id>` after initial `--session-id <id>`.

- (a) Cleanly stopping Pi A left only `presence.json` in its owned 0700 namespace (file mode 0600), retaining its paired Claude peer with a back-dated/non-live heartbeat and both pending counts at zero; A disappeared from `list_sessions`.
- (b) Resuming A with `--session <id>` restored its peer and recreated private `requests`, `responses`, and `processed` dirs. Pi `bridge_message` queued one synthetic message; direct Node invocation of `pi-peer-hook.js` with real `UserPromptSubmit` fields returned `hookSpecificOutput.additionalContext` containing it, with no `systemMessage`; ack changed `pendingCount` from 1 to 0. A second clean stop again left only `presence.json`. This invoked the hook directly, not Claude CLI; interactive Claude TUI behavior remains untested.
- (c) With A down, the client's first live request auto-paired Claude to B. Restarting A dropped that peer; client resolved to B only.
- (d) Backdating A's heartbeat by more than 10m and claiming another namespace triggered GC; A's old namespace disappeared, and same-ID resume restored no peers.
- (e) Shutting down with one outbound message pending dropped it and emitted `claude-bridge dropped 1 pending peer message(s) on shutdown`.

Existing bridge acceptance remains: `recall_memory` returns canonical docs, compact personal-memory index, live prompts, and selected-branch saved plan; `capture_note` updates live Pi Notes UI through `discussion-notes`; `validate_docs_tags` uses engineering-docs validator; `save_plan` appears in Pi `/plan view`; `read_plan_tasks` and `tick_plan_task` use the live branch-backed tracker. Without a matching fresh lease, Claude mutation tools deny; no-lease Bash is sandboxed only on macOS and denied closed elsewhere. Phase 3 lease approval/identity flows were reported passing in isolated acceptance; see ADR-0047. The TUI input-injection assumption remains not-verified, and OpenCode subagent `sessionID` inheritance remains not-verified.

## Cursor bridge workflow

Repository `.cursor/mcp.json`, `.cursor/hooks.json`, and bridge command templates are relative and ready from workspace root. The repo-local `.cursor/commands/pi-*` symlinks point to packaged Cursor templates. Package consumers use `/harness` to install/repair global config; no hand-merge or symlink setup is needed.

1. Launch Pi and confirm intended bridge root. For package consumers, run `/harness`, choose Cursor → **Install / repair**, inspect the preview, and confirm.
2. Open the same root in Cursor.
3. Use `/pi-discuss` or `/pi-plan`. Cursor bridge MCP calls require safe host `conversation_id` and matching `sessionId` plus `harness: "cursor"`; missing or mismatched identity is denied. `/pi-build` requires an active saved plan; without an approved, unexpired lease, hooks stay read-only.
4. If real Cursor does not discover global commands, use project-local copies of packaged `agent/harness-commands/cursor/pi-*.md` in `.cursor/commands/`. Real global-command discovery remains unverified.
5. Verify recall/capture/save plus `read_plan_tasks`/`tick_plan_task` through `pi-claude-bridge`.
6. Before approval, verify shell/MCP policy and `Write` denial; pending approval must not authorize writes. After approving the exact short id in Pi, verify only the matching holder is allowed. Forged identity and expired/missing-expiry lease stay denied; only the holder may tick.
7. Pi `/build-lease` shows holder, remaining time, and pending requests; use `/build-lease release` when needed. Pi `/mode build` is blocked while leased.

Focused hook gates:

```bash
npm run test:cursor
npm run test:cursor-kit
```

## OpenCode bridge workflow

Use `/harness` to install/repair the user-global plugin, MCP config, and `pi-*` commands. OpenCode v2.0.32 or later with `tool.hook` support is required.

1. Start Pi in the target `.pi` project and leave Pi outside Build mode; save/select an active plan.
2. In Pi, run `/harness`, choose OpenCode → **Install / repair**, inspect the preview, and confirm.
3. Open the same project root in OpenCode.
4. Use `/pi-discuss` or `/pi-plan` for read-only work, then `/pi-build` to request a lease. On `build_lease_pending`, stop before edits or shell and ask the user to approve the exact short id in interactive Pi; rerun `/pi-build` only after approval. Headless Pi cannot approve. Build templates search Code Mode before each bridge MCP call; do not call the exposed MCP tool directly or supply a model-invented session identity.
5. Pi `/build-lease` shows holder, remaining time, and pending requests; use `/build-lease release` to revoke a stale holder. Leases expire after four hours; expiry mid-build denies the next write or tick and requires re-approval. Pi `/mode build` is refused while a lease is held.
6. Phase 3 approval/write flow passed in operator-reported isolated acceptance (ADR-0047). OpenCode subagent `sessionID` inheritance remains not-verified; unit tests do not establish it.

## Cursor-neutral workflow

`.cursor/commands/discuss.md`, `.cursor/commands/plan.md`, and `.cursor/commands/build.md` form a standalone workflow for repositories without Pi or bridge configuration.

- `/discuss` asks one focused question at a time, records the working handoff in conversation, and does not edit files.
- `/plan` produces Evidence, Target files, and atomic Given/When/Then tasks with NFRs, verification gates, and commit boundaries; it may add optional task-level `Files` hints for Build slicing. Files hints are advisory, never ownership. Planning creates no files; implementation creates only task-named docs.
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

For optional reference context, manually copy external exports—Open Design packages/folders or ZIP exports, prototypes, and files from other tools—into `docs/design/reference/`. Commit the snapshot to keep it available; delete the directory to disable reference prompts. Check each package's license before committing.

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
