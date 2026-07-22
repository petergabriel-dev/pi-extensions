# Development workflow

## Consumer install and release gates

Install globally, for one project, or temporarily:

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.2.0
pi install -l npm:@lopezpetergabriel/pi-extensions@0.2.0
pi -e npm:@lopezpetergabriel/pi-extensions@0.2.0
pi list
pi update npm:@lopezpetergabriel/pi-extensions
pi remove npm:@lopezpetergabriel/pi-extensions
```

Install commands pin the exact `@0.2.0` release. To upgrade an installed package to latest, run `pi update npm:@lopezpetergabriel/pi-extensions`. Bare `pi update` updates Pi itself, not package extensions.

The package provides nine extensions, three skills, and two bundled agents. `ccc` must be installed separately for `ccc_search`. Inspect `pi list` and `pi config` for existing raw/global copies before loading; duplicates can register the same extension twice.

The package allowlist contains runtime TS/helpers, workflow template, agent/skill Markdown, engineering docs, README/LICENSE, and npm-mandatory nested READMEs. It excludes tests, nested manifests/locks/tsconfigs, bridge clients, Cursor config, `.pi`, `node_modules`, and runtime/user state. Release checks reject forbidden files and enforce ≤512 KiB packed and ≤1 MiB unpacked sizes.

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
tar -xzf "$PACKAGE_TEST_DIR/lopezpetergabriel-pi-extensions-0.2.0.tgz" \
  -C "$PACKAGE_TEST_DIR/package" --strip-components=1
npm install --prefix "$PACKAGE_TEST_DIR/package" --omit=dev --omit=peer --ignore-scripts
PI_CODING_AGENT_DIR="$PACKAGE_TEST_DIR/agent" \
  pi --no-extensions -e "$PACKAGE_TEST_DIR/package" --list-models
```

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

`npm run bootstrap` runs nested `npm ci` only in lockfile-backed development packages:

- `agent/extensions/ccc-search`
- `agent/extensions/filechanges`
- `agent/extensions/subagents`
- `agent/extensions/workflow-modes`

Root has a production `diff` dependency and lockfile; when preparing a clean source checkout, use `npm ci --ignore-scripts --legacy-peer-deps` before nested bootstrap. Pi-managed package installs disable peer solving. Engineering-docs and personal-memory tests use `npx --yes`, so their first run may still need npm registry access even after bootstrap.

## Launch isolated source

```bash
./bin/pi-workspace
```

Launcher resolves repository root from its own path and executes `pi --no-extensions -e <root>`. It disables global **extension** discovery and loads this package explicitly. It does not create a separate Pi home: current auth, settings, model catalogs, sessions, context, and personal memory remain shared.

On first startup:

1. Review project trust prompt before approval.
2. Inspect `[Extensions]` header: exactly nine paths should resolve inside this repository.
3. Confirm no global extension path appears.
4. Confirm `.pi/agents` resolves to `agent/agents`.
5. Exit with `/quit` when done.

Use `--no-session` for a disposable parent session:

```bash
./bin/pi-workspace --no-session
```

`--no-session` disables session persistence only. Commands such as `/login`, `/settings`, `/trust`, `/remember`, and bridge `save_memory` still target shared Pi-owned user state unless `PI_CODING_AGENT_DIR` is overridden.

## Standard verification gate

After bootstrap:

```bash
npm test
```

This runs:

1. Workspace inventory/integrity check.
2. CCC, engineering-docs, personal-memory, subagent-timeout, and workflow-mode tests.
3. Configured TypeScript checks.
4. Cursor read-only hook tests.

It does not start Pi, call a model, run live bridge protocol tests, exercise file-change rollback interactively, or verify terminal notification rendering.

Useful focused commands:

```bash
npm run check
npm run test:extensions
npm run typecheck
npm run test:cursor
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
| Root package, nine entrypoints, three skills, two agents | `npm run check` | Source header lists nine extensions once; clean packed artifact loads and discovers bundled explorer/worker. |
| `ccc-search` | `npm --prefix agent/extensions/ccc-search test` and `npm --prefix agent/extensions/ccc-search run typecheck` | `ccc_search` works in Build and Plan after project index exists; uninitialized error points to Build. |
| `claude-bridge` | Live `test-core-protocol.js` procedure below | Footer says active; recall/capture/save/validation are visible through live owners. |
| `discussion-notes` | Core protocol exercises event-bus capture/idempotency | `/notes` restores branch state across tree navigation; clear affects selected branch. |
| `engineering-docs` | `npm --prefix agent/extensions/engineering-docs test` | `/docs check --check` reports managed docs, healthy spokes/ADRs/tags, current index. |
| `filechanges` | Package load/inventory; no dedicated unit suite | Make disposable `edit`/`write`, inspect cumulative diff, verify accept keeps and decline restores/deletes. |
| `notify` | Package load/inventory; no dedicated unit suite | Finish one assistant turn and confirm terminal-native “Ready for input” notification. |
| `personal-memory` | `npm --prefix agent/extensions/personal-memory test` and `npm --prefix agent/extensions/personal-memory run typecheck` | In isolated Pi home, save slug, inspect generated `MEMORY.md`, fetch one entry. |
| `subagents` | `npm --prefix agent/extensions/subagents test` and `npm --prefix agent/extensions/subagents run typecheck` | Debug/live role runs only when explicitly needed; worker must refuse outside Build. |
| `workflow-modes` | `npm --prefix agent/extensions/workflow-modes test` and `npm --prefix agent/extensions/workflow-modes run typecheck` | Switch modes; verify branch plan/Caveman restoration and read-only gates. |
| Claude MCP client + read-only hook | Live core protocol test covers MCP dispatch, bridge-down failure, sandbox allow/deny | `claude mcp list`; real `/discuss` and `/plan` capture/save handoff. |
| Cursor MCP/hooks/commands | `node agent/cursor-bridge-client/test-cursor-readonly-hook.js` | Real Cursor recall/capture/save; shell/MCP denial; native edit byte restoration. |
| Bridge clients under load | Not in root gate | Run dedicated stress harness only against an active disposable bridge and clean all state afterward. |

## Isolated live bridge protocol test

Core protocol test writes discussion notes, saved-plan state, and personal memory. Never point it at normal user state. Use two terminals.

Terminal A, from repository root:

```bash
ROOT="$PWD"
umask 077
PI_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-workspace-bridge.XXXXXX")"
cleanup() {
  rm -rf "$PI_TEST_DIR"
  rm -rf "$ROOT/.pi/memory"
}
trap cleanup EXIT INT TERM
mkdir -p "$PI_TEST_DIR/agent"
for name in auth.json settings.json models-store.json; do
  if [ -f "$HOME/.pi/agent/$name" ]; then
    cp "$HOME/.pi/agent/$name" "$PI_TEST_DIR/agent/$name"
  fi
done
PI_SKIP_VERSION_CHECK=1 \
PI_CODING_AGENT_DIR="$PI_TEST_DIR/agent" \
./bin/pi-workspace --approve --no-session
```

Wait for `Claude bridge: active`. Temporary credential copies are mode-protected by `umask 077`, live outside repository, and are removed by trap.

Terminal B, same repository root:

```bash
node agent/claude-bridge-client/test-core-protocol.js "$PWD"
```

Expected: all core protocol checks pass. Then return to Terminal A, enter `/quit`, wait for process exit, and let trap remove temporary Pi home plus project bridge state.

Confirm cleanup:

```bash
find .pi/memory -type f -print 2>/dev/null
ps -ax -o pid=,command= | grep -F "$PWD" | grep '[p]i ' || true
```

Both commands should print nothing. Do not leave Pi, tmux, or bridge processes running after tests.

## Claude Code bridge workflow

1. Launch workspace Pi in target project and confirm `Claude bridge: active`.
2. Confirm status root is intended nearest `.pi` project.
3. Register MCP client if user-level Claude config does not already contain it:

   ```bash
   claude mcp add -s user pi-claude-bridge -- node "$PWD/agent/claude-bridge-client/pi-bridge-mcp.js"
   claude mcp list
   ```

4. Configure Claude PreToolUse hook to invoke `node agent/claude-bridge-client/pi-readonly-hook.js` for project use.
5. Use Claude `/discuss` or `/plan`; state-changing bridge tools require active Pi.
6. Implement only in Pi Build mode.

Acceptance:

- `recall_memory` returns canonical docs, compact personal-memory index, live prompts, and selected-branch saved plan.
- `capture_note` updates live Pi Notes UI through `discussion-notes` owner.
- `validate_docs_tags` uses engineering-docs validator.
- Confirmed `save_plan` appears in Pi `/plan view`.
- Claude mutation tools deny. Bash is sandbox-wrapped on supported macOS; without sandbox it denies closed.

## Cursor bridge workflow

Repository `.cursor/mcp.json`, `.cursor/hooks.json`, and command templates are relative and ready from workspace root.

1. Launch Pi and confirm intended bridge root.
2. Open same root in Cursor.
3. Use Cursor discuss/plan commands; pass `conversation_id` as `sessionId` when available.
4. Verify recall/capture/save through `pi-claude-bridge`.
5. Verify read-only shell, non-bridge MCP, and native-edit behavior.
6. Return to Pi Build for mutations.

Focused hook gate:

```bash
node agent/cursor-bridge-client/test-cursor-readonly-hook.js
```

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

Use `ccc_search` for agent semantic discovery after initialization. `.cocoindex_code/` is ignored generated state. Do not run `ccc init`, `ccc index`, or daemon maintenance in Discuss/Plan.

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
