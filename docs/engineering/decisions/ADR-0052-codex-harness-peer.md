---
id: ADR-0052
title: Codex harness peer for CLI and desktop app
status: Active
date: 2026-11-03
decision: Add OpenAI Codex (CLI and desktop app, one user-global CODEX_HOME setup) as harness peer `codex`, guarded by a fail-closed PreToolUse hook with host-identity injection and Cursor's shell classifier, installed by `/harness` through a content-owned config.toml table, hooks.json, and explicit-only skills; Codex host fail-open paths are accepted limits (ADR-0045 F14).
why: Codex users need the same discuss/plan/build loop as other harnesses, but Codex exposes only hooks that fail open, per-surface hash trust, deprecated command files, and a config file the desktop app rewrites, so enforcement and setup must be layered and byte-preserving.
affects: agent/codex-bridge-client/pi-codex-hook.js, agent/codex-bridge-client/test-pi-codex-hook.js, agent/harness-commands/codex/pi-discuss/SKILL.md, agent/harness-commands/codex/pi-discuss/agents/openai.yaml, agent/harness-commands/codex/pi-plan/SKILL.md, agent/harness-commands/codex/pi-plan/agents/openai.yaml, agent/harness-commands/codex/pi-build/SKILL.md, agent/harness-commands/codex/pi-build/agents/openai.yaml, agent/extensions/harness-setup/codex-toml.ts, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/index.ts, agent/extensions/harness-setup/test/test_setup.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-sessions.js, agent/extensions/claude-bridge/mailbox.ts, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/test/test_mailbox.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, scripts/security-corpus.json, scripts/test-security-corpus.ts, scripts/check-package.mjs, scripts/check-workspace.mjs, package.json, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/README.md
consequences: Codex CLI and desktop pass the same read-only, lease, identity, and build checks as other harnesses; host-side hook failures, untrusted hooks, hosted tools, and MCP-server startup writes stay outside enforcement, and `$pi-build` commits need Codex approval because its sandbox keeps `.git` read-only.
readWhen: changing the Codex hook, Codex tool allowlists or identity injection, Codex `/harness` setup (hooks.json, config.toml table, skills), Codex skills, or the Codex security-corpus column
supersedes: None
extends: ADR-0019, ADR-0043, ADR-0044, ADR-0045, ADR-0046, ADR-0050
---

# ADR-0052: Codex harness peer for CLI and desktop app

## Context

Claude Code, Cursor, and OpenCode already pair with Pi through the bridge MCP, a read-only guard, and a Pi-approved Build lease (ADR-0019, ADR-0043, ADR-0046). Codex ships as a CLI and as the Codex surface of the ChatGPT desktop app; both read `~/.codex` (or `CODEX_HOME`). A live spike on both surfaces (CLI 0.166.0, desktop Codex Framework 156.0.8078.79, 2026-11-03) established the host facts below before any design depended on them.

## Decision

- **Peer.** `codex` joins the bridge harness kinds and Build-lease harnesses. The lease binds `{harness: "codex", id: session_id}`; one setup serves the CLI and the desktop app. A surface whose hooks cannot run would degrade to a read-only discuss/plan peer; neither surface needed it.
- **Guard.** `agent/codex-bridge-client/pi-codex-hook.js` is a PreToolUse hook in its own matcher-less `hooks.json` group, installed as `node "<hook>" || { echo 'Pi Codex hook failed closed' >&2; exit 2; }`. Decisions:
  - invalid input or any exception: deny; the script prints only Codex-supported allow/deny shapes;
  - bridge MCP (`mcp__pi_claude_bridge__*`, Codex's normalized server name), inside or outside a Pi project: inject host `sessionId` and `harness: "codex"` through `updatedInput`, drop `claudeSessionId`, deny mismatched or missing identity;
  - `apply_patch`, from any cwd: every `*** Add/Update/Delete File:` and `*** Move to:` path is resolved against the session cwd (`targetPiProjectRoot`, symlinks resolved); a target in a Pi project other than the session's own denies unless this session holds that project's lease, and a patch with no readable path denies outside a Pi project;
  - outside a Pi project: allow; matching unexpired lease: allow;
  - otherwise `apply_patch` denies; `Bash` (Codex's name for shell and unified exec) runs Cursor's `classifyShell`, and anything not `allow` denies because Codex cannot ask; `view_image`, `update_plan`, `request_user_input`, `request_user_input_async`, `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` pass; every other tool, including `spawn_agent`, `write_stdin`, and foreign MCP, denies.
- **Layering.** Codex's own sandbox and approval prompts remain a backstop, never the authorization boundary.
- **Setup.** `/harness` manages Codex under `CODEX_HOME || ~/.codex`:
  - `hooks.json`: the guarded hook group; misplaced (matcher-narrowed) or unguarded owned hooks are flagged and moved; foreign groups and `mcp_tool` handlers are preserved;
  - `config.toml`: dependency-free `agent/extensions/harness-setup/codex-toml.ts` edits only `[mcp_servers.pi-claude-bridge]` (`command = "node"`, the package `pi-bridge-mcp.js`, `default_tools_approval_mode = "approve"`). Ownership is by content; reformatted owned tables are recognized; foreign same-name tables, sub-tables, dotted or inline forms, an `mcp_servers` set as one value or as `[[mcp_servers]]` (which cannot take the table), duplicates, and unreadable TOML are skipped and reported. Every byte outside the table survives; install plus uninstall round-trips; a new file is created `0600`;
  - `skills/`: links for `pi-discuss`, `pi-plan`, `pi-build` and the 23 package skills; `skills/.system` and foreign entries are untouched; Codex `commands/` paths are never treated as legacy Pi commands;
  - preview and results show a re-trust notice whenever `hooks.json` changes; on Uninstall it asks to re-check the remaining hooks, whose positions can shift. The preview also warns to uninstall before `pi remove`, because the guard fails closed.
- **Workflows.** Codex workflows ship as skills (`agent/harness-commands/codex/<name>/SKILL.md`) with `agents/openai.yaml` `allow_implicit_invocation: false`, invoked as `$pi-discuss`, `$pi-plan`, `$pi-build`. Skills detect `.pi/` with plain `ls -a` and avoid dynamic shell before a lease.
- **Not shipped.** No peer-chat hook, statusline, or SessionStart identity hook.

## Why

- Spike evidence: hooks run on both surfaces once trusted; `session_id` (UUIDv7) is stable across a thread; JSON deny and exit 2 with a stderr reason block; `updatedInput` replaces MCP arguments; hook trust is per surface and keyed by hook position and definition, not script contents; untrusted hooks are skipped silently in `codex exec`; MCP server names are normalized (`-` to `_`); both surfaces read `$CODEX_HOME/skills` and `~/.agents/skills` and follow symlinks.
- A plain `|| exit 2` guard is not enough: Codex lets exit 2 without stderr through. Real Node crashes print to stderr, so only silent failures (exit without output, a killed process) distinguish the guards; the corpus pins a `silent` crash variant.
- Rejected:
  - custom prompts: deprecated, and reportedly not shown by the desktop app;
  - wrapping shell in `sandbox-exec`: Codex already runs commands in its own Seatbelt sandbox;
  - allowing shell only when the payload proves a read-only sandbox: the field was unverified and would remove the only read path;
  - a TOML library or marker comments: both rewrite or depend on bytes the desktop app manages;
  - joining an existing hook group: a foreign `matcher` would skip `apply_patch`;
  - validate-only identity with a SessionStart hook: unnecessary once `updatedInput` was confirmed;
  - exporting to `~/.agents/skills`: `$CODEX_HOME/skills` works on both surfaces and keeps the ADR-0050 export boundary.

## Accepted limits

Recorded as ADR-0045 F14. Mitigations: the stderr guard, the re-trust notice, Codex's sandbox and approvals, and the corpus.

- Host-side hook failures fail open: timeout, malformed or unsupported output, or a failure the shell guard never sees.
- Hooks run only after the user trusts them in each surface; a changed hook position or definition needs re-trust, and `codex exec` skips untrusted hooks without warning.
- Hosted tools (web search) and MCP server processes at startup bypass PreToolUse.
- Shell from a session outside a Pi project is not target-checked (ADR-0045 F11); `apply_patch` paths are.
- Codex subagent identity is unverified; `spawn_agent` denies without a lease.

## Evidence

| Check | CLI | Desktop |
|---|---|---|
| Hooks run after trust; trust not shared between surfaces | **E** | **E** |
| No-lease shell write, `apply_patch`, foreign MCP denied; reads allowed | **E** | **E** |
| Bridge identity injected (`sessionId` = Codex thread id) | **E** | **E** |
| `$pi-discuss` notes, `$pi-plan` save (desktop after `request_user_input_async` fix) | **E** | **E** |
| Lease approve, edit, commit, tick; other identity denied while held; release and auto-release | **E** | **E** |

Corpus: Codex column 96/96 in both lanes; crash checks including `silent` pass, and a plain-guard mutation fails. Live hook p95 54-89 ms. Commits under a lease need Codex escalation because its workspace-write sandbox keeps `.git` read-only; `codex exec` cannot escalate.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md`
- `docs/engineering/decisions/ADR-0052-codex-harness-peer.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/codex-bridge-client/pi-codex-hook.js`, `agent/codex-bridge-client/test-pi-codex-hook.js`
- `agent/harness-commands/codex/{pi-discuss,pi-plan,pi-build}/SKILL.md` and `agents/openai.yaml`
- `agent/extensions/harness-setup/codex-toml.ts`, `manifest.ts`, `setup.ts`, `index.ts`, `test/test_setup.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`, `agent/claude-bridge-client/test-sessions.js`
- `agent/extensions/claude-bridge/mailbox.ts`, `build-lease.ts`, `test/test_mailbox.ts`, `test/test_build_lease.ts`
- `scripts/security-corpus.json`, `scripts/test-security-corpus.ts`, `scripts/check-package.mjs`, `scripts/check-workspace.mjs`, `package.json`

## Consequences

- Good: Codex CLI and desktop users run the Pi workflow under the same lease and identity model as other harnesses.
- Good: setup never rewrites Codex-managed bytes and round-trips cleanly.
- Good: the corpus scores Codex by Codex semantics, so a weakened guard fails.
- Bad/risk: enforcement depends on per-surface hook trust that Codex can skip; docs must tell users to trust only the Pi hook (never "trust all").
- Bad/risk: allowlists track Codex tool names, which differ between surfaces and versions.
- Fixed: `/harness` no longer backs up skill links and removes stale `.harness-bak-` links on Install / repair and Uninstall (ADR-0044).
- Good (2026-11-04 review): `apply_patch` paths are target-checked like Claude edit tools, so a Codex session outside a Pi project cannot patch into one without its lease; hook unit tests cover absolute, relative, Move-to, symlink, and cross-project targets (p95 52 ms).

## Read when

- changing the Codex hook, its allowlists, guard command, or identity injection
- changing Codex `/harness` setup, `codex-toml.ts`, or Codex skills
- upgrading Codex across tool-name, hook-output, or trust-model changes

## Extends

- ADR-0019, ADR-0043, ADR-0044, ADR-0045, ADR-0046, ADR-0050

## Supersedes

- None
