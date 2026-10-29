# Pi Extensions

This workspace prepares `@lopezpetergabriel/pi-extensions@0.10.0`, a Pi package and source workspace containing twelve extensions, four skills, and two bundled agent definitions. The repository is source for the package, not a separate Pi home: Pi continues to own authentication, settings, models, sessions, and personal memory.

## Requirements

- Pi CLI on `PATH` (subagent children use its RPC mode)
- Node.js `>=22.19.0`
- npm and network access for the first bootstrap and uncached `npx` test dependencies
- Optional: `ccc` for `ccc_search`; `gh` for live Review-mode GitHub checks
- For browser verification: Chromium, installed with `cd agent/extensions/browser && npx playwright install chromium`

## Install and try the package

Install globally, for one project, or temporarily:

```bash
pi install npm:@lopezpetergabriel/pi-extensions@0.10.0
pi install -l npm:@lopezpetergabriel/pi-extensions@0.10.0   # this project only
pi -e npm:@lopezpetergabriel/pi-extensions@0.10.0           # temporary try
pi list
```

These install commands pin `@0.10.0`. Upgrade an installed package to the latest release with:

```bash
pi update npm:@lopezpetergabriel/pi-extensions
```

Remove it with `pi remove npm:@lopezpetergabriel/pi-extensions`. A bare `pi update` updates Pi itself, not package extensions.

### Install from Git

```bash
pi install git:github.com/petergabriel-dev/pi-extensions@v0.10.0
```

After installing the package, start Pi interactively and run `/harness`. Choose Claude, Cursor, or OpenCode, select **Install / repair**, review the preview, then confirm. This manages package-owned bridge config and `pi-*` commands; consumers do not hand-merge settings or create symlinks. In `.pi` projects, Claude no-lease Bash is Seatbelt-sandboxed on macOS and denied closed on other platforms. Cursor's fail-closed hooks can block tools globally if the package is removed first; run `/harness`, choose Cursor → **Uninstall**, then `pi remove`.

Cursor setup installs global `pi-*` commands. If Cursor does not discover them, use project-local commands: copy `pi-discuss.md`, `pi-plan.md`, and `pi-build.md` from the installed package's `agent/harness-commands/cursor/` into your project's `.cursor/commands/`. Real Cursor global-command discovery remains unverified. This repository's `.cursor/commands/pi-*` symlinks point to the packaged templates, but `.cursor/` is repository-only. Pi's [package documentation (`packages.md`)](https://pi.dev/docs/packages) describes Git/npm sources and personal versus project install scope.

Install `ccc` separately before using `ccc_search`; verify it with `ccc --version`. Raw or global copies of these extensions can load twice alongside the package. Use `pi list` and `pi config` to inspect registrations, then remove or disable duplicates.

## Develop from source

From the repository root:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run bootstrap
npm run check
./bin/pi-workspace
```

`npm run bootstrap` installs the lockfile-backed development packages under `agent/extensions/`. `npm run check` verifies the workspace and npm artifact inventory. The launcher runs `pi --no-extensions -e <repository-root>` so global extension discovery is disabled and this checkout is loaded once. Do not replace it with `pi -e .`.

Review the Pi project-trust prompt before approving local resources. On startup, the extension header should list exactly twelve extensions from this repository and no global extension paths. Use `/quit` to exit. Add `--no-session` to the launcher for a disposable parent session:

```bash
./bin/pi-workspace --no-session
```

## Common commands

```bash
npm run check                 # workspace and package integrity/size checks
npm test                      # full configured test, typecheck, and Cursor-hook gate
npm run test:ask-user-question
npm run test:extensions
npm run typecheck
npm run test:cursor
npm run test:cursor-kit
```

The focused commands are useful while iterating; `npm test` runs the complete configured gate after bootstrap.

## Subagent controls

```text
/subagent-model <explorer|worker> <provider/model|inherit>
/subagent-effort <explorer|worker> <off|minimal|low|medium|high|xhigh|inherit>
```

Overrides are per role and stored in Pi settings. Explorer effort defaults to `low`; worker effort inherits the parent when unset. Explicit explorer `inherit` restores parent effort instead of the default.

In a saved interactive TUI session, `/agents` lists child runs in tree order and opens a live view of recent redacted RPC items. Arrow keys or PageUp/PageDown scroll; Enter answers a pending child question or steers a running child; Esc closes. If viewed child asks while overlay is open, Esc returns to chat and leaves question pending for later answer through `/agents`; a queued question from another child may open its dialog after close. Finished children are read-only. Child questions are relayed to the user automatically, and dismissing a dialog leaves the question pending. `/agents` requires the interactive TUI.

## Contents

### Extensions

- `ask-user-question` — model-initiated text, single-select, and multi-select questions, including context defer/resume.
- `browser` — gated persistent Chromium browser tools and parent/child browser proxies.
- `ccc-search` — bounded `ccc_search` semantic search.
- `claude-bridge` — live bridge watcher and request handling for the Pi-side bridge.
- `discussion-notes` — `discussion_notes`, `/notes`, and the Notes UI.
- `engineering-docs` — engineering-document operations, tag validation, and generated spokes/indexes.
- `filechanges` — branch-local tracking and accept/decline rollback for successful Pi `edit`/`write` mutations.
- `notify` — terminal-native “Ready for input” notifications.
- `personal-memory` — user-global indexed memory and `/remember`.
- `subagents` — isolated RPC child Pi processes, automatic user question relay, and the `/agents` TUI overlay.
- `workflow-modes` — `/mode`, `/plan`, `/caveman`, prompt composition, and read-only/mutation gates.
- `harness-setup` — `/harness` inspect, install/repair, and uninstall for Claude, Cursor, and OpenCode.

### Skills and agents

- Skills: `grill`, `grill-with-docs`, `web-debug`, and `worker-orchestration`.
- Bundled agents: `explorer` for repository-read-only discovery and `worker` for Build-mode implementation.

### Repository map

- `agent/extensions/` — extension entrypoints and supporting source
- `agent/skills/` — authored skills
- `agent/agents/` — bundled agent definitions
- `agent/claude-bridge-client/` and `agent/cursor-bridge-client/` — bridge clients and read-only hooks
- `.cursor/` — Cursor integration and workflow commands
- `docs/engineering/` — canonical engineering documentation
- `bin/pi-workspace` — isolated source launcher
- `scripts/check-workspace.mjs` — workspace/resource integrity check

## Safety and package boundary

The launcher reuses the current Pi user state; it does not create a separate Pi home or copy credentials/settings into Git. Runtime state may remain in Pi-owned locations outside the repository, and bridge IPC under `.pi/memory/bridge/` is ephemeral and ignored.

Never add credentials, trust/settings/model files, sessions, plans, personal memory, caches, databases, logs, dependency trees, bridge IPC, CCC indexes, or external symlinks to the repository. The only tracked `.pi/` resource is the internal `.pi/agents` symlink.

Starting with release `0.8.0`, the npm tarball includes runtime TypeScript/helpers, the workflow plan template, agent and skill Markdown, `README.md`, `LICENSE`, `CHANGELOG.md`, required nested READMEs, and exactly six bridge-client runtime files: `agent/claude-bridge-client/pi-bridge-mcp.js`, `agent/claude-bridge-client/pi-readonly-hook.js`, `agent/claude-bridge-client/pi-peer-hook.js`, `agent/claude-bridge-client/pi-statusline.js`, `agent/cursor-bridge-client/cursor-readonly-hook.js`, and `agent/opencode-bridge-client/pi-opencode-plugin.js`. It also ships nine `pi-*` harness command templates across Claude, Cursor, and OpenCode. It excludes `docs/engineering/**`, `.cursor/**`, tests, nested manifests/lockfiles/TypeScript configs, `.pi`, `node_modules`, and runtime/user state. Main retains all engineering docs and development material, including `.cursor/`; those files are not packaged. From `0.8.0` onward the `release` branch mirrors the unpacked tarball exactly, with only an optional root `.npmrc` extra. Package checks enforce `<=512 KiB` packed and `<=1 MiB` unpacked limits.

### Enforcement limits

- Hooks and mode policies are workflow guardrails against a prompt-injected or misaligned agent, not security-grade isolation.
- OS sandboxing covers shell commands only: Seatbelt on macOS; bwrap for Pi on Linux when available. Seatbelt uses an allow-default profile plus denials, not a strict allowlist (F8, accepted limit).
- In `.pi` projects, Claude no-lease Bash is denied off macOS; it does not fall back to unsandboxed approval.
- `~/.pi` is Pi's global agent dir and never marks a project. Dedicated edit tools are checked against the nearest Pi root of their target, so a write into another Pi project needs that project's own Build lease.
- Bash and patch-style tools with no path field can still write into a Pi project from a session outside it; the target check covers dedicated edit tools only and this gap is not fixed (F11).
- Host handling of Cursor `failClosed`, Claude exit-2 guards, and OpenCode plugin-load failure remains unverified; config and runner checks are not host-enforcement proof.
- Pi Off is unguarded. Pi Review posting requires fresh human Pi approval for each command; decline, no UI/headless execution, or confirmation error blocks posting.
- Open gaps: Pi Plan fallback without a sandbox can admit unsafe command expansion (F9); leases are per Pi session, not project-wide single-writer locks (F10). Plan acceptance #1/#3 remain unmet pending follow-up.
- Out of scope: root/kernel/hypervisor attackers, supply-chain compromise, a human editing config, and cross-user attacks.
- Use a container or VM for real isolation. See [ADR-0045: threat model and evidence limits](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md) and [ADR-0048: regression coverage limits](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/decisions/ADR-0048-security-regression-corpus.md).

## Documentation

Canonical project truth lives under [`docs/engineering/`](https://github.com/petergabriel-dev/pi-extensions/tree/main/docs/engineering/). Start with:

- [Engineering docs index](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/README.md)
- [Architecture and package boundary](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/architecture.md)
- [Development workflow and test matrix](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/dev-workflow.md)
- [Conventions](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/conventions.md)
- [Invariants](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/invariants.md)
- [Operational traps](https://github.com/petergabriel-dev/pi-extensions/blob/main/docs/engineering/traps.md)

Edit canonical engineering docs rather than generated `AGENTS.md`, `CLAUDE.md`, or index content; regenerate generated outputs when required.
