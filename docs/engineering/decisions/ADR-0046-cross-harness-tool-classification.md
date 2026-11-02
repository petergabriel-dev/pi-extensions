---
id: ADR-0046
title: Cross-harness tool classification and deny-unknown policy
status: Active
date: 2026-10-21
decision: Apply one parity rule to Claude, Cursor, and OpenCode. Known read tools and Pi bridge MCP tools allow, sandboxed shell keeps its existing policy, and every unknown or foreign tool asks or denies instead of passing silently; Cursor classifies shell by allowlisted segments, Claude fails closed on hook errors and installs an exit-2 guard, and OpenCode throws on unlisted tools. Follow-up: Pi's no-sandbox fallback never auto-runs bash (Discuss denies it; Plan needs fresh per-command human confirmation for every single-line command and denies multi-line and deny-listed ones) (F9, F12), and Cursor allows `rg`, `sort`, `uniq`, `find`, `tree`, and `git` only with per-command safe flags (F13).
why: ADR-0045 proved each harness passed unknown tool names, foreign MCP servers, and chained shell shapes differently. Silent pass-through makes an injected tool name equivalent to an allowlisted read, so the harnesses need one rule with evidence-labeled behavior.
affects: agent/claude-bridge-client/pi-readonly-hook.js, agent/claude-bridge-client/test-sessions.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/opencode-bridge-client/test-opencode-plugin.js, agent/extensions/harness-setup/setup.ts, agent/extensions/harness-setup/test/test_setup.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_policy.ts, scripts/security-corpus.json, scripts/check-workspace.mjs, docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/README.md
consequences: F3, F4, and F6 close in code, tests, and live acceptance; F5 closes in code and tests, with the exit-2 guard installed during live acceptance. Follow-up closes F9 and F12 in Pi's no-sandbox fallback. Read-only is still not enforced because Phase 3 has not closed F1/F2 self-escalation. Deny-unknown can temporarily block an unlisted read tool; the live allowlists matched observed names and need maintenance as harness tools change.
readWhen: changing harness read allowlists, Cursor shell classification, Claude PreToolUse registration or fail-closed behavior, foreign MCP gating, OpenCode execute-hook policy, or Pi's no-sandbox Discuss/Plan fallback
supersedes: None
extends: ADR-0045
---

# ADR-0046: Cross-harness tool classification and deny-unknown policy

## Context

ADR-0045 recorded the Phase 1 permission threat model and left three harness rows open: Claude allowed foreign tools, Cursor trusted read prefixes and one write tool name, and OpenCode gated four mutation names. Phase 2 implements the target rule for findings F3-F6 in code and tests, then validates it in live harness sessions.

This ADR extends ADR-0045. ADR-0045 stays `Proposed` and remains the threat model, trust-boundary, and evidence-standard record.

## Decision

### One parity rule

- Known read tools allow. The allowlist is a constant per harness and contains only names observed or explicitly documented as read-only.
- Pi bridge MCP tools allow. Claude matches the `mcp__pi-claude-bridge__` prefix; Cursor matches its bridge server set; OpenCode matches the `pi-claude-bridge_` prefix.
- Shell keeps its existing sandbox. The rule does not weaken the Seatbelt wrapper, the sandbox-disable denial, or the unavailable-sandbox denial.
- Unknown tool names and foreign MCP tools never pass silently. They ask on surfaces that can prompt a human and deny or throw on surfaces that cannot. `ask` is a blocking decision here, not a pass; this refines ADR-0045's deny-only wording for prompt-capable surfaces.
- Mutation tools deny before the read allowlist is consulted.
- Read-only is a policy target, not an enforced state, until Phase 3 closes F1/F2. A same-user agent can still assert plan confirmation and request a build lease.

### Claude

The PreToolUse hook is a catch-all:

- A thrown error anywhere in the hook emits a deny verdict with exit 0 and silence on stderr.
- `Edit`, `Write`, `MultiEdit`, and `NotebookEdit` deny.
- `Bash` keeps the sandboxed rewrite path and denies when the sandbox is unavailable or disabled.
- The bridge MCP prefix and a constant read/meta set (`Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `WebFetch`, `WebSearch`, `TodoRead`, `BashOutput`, `TaskOutput`) pass with no decision.
- Every other tool name, including `Task`/`Agent` and foreign MCP names, returns `permissionDecision: "ask"` with the tool name in the message.
- The harness installer writes an exit-2 guard on the Claude `PreToolUse` command only. An owned but unguarded entry is reported as a repairable `unguarded-hook` problem; `UserPromptSubmit` and `SessionEnd` remain unguarded.

The guard covers the case where the hook process cannot start or exits non-zero. The catch-all covers errors after it starts.

### Cursor

Shell classification replaces prefix matching with a quote-aware segment scan:

- Split only on unquoted `|`, `&&`, `;`, and `&`; quoted separators stay inside one argument.
- Each segment must name an allowlisted read command, and each command has its own flag checks. Output-writing flags, delete/exec predicates, preprocessors that execute commands, and extra `uniq` paths ask rather than allow.
- Dynamic syntax asks: substitution, backticks, redirects, subshell or brace groups, newlines, interpreters, and unknown commands.
- The existing mutation set still denies before segment analysis.
- Lease-holder behavior is unchanged.

`preToolUse` allows the constant read set plus shell/MCP tool types so the dedicated `beforeShellExecution` and `beforeMCPExecution` events remain the decision point. Every other tool name denies without a prompt. `classifyMcp` keeps its split: bridge allow, mutating-name deny, unknown ask.

### OpenCode

The execute hook allows:

- the constant read set (`read`, `grep`, `glob`, `list`, `ls`, `find`, `todoread`, `webfetch`, `websearch`, `skill`, `question`);
- `pi-claude-bridge_*` tools;
- the sandbox-wrapped `shell` path;
- the `execute` Code Mode dispatcher, so nested tool calls re-enter the hook.

Every other tool throws with the tool name in the message, including patch-style names, unknown names, and foreign MCP names. Host identity overwrite and lease-holder pass-through are unchanged; Phase 3 owns identity and lease hardening.

## Why

ADR-0045 showed that "read-only" meant a different thing on each surface. The parity rule gives one testable predicate and one failure direction: if a tool is not known read-only, the harness must not silently run it.

Rejected alternatives:

- Keep per-harness defaults and document them: leaves foreign tools equivalent to reads and makes every later audit rediscover the same gaps.
- Deny every unknown tool on every surface: Claude and Cursor can prompt, so an ask preserves legitimate unlisted reads without granting them.
- Allow unknown tools when a lease exists: the lease is not a trust signal until F1/F2 close, and it would mask foreign-tool behavior.
- Rewrite Cursor shell matching with a larger regex: chained segments, quoting, and per-command flags need structural classification, not a longer prefix alternation.

## Live acceptance

Acceptance ran in a disposable project containing `.pi/`, with harness configs temporarily retargeted to the development checkout. No Pi build lease was active in that project. A test-only MCP server was added to Cursor and OpenCode, then removed.

| Harness | Observed |
|---|---|
| Cursor | Reads and search allowed; write denied; read pipeline allowed; chained interpreter asked; foreign MCP denied |
| OpenCode | Read and search allowed; edit threw; shell ran sandboxed; foreign MCP threw; nested `execute` read allowed and nested write blocked |
| Claude | Read and search allowed; write denied; `Agent`/`Task` asked, then the subagent write was denied; foreign `pencil` MCP asked |

Observed tool names matched the guessed allowlists, so no amendments were required. `npm test` exited 0 after the acceptance.

Verified by this acceptance: Claude subagent PreToolUse firing, the real Cursor/OpenCode read, shell, and foreign-MCP names exercised above, and the parity behavior in the table.

Still `not-verified`:

- Claude hook-timeout behavior.
- OpenCode behavior when the plugin fails to load.
- Cursor and OpenCode subagent identity and hook firing.
- Whether Cursor also fires `preToolUse` for shell/MCP tool types; the dedicated events were used.
- Seatbelt `(allow default)` escape through LaunchServices; not tested destructively.

## Follow-up: Pi no-sandbox fallback (F9, F12)

Applies only when Pi Discuss or Plan has no structural sandbox launcher or wrapping fails; sandboxed paths are unchanged.

- Pi never auto-runs bash without a sandbox: no classifier decides a command is safe. Discuss denies all bash and points at the read/grep/find/ls tools (F12).
- Plan denies empty, multi-line (a prompt could hide a line), and deny-listed commands (`BASH_MUTATION_DENY`, `BASH_WRITE_REDIRECT` incl. `<>`), then sends every other single-line command to `confirmCommand` ("Run without sandbox?"), the same gate as Review posting: sanitized exact command, literal `true` only, no cache; decline, headless, a subagent's cancelled confirm, or a dialog error blocks (F9, F12).
- `isBashAllowedInMode` returns false for Discuss and Plan, which the corpus uses to model a no-UI decline; Review keeps its allow-list.
- History: a first pass auto-allowed plain reads; review found writing flags on allowlisted reads, so a second pass reused this ADR's Cursor classifier through `createRequire`; review then found more classifier gaps (F13), and `createRequire` is forbidden in extension source (`docs/engineering/invariants.md`). Both were dropped; `scripts/check-workspace.mjs` now rejects `createRequire` in every extension `.ts` file.
- Why approval, not a better parser: ADR-0045 requires deny or human approval where shell safety cannot be established, and two reviews showed classification does not establish it.
- Cost: without a launcher, Discuss runs no bash and Plan prompts for every command; headless Plan cannot run bash. Sandboxed hosts (macOS always) are unchanged.
- Evidence: `test_policy.ts` covers no auto-run in Discuss/Plan, confirm for reads and reviewed flag forms, deny for empty/multi-line/deny-listed, decline, headless, throw, cancel, and non-literal cases **E**; corpus Pi read defaults, `pi-plan-wildcard-test`, and 14 `pi-fallback-*` cases deny without UI in both lanes **E**; live Plan prompt **N** because macOS always wraps with Seatbelt.

## Follow-up: Cursor per-command safe flags (F13)

- `rg`, `sort`, `uniq`, `tree`, and `git` pass only with flags on explicit safe lists (`SAFE_FLAGS` in `agent/cursor-bridge-client/cursor-readonly-hook.js`): exact long names (so GNU abbreviations such as `sort --o` ask), clustered short flags checked per letter, valued flags consume their value, and a value that looks like a flag asks. `find` passes only listed primaries. `uniq` counts every operand, including `-` and those after `--`, and allows at most one.
- Anything else returns `ask`, so Cursor prompts rather than denies.
- Why safe lists, not bad lists: two reviews found writers and executors that bad-flag lists missed (`rg --hostname-bin`, `sort --compress-program`, `sort --o`/`--outp=`, `uniq - out`).
- Limit: git can run programs from repository config (`diff.external`, textconv) even with safe flags; exploiting it needs write access to `.git/config`, so it is recorded, not fixed by flags.
- Evidence: `test-cursor-readonly-hook.js` asks on 23 writer/executor forms and allows 18 common safe forms **E**; four `shell-*` corpus cases run on Claude, Cursor, and OpenCode in both lanes **E**.

## Consequences

- Good: F3, F4, and F6 close in code, tests, and live acceptance; F5 closes in code and tests, with the exit-2 guard installed during live acceptance.
- Good: one rule lets ADR-0045 matrix cells carry a single evidence label per capability.
- Good: Claude crash paths fail closed; the installer makes an unguarded install visible and repairable.
- Bad/risk: read-only remains unenforced until Phase 3 closes F1 and F2. This ADR must not be cited as a read-only guarantee.
- Bad/risk: deny-unknown blocks unlisted read tools until the allowlist is updated. Live acceptance matched the current guesses but did not prove future harness releases.
- Bad/risk: Claude asks on `Task`/`Agent`, which adds a prompt before subagent work.
- Bad/risk: if the OpenCode plugin does not load, the policy is absent; that failure mode remains unverified.

## Affects

Docs:

- `docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md`
- `docs/engineering/decisions/README.md`

Code and tests:

- `agent/claude-bridge-client/pi-readonly-hook.js`
- `agent/claude-bridge-client/test-sessions.js`
- `agent/cursor-bridge-client/cursor-readonly-hook.js`
- `agent/cursor-bridge-client/test-cursor-readonly-hook.js`
- `agent/opencode-bridge-client/pi-opencode-plugin.js`
- `agent/opencode-bridge-client/test-opencode-plugin.js`
- `agent/extensions/harness-setup/setup.ts`
- `agent/extensions/harness-setup/test/test_setup.ts`
- `agent/extensions/workflow-modes/policy.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/test/test_policy.ts`
- `scripts/security-corpus.json`

## Read when

- changing a harness read-tool allowlist or bridge-tool prefix
- changing Cursor shell classification or per-command flag checks
- changing Claude PreToolUse registration, fail-closed behavior, or hook command shape
- changing foreign MCP or unknown-tool decisions
- updating the ADR-0045 matrix or Phase 3 lease/identity work
- changing Pi's no-sandbox Discuss/Plan fallback or its confirmation gate

## Extends

- ADR-0045

## Supersedes

- None
