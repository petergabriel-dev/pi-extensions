---
id: ADR-0038
title: RPC-mode subagent transport
status: Active
date: 2026-10-08
decision: Run children with the parent Pi CLI in documented RPC mode; deliver results only through follow-up turns, steer live children at tool boundaries, default unset explorer effort to low, and use a per-run-token Unix socket for nested spawn, browser proxy, and ownership requests.
why: RPC mode removes the cmux surface and custom child lifecycle IPC while preserving parent-owned capability checks. A thin in-repo client is needed because upstream RpcClient uses PATH node, mirrors unbounded stderr to the parent TTY, and lacks process-exit and extension-UI response hooks.
affects: agent/extensions/subagents/rpc.ts, agent/extensions/subagents/launch.ts, agent/extensions/subagents/child.ts, agent/extensions/subagents/ipc.ts, agent/extensions/subagents/timeout.ts, agent/extensions/subagents/diagnostics.ts, agent/extensions/subagents/progress.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/effort.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/extensions/subagents/test/test_rpc.ts, agent/extensions/subagents/test/test_launch.ts, agent/extensions/subagents/test/test_ipc.ts, agent/extensions/subagents/test/test_child.ts, agent/extensions/subagents/test/test_timeout.ts, agent/extensions/subagents/test/test_lifecycle.ts, agent/extensions/subagents/test/test_effort.ts, agent/extensions/subagents/test/test_tool_surface.ts, agent/extensions/subagents/test/test_interaction.ts, agent/extensions/subagents/test/test_diagnostics.ts, agent/extensions/subagents/test/fixtures/fake-rpc-child.mjs, agent/extensions/subagents/test/smoke/fake-openai-server.mjs, agent/extensions/subagents/test/smoke/run-smoke.mjs, agent/extensions/browser/index.ts, agent/skills/worker-orchestration/SKILL.md, agent/extensions/workflow-modes/manual-delegation-verification.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md, docs/engineering/decisions/ADR-0010-subagent-idle-timeout.md, docs/engineering/decisions/ADR-0034-async-out-of-process-subagents.md, docs/engineering/decisions/ADR-0038-rpc-mode-subagent-transport.md, docs/engineering/decisions/README.md, README.md, CHANGELOG.md, SUBAGENT-FOLLOWUPS.md, package.json
consequences: Children use the parent process executable and CLI script without PATH lookup; prompt acceptance replaces hello readiness; final text comes only after agent_settled; per-run IPC tokens protect the lazy nested-spawn/browser side channel; bounded RPC framing, stderr logs, event tails, and termination escalation retain failure diagnostics. RPC protocol drift remains a compatibility risk; the side channel cannot carry results, questions, messages, or activity.
readWhen: Changing RPC child launch, readiness, result/list delivery, live steering, role effort defaults, stderr diagnostics, IPC token authentication, nested spawn/browser routing, event tails, lifecycle cleanup, or idle/max-total timeout behavior
supersedes: ADR-0034
---

# ADR-0038: RPC-mode subagent transport

## Decision

- Launch each child with `process.execPath` and the parent Pi CLI script resolved from `process.argv[1]`, using `--mode rpc`. Preserve `--no-extensions`, the child extension, and the loadout-authoritative `--tools` allowlist. Do not resolve `pi` or `node` from `PATH`; an unresolved CLI path is a classified launch failure, not a reason to fall back to `PATH`.
- Use a small in-repo JSONL RPC client instead of upstream `RpcClient`: upstream launches `node` from `PATH`, mirrors and grows stderr on the parent TTY, and has no process-exit or extension-UI response hooks. Decode LF-delimited records directly, cap records at 32 MiB, correlate command IDs, and keep child stderr in the bounded diagnostics log.
- Treat the `prompt` command response within 30 seconds as readiness. Missing `disposition` means `started`; `handled` means no run was started and is a classified launch failure. A child process exit before `agent_settled` is a classified failure.
- Resolve results only after `agent_settled`, then read `get_last_assistant_text`; do not infer final output from `agent_end`. Deliver results into the parent only through one automatic `sendUserMessage(..., { deliverAs: "followUp" })` turn. `subagents_list` retains structured result details but omits delivered bodies; on follow-up delivery failure it exposes capped result/transcript text. Unchanged non-tail list calls return a no-change nudge, not another delivery.
- Use RPC `steer` for messages to a running child; delivery occurs at the child's next tool boundary. RPC `abort` remains the hard stop; question-answer and finished-session resume paths are unchanged. Route `ask_question` through RPC extension UI requests (`input`/`select`) and answer through the matching UI response.
- Keep per-role effort settings-only: absent or invalid explorer effort resolves to `low`; absent or invalid worker effort inherits parent thinking level. Persist explicit explorer `inherit` so it overrides the `low` default; keep effort out of the public spawn schema.
- Keep the Unix socket side channel lazy and per-run authenticated. A registered `(owner, token)` pair authorizes only that owner; compare tokens in constant time and revoke them on every terminal path. The child connects lazily for nested `spawn`, owner-scoped `browser`, or `ownership` requests; `hello` authenticates only. The channel carries no result, question, message, or activity frames; disconnect alone never fails a run.
- Keep loadout-authoritative tool allowlists, nested-agent/depth checks, browser ownership, and fail-closed workflow policy unchanged. Side-channel frames remain capped at 256 KiB; socket directory and socket permissions remain `0700` and `0600`.
- Treat every supported RPC event as watchdog activity. Open tool-call IDs pause only idle timeout; max-total keeps running. Parent questions retain their existing behavior and pause both budgets.
- Keep live output in an 8 KiB per-run ring buffer and cap the stderr diagnostics log at 1 MiB. Prefix each complete stderr line once, buffer/flush partial lines without repeating prefixes, redact the token across chunks, and drop only the exact Pi missing-session warning for this child ID. Stop children by closing stdin, then escalate to `SIGTERM` after one second and `SIGKILL` 500 milliseconds later. Side-channel disconnect is not a run failure.

## Why

RPC mode provides a documented, line-oriented child control plane and removes the interactive cmux surface and custom lifecycle/result IPC. Pi events and commands already supply readiness, activity, UI requests, messages, and settled results. The separate authenticated socket remains necessary only for requests that must reach parent-owned browser state, nested-spawn authority, or ownership-lock management. Keeping those responsibilities separate avoids making an optional side channel the owner of run completion.

The upstream client does not meet this extension's process and UI requirements. A thin local client keeps `process.execPath`, bounded stderr, exit handling, extension-UI answers, command correlation, and deterministic stop escalation explicit. Direct LF framing avoids `readline` treating Unicode line separators inside JSON strings as record delimiters.

## Consequences

- Good: no cmux installation, surface lifecycle, hello handshake, or PATH-based Pi lookup is required.
- Good: parent remains lifecycle owner; results, questions, follow-ups, aborts, and final text use the documented RPC channel.
- Good: per-run token revocation and owner checks constrain the remaining side channel; a disconnect cannot turn into a false run failure.
- Good: RPC events support bounded diagnostics and idle activity tracking; open long-running tools do not trip idle timeout while max-total still bounds hangs.
- Bad/risk: the in-repo client must tolerate supported Pi protocol versions; record caps and classified failures limit, but do not remove, protocol-drift risk.
- Bad/risk: RPC stdout is reserved for protocol records; extension output must not be mixed into that stream. Browser and nested-spawn functionality still depends on the local authenticated socket.

## Affects

Docs:

- [ADR-0010-subagent-idle-timeout.md](ADR-0010-subagent-idle-timeout.md)
- [ADR-0034-async-out-of-process-subagents.md](ADR-0034-async-out-of-process-subagents.md)
- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [dev-workflow.md](../dev-workflow.md)
- [CHANGELOG.md](../../../CHANGELOG.md)
- [SUBAGENT-FOLLOWUPS.md](../../../SUBAGENT-FOLLOWUPS.md)
- [root README](../../../README.md)
- [decisions index](README.md) (generated)
- [worker-orchestration/SKILL.md](../../../agent/skills/worker-orchestration/SKILL.md)
- [manual-delegation-verification.md](../../../agent/extensions/workflow-modes/manual-delegation-verification.md)

Code:

- [rpc.ts](../../../agent/extensions/subagents/rpc.ts)
- [launch.ts](../../../agent/extensions/subagents/launch.ts)
- [child.ts](../../../agent/extensions/subagents/child.ts)
- [ipc.ts](../../../agent/extensions/subagents/ipc.ts)
- [timeout.ts](../../../agent/extensions/subagents/timeout.ts)
- [diagnostics.ts](../../../agent/extensions/subagents/diagnostics.ts)
- [progress.ts](../../../agent/extensions/subagents/progress.ts)
- [index.ts](../../../agent/extensions/subagents/index.ts)
- [subagents package.json](../../../agent/extensions/subagents/package.json)
- [root package.json](../../../package.json)
- [browser/index.ts](../../../agent/extensions/browser/index.ts)
- [test_rpc.ts](../../../agent/extensions/subagents/test/test_rpc.ts)
- [test_launch.ts](../../../agent/extensions/subagents/test/test_launch.ts)
- [test_ipc.ts](../../../agent/extensions/subagents/test/test_ipc.ts)
- [test_child.ts](../../../agent/extensions/subagents/test/test_child.ts)
- [test_timeout.ts](../../../agent/extensions/subagents/test/test_timeout.ts)
- [test_lifecycle.ts](../../../agent/extensions/subagents/test/test_lifecycle.ts)
- [fake-rpc-child.mjs](../../../agent/extensions/subagents/test/fixtures/fake-rpc-child.mjs)
- [smoke/fake-openai-server.mjs](../../../agent/extensions/subagents/test/smoke/fake-openai-server.mjs)
- [smoke/run-smoke.mjs](../../../agent/extensions/subagents/test/smoke/run-smoke.mjs)

## Read when

- changing RPC-mode subagent process launch, readiness, result delivery, or extension UI questions
- changing per-run IPC authentication, nested spawn, or browser proxy ownership
- changing subagent result/list delivery, live steering, role effort defaults, stderr diagnostics, event tails, termination, watchdog activity, or lifecycle cleanup

## Supersedes

- [ADR-0034-async-out-of-process-subagents.md](ADR-0034-async-out-of-process-subagents.md)
