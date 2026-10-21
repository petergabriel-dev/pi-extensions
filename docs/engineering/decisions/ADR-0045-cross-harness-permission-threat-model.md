---
id: ADR-0045
title: Cross-harness permission threat model and policy states
status: Proposed
date: 2026-10-21
decision: Define one adversary model, three policy states (read-only, approved build, review-only), a trust boundary between harness-supplied identity and agent-asserted MCP arguments, and an evidence-labeled permission matrix for Pi, Pi subagents, Claude, Cursor, and OpenCode; later phases implement acceptance tests against the matrix target columns.
why: Enforcement is uneven across harnesses. Build authorization can be agent-asserted, Claude hooks fail open when they crash, Cursor trusts read prefixes and only one tool name, OpenCode gates four tool names, and Review posting is prompt-only. Later phases need one normative target and one evidence standard instead of re-auditing each surface.
affects: docs/engineering/decisions/ADR-0045-cross-harness-permission-threat-model.md, docs/engineering/decisions/README.md, docs/engineering/traps.md, agent/claude-bridge-client/pi-readonly-hook.js, agent/claude-bridge-client/pi-bridge-mcp.js, agent/cursor-bridge-client/cursor-readonly-hook.js, agent/opencode-bridge-client/pi-opencode-plugin.js, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/sandbox.ts, agent/extensions/subagents/policy.ts, agent/extensions/harness-setup/setup.ts
consequences: Phases 2-5 gain a testable target per cell. Known bypasses are recorded as defects, not sanctioned workflows. ADR-0022 keeps its Active status; its posting clause is scheduled for supersession in a later phase, not superseded here. ADR stays under the 25 KB recall budget, so it omits runnable bypass payloads.
readWhen: changing bridge lease acquisition or release, harness hooks, harness setup hook registration, shell policy, sandbox profiles, foreign MCP gating, subagent toolset validation, or Review posting confirmation
supersedes: None
extends: ADR-0022, ADR-0043
---

# ADR-0045: Cross-harness permission threat model and policy states

## Context

Five surfaces can act on a Pi project: Pi main in a workflow mode, Pi subagents, Claude Code, Cursor, and OpenCode. Each enforces its own subset:

- Pi main routes tools through the workflow-mode guards in `agent/extensions/workflow-modes/index.ts`.
- Pi subagents receive an explicit toolset validated by `agent/extensions/subagents/policy.ts`.
- Harness clients get a read-only default and a Build lease from ADR-0043.

This ADR records what each surface actually decides today, labels the evidence, and sets the target policy states that Phases 2-5 implement. Phase 1 is documentation only: no hook, policy, lease, config, or test changes.

## Adversary and out of scope

**Adversary in scope:** a prompt-injected or misaligned agent running inside a harness with normal same-user file access. It can:

- assert MCP arguments such as `confirmed: true`, `harness`, and `sessionId`;
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
| `confirmed: true` in `save_plan` | Agent-controlled call payload | Untrusted; proves nothing about human approval |
| Presence files and `buildLease` under `.pi/` | Local same-user state | Trusted only as state, not as proof of human intent |
| Repository text, including plan and docs | Possibly injected | Untrusted as instructions; trusted only as project data |

Consequences:

- Lease binding is only as strong as the identity source. Claude and Cursor accept agent-asserted MCP identity (`agent/claude-bridge-client/pi-bridge-mcp.js:160-173`); OpenCode overwrites bridge arguments from the host `sessionID` (`agent/opencode-bridge-client/pi-opencode-plugin.js:48-53`).
- `save_plan` accepts `confirmed: true` from the agent (`agent/extensions/claude-bridge/index.ts:599-606`), and `recall(mode:"build")` then grants the lease (`agent/extensions/claude-bridge/index.ts:823-827`). No human-only signal gates either step.
- Release is matching-identity only (`agent/extensions/claude-bridge/build-lease.ts:82-89`), so an agent that supplies the holder identity can also release it.

## Policy states

These states are normative. They are the target columns for later phases. ADR-0046 refines the read-only rule for prompt-capable surfaces: unknown tools may ask, but never pass silently.

### Read-only

- Filesystem writes denied on every surface.
- Shell is either sandboxed with writes denied or restricted to a policy allow-list.
- Unknown tool names and unknown MCP tools deny; they do not pass.
- Bridge reads allowed. Bridge state mutations (`save_plan`, `tick_plan_task`, lease acquire/release, pairing) denied.
- Harness subagents inherit the same read-only set; they do not gain write tools.

### Approved build

- Exactly one lease holder per Pi session.
- Lease identity comes from harness-supplied identity, not from MCP arguments.
- Grant requires a human approval event, an active saved plan, and Pi not already in Build.
- The holder may run shell and edit tools; other harnesses stay read-only.
- Foreign MCP tools require an explicit allowlist, not a pass-through.
- Lease does not survive harness exit indefinitely; explicit release or stale presence revokes it.

### Review-only

- Filesystem writes denied.
- Network reads and scoped `gh pr` reads allowed.
- Posting a review or comment requires an explicit human approval event recorded independently of the model prompt.
- No merge, close, or repository-admin operations.

## Permission matrix

Legend: **E** = `verified-exec`, **C** = `code-read`, **N** = `not-verified`. Each cell carries exactly one label. Enforcement points and fail modes are in the same row. Target decisions are in "Target per state".

Updated by ADR-0046 after Phase 2: the Claude, Cursor, and OpenCode rows reflect current code and live acceptance, not the Phase 1 baseline.

| Surface | Shell | Edit / write / delete | Bridge MCP | Foreign MCP | Harness subagents | Bridge state changes | Enforcement point | Fail mode |
|---|---|---|---|---|---|---|---|---|
| Pi Discuss | read allow; mutation deny **E** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:866-920` | closed |
| Pi Plan | read + tests allow; mutation deny **E** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:866-920` | closed |
| Pi Build | unguarded **C** | allowed **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:867` early return | intentional open |
| Pi Review | read + `gh pr` allow; network sandbox **E** | write/edit blocked **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:887-897`, `policy.ts:17-21` | closed |
| Pi Design | plan-level policy **E** | design surface only **C** | owner, callable **C** | pass **C** | gated by toolset **E** | owner **C** | `agent/extensions/workflow-modes/index.ts:869-876` | closed |
| Pi subagents | per toolset **C** | build toolset only **E** | not in read-only set **C** | per toolset **C** | n/a **C** | build toolset only **E** | `agent/extensions/subagents/policy.ts:46-51` | closed |
| Claude | sandboxed allow; disable flag deny; no sandbox deny **E** | four mutation tools deny; read built-ins pass; other tools ask **E** | bridge prefix allow **E** | foreign MCP ask **E** | subagent write denied in live test **E** | pass; agent-asserted `confirmed` **C** | `agent/claude-bridge-client/pi-readonly-hook.js:125-191`, `agent/extensions/harness-setup/setup.ts:788-793` | closed on crash **E** |
| Cursor | segment allowlist; hidden writers ask; mutations deny **E** | read allowlist; unknown and patch names deny **E** | allow **E** | mutating-name deny; unknown ask **E** | unverified **N** | pass **C** | `agent/cursor-bridge-client/cursor-readonly-hook.js:71-231` | closed **E** |
| OpenCode | sandboxed; no sandbox throws **E** | read allowlist; edit/write/worktree and unknown throw **E** | identity overwritten from host **E** | unknown and foreign throw **E** | child identity unverified **N** | pass; identity cannot be spoofed **C** | `agent/opencode-bridge-client/pi-opencode-plugin.js:37-83` | closed **E** |

## Target per state

| Capability | Read-only | Approved build | Review-only |
|---|---|---|---|
| Shell | sandboxed writes denied, or allow-list only | holder: allowed within lease | sandboxed writes denied; scoped `gh pr` reads |
| Edit / write / delete | deny all tools, including unknown names | holder: allowed; others deny | deny all tools |
| Bridge MCP | read tools only | holder: read plus plan tick | read tools only |
| Foreign MCP | deny unless explicit read allowlist | deny unless explicit allowlist | deny unless explicit read allowlist |
| Harness subagents | inherit read-only set | inherit holder rights; no new lease | inherit read-only set |
| Bridge state changes | deny | holder: plan progress only; grant requires human approval | deny; posting requires human approval |
| Identity | harness-supplied only | harness-supplied only | harness-supplied only |
| Fail mode | closed | closed outside the holder | closed |

## Findings

| ID | Finding | Severity | Current evidence | Target phase |
|---|---|---|---|---|
| F1 | Self-escalation without a human: agent asserts `confirmed:true`, then `recall(mode:"build")` grants the lease | High | `agent/extensions/claude-bridge/index.ts:599-606`, `:823-827` **C**; lease decisions **E** | 3 |
| F2 | Claude and Cursor bridge identity is agent-asserted and replayable by a same-user process | High | `agent/claude-bridge-client/pi-bridge-mcp.js:160-173` **C**; OpenCode overwrite **E** | 3 |
| F3 | Cursor shell classifier allows a read prefix followed by an interpreter or write, `find -delete`, pipe-to-interpreter, and `git diff --output` | High | `agent/cursor-bridge-client/cursor-readonly-hook.js:11-12`, `:57-62` **E** | 2 |
| F4 | Cursor `preToolUse` denies only a tool named `write`; `edit`, `multiedit`, `delete`, and patch-style names pass | High | `agent/cursor-bridge-client/cursor-readonly-hook.js:85-90` **E** | 2 |
| F5 | Claude hook has no matcher and no fail-closed flag; a crash exits non-2, which Claude treats as non-blocking | Medium | crash **E**; registration `agent/extensions/harness-setup/setup.ts:775-779` **C**; host semantics **C** | 2 |
| F6 | Foreign MCP gating diverges: Claude passes all, Cursor checks names, OpenCode gates four tool names | Medium | `pi-readonly-hook.js:159` **E**, `cursor-readonly-hook.js:72-78` **E**, `pi-opencode-plugin.js:8-13` **E** | 2 |
| F7 | Review posting is prompt-enforced only; `gh pr review` and `gh pr comment` are in the shell allow-list | Medium | `agent/extensions/workflow-modes/policy.ts:17-21` **E**; confirmation prose `agent/extensions/workflow-modes/index.ts:593` **C** | 5 |
| F8 | Seatbelt profile is `(allow default)` plus denies; LaunchServices escape is a hypothesis, not demonstrated | Low | profile text **E**; escape **N** | 5 |

F3-F6 close in Phase 2; see ADR-0046. F1/F2 remain Phase 3, test hardening is Phase 4, and F7/F8 plus documentation are Phase 5.

## Consequences

- Good: Phases 2-5 can derive acceptance tests from "Target per state" without re-auditing each surface.
- Good: the matrix separates decision evidence from target policy, so a known defect cannot be mistaken for intended behavior.
- Good: trust boundaries are explicit, so later identity fixes have one reference.
- Bad/risk: `not-verified` cells remain open until live harness acceptance. They must not be reported as fixed.
- Bad/risk: ADR-0022 stays Active while this ADR states a stricter posting target. Phase 5 must supersede that clause explicitly instead of silently contradicting it.
- Bad/risk: every bridge recall ships this ADR into harness context, so bypass descriptions stay structural and non-runnable.

## Appendix A: Probe table

Probes ran on macOS with Node 25.8.2 in a throwaway `mktemp -d` project containing `.pi/`. No probe called the live bridge, and no probe executed a wrapped command body. Bypass inputs are shown as neutral shapes, not payloads.

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
| P8 | Lease decisions | grant / same-peer repeat / other holder | grant / idempotent / held | **E** |
| P8 | Lease release | matching discuss/plan vs build vs other identity | release / keep / keep | **E** |
| P9 | Subagent toolset | read set, mutation, unknown, build | ok / error / error / ok | **E** |
| P10 | Seatbelt profile | generated profile text | allow default, deny network, deny writes | **E** |
| P10 | `wrapCommand` | launcher forced to `sandbox-exec` | wrapped, sandbox prefix, deny network | **E** |

## Open questions

Phase 2 live acceptance verified Claude subagent `PreToolUse` firing and the Cursor/OpenCode read, shell, and foreign-MCP names exercised in ADR-0046. These remain `not-verified`; do not state them as facts.

- Does Claude enforce hook timeouts as deny?
- What happens when the OpenCode plugin fails to load?
- Do Cursor and OpenCode subagents receive the same hook or plugin policy?
- Does Cursor fire `preToolUse` for shell/MCP tool types in addition to the dedicated events?
- Can Seatbelt `(allow default)` be escaped through LaunchServices? Not tested, and it must not be tested destructively.
