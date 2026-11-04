---
name: pi-build
description: Pi Build workflow for Codex under a Pi-approved Build lease. Use ONLY when the user explicitly invokes $pi-build; never trigger implicitly.
---

# $pi-build — Codex Pi Build

Use this skill to run an approved Pi saved plan through Codex's Pi Build lease.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`. Pi's global agent dir `~/.pi` does not mark a project. Detect it with plain commands only (`ls -a`, `ls -a ..`, `ls -a ../..`, and so on); never use `$(...)`, backticks, or loops, because the Pi hook blocks dynamic shell in a Pi project until you hold a Build lease.

- Outside a Pi project: do not call Pi bridge tools. Use the generic build loop below.
- Inside a Pi project: use the Pi branch only.

## Codex bridge calls

Pi bridge tools are on the `pi-claude-bridge` MCP server. The Pi Codex hook injects `sessionId` and `harness` from Codex's host session, and the lease is bound to that session; never supply a session ID or `claudeSessionId`, and never try another identity. Pass `harness: "codex"` or omit it.

Codex reads files through shell. Without a Build lease the Pi hook allows only provably read-only commands (`rg`, `cat`, `head`, `tail`, `ls`, `find`, `wc`, `git status|log|show|diff|blame`, simple pipes). Avoid `$(...)`, backticks, redirects, and unquoted globs; quote patterns instead. With the lease, shell and `apply_patch` are unrestricted.

## Pi branch

1. Call `recall_memory` with:
   - `query`: the user's goal plus known feature/module words
   - `mode`: `build`
2. If recall fails, returns `ok: false`, or omits `prompts.buildPrompt`, stop before editing or running shell commands. Quote the exact refusal; do not retry with another identity or bypass the lease.
3. Treat returned `prompts.buildPrompt` as authoritative Build behavior. Use returned `savedPlan` and the active tracker; never edit the saved plan file or its checkboxes. Ask confirmations with Codex's question tool (`request_user_input`, or `request_user_input_async` in the desktop app) when available; otherwise ask in prose.
4. Map Pi-only workflow tools to bridge tools:
   - `workflow_plan_tasks` → `read_plan_tasks`
   - `workflow_plan_tick` → `tick_plan_task`
   Recover tracker state only when missing or after compaction. Work exactly one next task at a time.
5. Load that task's context package, implement only its scope, then run its Verification Gate and targeted checks. If a check fails, stop without committing or ticking.
6. On success, inspect the diff and commit the task before calling `tick_plan_task` once. Never tick before commit or edit the saved plan to mark progress. Completing the last task releases the lease, so commit first.
7. Report task, commit, verification, deviations, and next tracker task. Stop for user confirmation before advancing.

While holding the lease, do not run `$pi-discuss` or `$pi-plan`: a Discuss or Plan recall releases the lease.

## Build lease refusals

On any refusal below, stop before editing or running shell commands. Never retry in a loop, poll, change identity, or bypass the lease.

- `build_lease_pending`: quote the exact message, including its short id, then tell the user to approve that id in Pi with `/build-lease approve` and rerun `$pi-build`.
- `build_lease_no_approval`: stop and explain that a Build lease can only be approved in interactive Pi; headless Pi cannot approve.
- `build_lease_required` from `tick_plan_task`: stop and ask the user to re-approve the Build lease in interactive Pi with `/build-lease approve`, then rerun `$pi-build`.
- `build_lease_held`: another holder or Pi session holds the project writer, or this Pi session's bridge presence is stale. Quote the exact message, stop, and ask the user to resolve what it names, then rerun `$pi-build`.

## Generic build loop outside Pi

Clarify unclear requirements; inspect relevant code; make the smallest requested change; run relevant checks. For an approved plan, read the current task and context and execute one task at a time. If any check fails, stop and report without committing. On success, inspect the diff and status, run `git diff --check`, make a task-specific commit, then report changes and verification. Do not call Pi bridge tools.
