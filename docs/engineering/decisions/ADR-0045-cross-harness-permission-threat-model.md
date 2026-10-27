---
id: ADR-0045
title: Cross-harness permission threat model and policy states
status: Proposed
date: 2026-10-21
decision: Define one adversary model, three policy states (read-only, approved build, review-only), a trust boundary between harness-supplied identity and agent-asserted MCP arguments, and an evidence-labeled permission matrix for Pi, Pi subagents, Claude, Cursor, and OpenCode; Phase 5 closes F7 and records F8 as an accepted limit.
why: Enforcement is uneven across harnesses. Before Phases 2-3, Build authorization could be agent-asserted and tool policy diverged. This ADR provides one normative target and evidence standard instead of re-auditing each surface.
affects: docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/ADR-0047-human-approved-harness-build-lease.md, docs/engineering/decisions/ADR-0048-security-regression-corpus.md, docs/engineering/decisions/README.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, scripts/security-corpus.json, scripts/test-security-corpus.ts, package.json, .github/workflows/ci.yml, agent/claude-bridge-client/pi-readonly-hook.js, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/test-sessions.js, agent/claude-bridge-client/test-core-protocol.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/cursor-bridge-client/test-cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/opencode-bridge-client/test-opencode-plugin.js, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/test/test_build_lease.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/sandbox.ts, agent/extensions/subagents/policy.ts, agent/extensions/harness-setup/setup.ts
consequences: Phases 2-5 have a testable target per cell; ADR-0047 closes F1/F2 and ADR-0048 records completed Phase 4 corpus hardening. Phase 5 implements the F7 confirmation gate and accepts F8 as a residual limit; F9/F10 remain follow-up gaps, not sanctioned workflows. ADR stays under the 25 KB recall budget and omits runnable bypass payloads.
readWhen: changing bridge lease acquisition or release, harness hooks, harness setup hook registration, shell policy, sandbox profiles, foreign MCP gating, subagent toolset validation, Review posting confirmation, or shared security-corpus findings
supersedes: None
extends: ADR-0022, ADR-0043
---

# ADR-0045: Cross-harness permission threat model and policy states

## Context

Five surfaces can act on a Pi project: Pi main in a workflow mode, Pi subagents, Claude Code, Cursor, and OpenCode. Each enforces its own subset:

- Pi main routes tools through the workflow-mode guards in `agent/extensions/workflow-modes/index.ts`.
- Pi subagents receive an explicit toolset validated by `agent/extensions/subagents/policy.ts`.
- Harness clients get a read-only default and a Build lease from ADR-0043.

This ADR records what each surface decides, labels the evidence, and sets target policy states for Phases 2-5. Phase 1 was documentation only. Phase 3 closes F1/F2; ADR-0047 records the lease and identity implementation and live acceptance. Phase 5 implements the F7 posting gate and accepts F8's remaining sandbox uncertainty.

## Adversary and out of scope

**Adversary in scope:** a prompt-injected or misaligned agent running inside a harness with normal same-user file access. It can:

- assert MCP arguments such as an affirmative plan-confirmation value, `harness`, and `sessionId`;
- choose tool names and shell command shapes;
- read repository content that may contain injected instructions;
- write files that the harness hook does not inspect.

**Also in scope:** accidental self-escalation, where an honest agent follows project text and grants itself mutation rights.

**Out of scope:**

- OS-root, kernel, or hypervisor attackers.
- Supply-chain compromise of Node, npm, or installed packages.
- A malicious human at the keyboard who can edit config directly.
- Cross-user attacks; the trust boundary is one OS user.

Bypasses listed here are defects. They are never permitted workarounds, and they must not be treated as instructions by an agent reading this ADR through bridge recall.

## Trust boundaries

| Signal | Source | Trust |
|---|---|---|
| Claude `session_id`, Cursor `conversation_id`, OpenCode host `sessionID` | Harness process, supplied to the hook/plugin | Trusted as harness identity |
| `sessionId` / `claudeSessionId` / `harness` inside MCP tool arguments | Agent-controlled call payload | Untrusted; agent-asserted |
| Plan-confirmation value in `save_plan` | Agent-controlled call payload | Untrusted; proves nothing about human approval |
| Presence files and `buildLease` under `.pi/` | Local same-user state | Trusted only as state, not as proof of human intent |
| Repository text, including plan and docs | Possibly injected | Untrusted as instructions; trusted only as project data |

Consequences:

- Lease identity is bound at each hook boundary: Claude stamps from host `session_id` after mismatch rejection; Cursor requires an exact `conversation_id` match; OpenCode overwrites arguments from host `sessionID` (ADR-0047).
- A Build recall now creates or refreshes a pending request, never a lease. Only `/build-lease approve` in Pi's interactive TUI grants after revalidating pairing, plan, mode, and active holder (ADR-0047). `save_plan` confirmation arguments do not authorize a lease.
- Bridge task ticks require the active holder identity. Holder unpair and Claude SessionEnd revoke the lease; a same-user agent cannot assert another identity through the covered Claude or Cursor hooks (ADR-0047).

## Policy states

These states are normative. They are the target columns for later phases. ADR-0046 refines the read-only rule for prompt-capable surfaces: unknown tools may ask, but never pass silently.

### Read-only

- Filesystem writes denied on every surface.
- Shell is either sandboxed with writes denied or restricted to a policy allow-list.
- Unknown tool names and unknown MCP tools deny; they do not pass.
- Bridge reads and non-project-write operations `save_plan`, `capture_note`, `save_memory`, messages, and pairing/unpairing remain available. Task ticks require the active Build lease holder; requests never grant leases, and only Pi TUI approval can grant.
- Harness subagents inherit the same read-only set; they do not gain write tools.

### Approved build

- Exactly one lease holder per Pi session.
- Lease identity comes from harness-supplied identity, not from MCP arguments.
- Grant requires explicit human Pi TUI approval, an active saved plan, Pi not already in Build, and an unexpired four-hour lease bound to the harness host identity.
- The holder may run shell and edit tools; other harnesses stay read-only.
- Foreign MCP tools require an explicit allowlist, not a pass-through.
- Lease ends on explicit/lifecycle release or holder unpair and expires after four hours; stale presence always returns hooks to read-only behavior.

### Review-only

- Filesystem writes denied.
- Network reads and scoped `gh pr` reads allowed.
- Pi Review posting requires fresh, per-command Pi confirmation, independently of the model prompt. Display the sanitized exact original command; only literal `ctx.hasUI === true` plus awaited `ctx.ui.confirm(...) === true` approves. Use `confirm`, never `select`; decline, missing UI, or confirmation error blocks before sandbox wrapping. Approval is not cached.
- No merge, close, or repository-admin operations.

## Permission matrix

Legend: **E** = `verified-exec`, **C** = `code-read`, **N** = `not-verified`. Each cell carries exactly one label. Enforcement points and fail modes are in the same row. Target decisions are in "Target per state".

Updated by ADR-0046 after Phase 2 and ADR-0047 after Phase 3: Claude, Cursor, and OpenCode rows reflect current code and live acceptance.

| Surface | Shell | Edit / write / delete | Bridge MCP | Foreign MCP | Harness subagents | Bridge state changes | Enforcement point | Fail mode |
|---|---|---|---|---|---|---|---|---|
| Pi Discuss | read allow; mutation deny **E** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:866-920` | closed |
| Pi Plan | read + tests allow; mutation deny **E** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:866-920` | closed |
| Pi Build | unguarded **C** | allowed **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:867` early return | intentional open |
| Pi Review | read + `gh pr` allow; fresh per-post Pi confirmation before network sandbox, no cache **C** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:888-904`, `agent/extensions/workflow-modes/policy.ts:30-50` | closed |
| Pi Design | plan-level policy **E** | design surface only **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:869-876` | closed |
| Pi subagents | per toolset **C** | build toolset only **E** | not in read-only set **C** | per toolset **C** | n/a **C** | build toolset only **E** | `agent/extensions/subagents/policy.ts:46-51` | closed |
| Claude | sandboxed allow; disable flag deny; no sandbox deny **E** | four mutation tools deny; read built-ins pass; other tools ask **E** | host `session_id` stamped; mismatches denied; expiry fail-closed **E** | foreign MCP ask **E** | subagent write denied in live test **E** | safe updates allowed; holder-only tick; human-only grant **E** | `agent/claude-bridge-client/pi-readonly-hook.js:125-191`, `agent/extensions/harness-setup/setup.ts:788-793` | closed on crash **E** |
| Cursor | segment allowlist; hidden writers ask; mutations deny **E** | read allowlist; unknown and patch names deny **E** | matching `conversation_id` identity required; expiry fail-closed **E** | mutating-name deny; unknown ask **E** | unverified **N** | safe updates allowed; holder-only tick; human-only grant **E** | `agent/cursor-bridge-client/cursor-readonly-hook.js:71-231` | closed **E** |
| OpenCode | sandboxed; no sandbox throws **E** | read allowlist; edit/write/worktree and unknown throw **E** | host `sessionID` identity overwritten; expiry fail-closed **E** | unknown and foreign throw **E** | child identity unverified **N** | safe updates allowed; holder-only tick; human-only grant **E** | `agent/opencode-bridge-client/pi-opencode-plugin.js:37-83` | closed **E** |

## Target per state

| Capability | Read-only | Approved build | Review-only |
|---|---|---|---|
| Shell | sandboxed writes denied, or allow-list only | holder: allowed within lease | sandboxed writes denied; scoped `gh pr` reads; Pi posting needs fresh per-command confirmation (literal `ctx.hasUI === true` and awaited `ctx.ui.confirm(...) === true`); no cache; otherwise blocks |
| Edit / write / delete | deny all tools, including unknown names | holder: allowed; others deny | deny all tools |
| Bridge MCP | Reads and listed non-project-write operations remain available; host identity required; request is not grant | Same operations; only active holder may tick; Pi human approval grants; four-hour expiry | read tools only |
| Foreign MCP | deny unless explicit read allowlist | deny unless explicit allowlist | deny unless explicit read allowlist |
| Harness subagents | inherit read-only set | inherit holder rights; no new lease | inherit read-only set |
| Bridge state changes | allow `save_plan`, `capture_note`, `save_memory`, messages, pairing/unpairing; holder-only task tick; human-only grant | Same safe updates; active holder may tick; human Pi approval only grants; Pi release, holder unpair, workflow change, or expiry revokes | deny; posting requires human approval |
| Identity | harness-supplied only | harness-supplied only | harness-supplied only |
| Fail mode | closed | closed outside the holder | closed |

## Findings

| ID | Finding | Severity | Current evidence | Target phase |
|---|---|---|---|---|
| F1 | Self-escalation without a human: agent asserts a plan-confirmation value, then Build recall grants the lease (closed by ADR-0047) | High | Request/approval separation, headless refusal, and operator-reported live acceptance **E** | 3 — closed by ADR-0047 |
| F2 | Claude and Cursor bridge identity is agent-asserted and replayable by a same-user process (closed by ADR-0047) | High | Claude/Cursor mismatch denial, host identity binding, and operator-reported live acceptance **E** | 3 — closed by ADR-0047 |
| F3 | Cursor shell classifier allows a read prefix followed by an interpreter or write, `find -delete`, pipe-to-interpreter, and `git diff --output` | High | `agent/cursor-bridge-client/cursor-readonly-hook.js:11-12`, `:57-62` **E** | 2 |
| F4 | Cursor `preToolUse` denies only a tool named `write`; `edit`, `multiedit`, `delete`, and patch-style names pass | High | `agent/cursor-bridge-client/cursor-readonly-hook.js:85-90` **E** | 2 |
| F5 | Claude hook has no matcher and no fail-closed flag; a crash exits non-2, which Claude treats as non-blocking | Medium | crash **E**; registration `agent/extensions/harness-setup/setup.ts:775-779` **C**; host semantics **C** | 2 |
| F6 | Foreign MCP gating diverges: Claude passes all, Cursor checks names, OpenCode gates four tool names | Medium | `pi-readonly-hook.js:159` **E**, `cursor-readonly-hook.js:72-78` **E**, `pi-opencode-plugin.js:8-13` **E** | 2 |
| F7 | Review posting commands are in the shell allow-list and require per-command Pi confirmation before wrapping | Medium | `agent/extensions/workflow-modes/test/test_policy.ts` helper cases executed **E**; hook integration in `agent/extensions/workflow-modes/index.ts` confirmed by source inspection **C**; live interactive decline **N** (manual check deferred) | 5 — closed |
| F8 | Seatbelt profile is `(allow default)` plus denies; LaunchServices escape is a hypothesis, not demonstrated | Low | profile text **E**; P11 cases `ui-apple-events-keystroke`, `ui-cmux-send-keys`, `ui-tiocsti`: Claude/OpenCode blocked, Cursor asked, sink empty **E**; LaunchServices escape **N** | 5 — accepted limit |
| F9 | Pi Plan regex fallback admits test/build-classified commands without a structural sandbox | Medium | `pi-plan-wildcard-test`: wrapped with launcher, allowed without one **E**; `agent/extensions/workflow-modes/policy.ts:11,30-33` **C** | follow-up phase |
| F10 | Independent Pi-session Build leases do not ensure project-wide single-writer behavior | Medium | `lease-cross-session-write` reproduces across Claude/Cursor/OpenCode **E**; per-session namespace invariant in `docs/engineering/invariants.md` **C** | follow-up phase |

F3-F6 close in Phase 2; see ADR-0046. F1/F2 close in Phase 3; see ADR-0047. Phase 4 test hardening is complete under ADR-0048. Phase 5 gate implementation for F7 is complete; F8 is an accepted limit. Documentation rollout remains ongoing: the remaining Phase 5 README task is outstanding. Plan acceptance items #1 and #3 remain UNMET until F9/F10 receive follow-up. F7 evidence is bounded: automated helper cases executed **E**, hook integration source-confirmed **C**, and live interactive decline **N** because manual check was explicitly deferred; CI and full-plan acceptance are not claimed.

The P11 UI cases `ui-apple-events-keystroke`, `ui-cmux-send-keys`, and `ui-tiocsti` remain `execute: false` with `sandboxEvidence: "P11"`; they are not known gaps. Claude/OpenCode blocked the probes, Cursor asked, and the sink stayed empty.

## Consequences

- Good: Phases 2-5 can derive acceptance tests from "Target per state" without re-auditing each surface.
- Good: the matrix separates decision evidence from target policy, so a known defect cannot be mistaken for intended behavior.
- Good: trust boundaries are explicit, so later identity fixes have one reference.
- Bad/risk: remaining `not-verified` cells and known gaps F9/F10 stay open until follow-up; none may be reported as fixed.
- Bad/risk: live interactive decline, CI, and full-plan acceptance evidence remain incomplete; helper tests and source inspection do not establish them.
- Bad/risk: every bridge recall ships this ADR into harness context, so bypass descriptions stay structural and non-runnable.

## Appendix A: Probe table

P1-P10 ran on macOS with Node 25.8.2 in a throwaway `mktemp -d` project containing `.pi/`; none called the live bridge or executed a wrapped command body. P11 ran operator-supervised on macOS 26.6.2 (arm64) with a dummy cmux pane and focused terminal, using neutral markers only; it never targeted Pi or a live approval. Inputs remain neutral shapes, not payloads.

| Probe | Surface | Neutral input shape | Observed | Label |
|---|---|---|---|---|
| P1a | Claude hook | mutation tool names | deny, exit 0 | **E** |
| P1b | Claude hook | read-only shell command | allow with sandboxed rewrite | **E** |
| P1c | Claude hook | shell plus sandbox-disable flag | deny | **E** |
| P1d | Claude hook | foreign MCP tool name | empty allow object | **E** |
| P1e | Claude hook | malformed stdin | deny | **E** |
| P1f | Claude hook | shell with sandbox forced unavailable | deny | **E** |
| P1g | Claude hook | write outside a Pi project | empty allow object | **E** |
| P2 | Claude hook | shell with unwritable `TMPDIR` | exit 1, no verdict JSON | **E** |
| P3 | Cursor `classifyShell` | read-prefix plus interpreter write | allow | **E** |
| P3 | Cursor `classifyShell` | `find <path> -delete` | allow | **E** |
| P3 | Cursor `classifyShell` | read command piped to interpreter | allow | **E** |
| P3 | Cursor `classifyShell` | `git diff --output=<file>` | allow | **E** |
| P3 | Cursor `classifyShell` | obvious mutate / unknown | deny / ask | **E** |
| P4 | Cursor `classifyTool` | `Write` / `Edit` / `Delete` / patch name | deny / allow / allow / allow | **E** |
| P5 | Cursor `classifyMcp` | bridge / mutating foreign / unknown foreign | allow / deny / ask | **E** |
| P6 | OpenCode plugin | edit, write, worktree create | throw | **E** |
| P6 | OpenCode plugin | patch-style name, non-gated shell tool | pass | **E** |
| P6 | OpenCode plugin | shell command | sandboxed rewrite | **E** |
| P6 | OpenCode plugin | bridge call with spoofed identity args | host identity overwrites arguments | **E** |
| P6 | OpenCode plugin | invalid id, non-object input, invalid event, missing tool | throw | **E** |
| P7 | Pi `isBashAllowedInMode` | discuss read / mutate / interpreter | allow / deny / deny | **E** |
| P7 | Pi `isBashAllowedInMode` | plan test / mutate / interpreter | allow / deny / deny | **E** |
| P7 | Pi `isBashAllowedInMode` | review `gh pr review`, comment, view | allow | **E** |
| P7 | Pi `isBashAllowedInMode` | review `curl`, `gh pr merge` | deny | **E** |
| P8 | Lease decisions | no plan / Pi building / Pi peer | three distinct error codes | **E** |
| P8 | Lease decisions | request / approval / same-peer repeat / other holder | pending / grant after approval / idempotent / held | **E** |
| P8 | Lease release | holder recall, workflow change, expiry, or unpair | release / revoke / keep | **E** |
| P9 | Subagent toolset | read set, mutation, unknown, build | ok / error / error / ok | **E** |
| P10 | Seatbelt profile | generated profile text | allow default, deny network, deny writes | **E** |
| P10 | `wrapCommand` | launcher forced to `sandbox-exec` | wrapped, sandbox prefix, deny network | **E** |
| P11 | Pi TUI approval | non-destructive external-input probe | read-only shells: Claude/OpenCode block all 3 vectors; Cursor asks all 3; sink empty | **E** |

P11 sink results (sink checked after each probe; no cell produced bytes):

| Vector | Claude | Cursor | OpenCode |
|---|---|---|---|
| Apple Events keystroke | blocked: Seatbelt privilege violation | ask: not executed | blocked: Seatbelt privilege violation |
| tmux/cmux send-keys | blocked: socket operation not permitted | ask: not executed | blocked: socket operation not permitted |
| TIOCSTI on own tty | blocked: `/dev/tty` operation not permitted | ask: not executed | blocked: `/dev/tty` operation not permitted |

Host controls reached the same dummy sink through unsandboxed Apple Events and cmux send-keys; unsandboxed TIOCSTI injected into its own pty. The live sink and focus therefore rule out a dead-target false negative. ADR-0047 A1 is verified for the probed read-only states; Cursor operator-approved execution and Build mode were not probed.

## Open questions

Phase 2 live acceptance verified Claude subagent `PreToolUse` firing and the Cursor/OpenCode read, shell, and foreign-MCP names exercised in ADR-0046. These remain `not-verified`; do not state them as facts.

- Does Claude enforce hook timeouts as deny?
- What happens when the OpenCode plugin fails to load?
- Do Cursor and OpenCode subagents receive the same hook or plugin policy?
- Does Cursor fire `preToolUse` for shell/MCP tool types in addition to the dedicated events?
- Can Seatbelt `(allow default)` be escaped through LaunchServices? Not tested, and it must not be tested destructively.
