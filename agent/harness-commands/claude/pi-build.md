# /pi-build — Pi Build

Use this command to run an approved Pi saved plan through Claude Code's Pi build lease.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`. Pi's global agent dir `~/.pi` does not mark a project.

- Outside a Pi project: do not call Pi bridge tools. Use the generic build loop below.
- Inside a Pi project: use the Pi branch only.

## Pi branch

1. Call MCP tool `mcp__pi-claude-bridge__recall_memory` with:
   - `query`: the user's goal plus known feature/module words
   - `mode`: `build`
   - `cwd`: current working directory when available

   Do not invent or pass a model-supplied session ID. Let the configured bridge client use Claude's host-provided session identity.
2. If recall fails, returns `ok: false`, or omits `prompts.buildPrompt`, stop before editing or running shell commands. Quote the exact refusal message; do not retry by changing identity or bypassing the lease.
3. Treat the returned `prompts.buildPrompt` as authoritative Build behavior. Use the returned `savedPlan` and active workflow tracker; never edit the saved plan file or its checkboxes.
4. Map Pi-only workflow tools to bridge tools:
   - `workflow_plan_tasks` → `mcp__pi-claude-bridge__read_plan_tasks`
   - `workflow_plan_tick` → `mcp__pi-claude-bridge__tick_plan_task`
   Recover tracker state only when missing or after compaction. Work exactly one next task at a time.
5. Load that task's context package, implement only its scope, then run its Verification Gate and targeted checks. On failure, stop without committing or ticking.
6. On success, inspect the diff and commit the task before calling `tick_plan_task` once for that completed task. Never tick before commit or edit the saved plan to mark progress.
7. Report the task, commit, verification, deviations, and next tracker task. Stop for user confirmation before advancing.

## Build lease refusals

On any refusal below, stop before editing or running shell commands. Never retry in a loop, poll, change identity, or bypass the lease.

- `build_lease_pending`: quote the exact message, including its short id, then tell the user to approve that id in Pi with `/build-lease approve` and rerun `/pi-build`.
- `build_lease_no_approval`: stop and explain that a Build lease can only be approved in interactive Pi; headless Pi cannot approve.
- `build_lease_required` from `tick_plan_task`: stop and ask the user to re-approve the Build lease in interactive Pi with `/build-lease approve`, then rerun `/pi-build`.

## Generic build loop outside Pi

Clarify unclear requirements; inspect relevant code; make the smallest requested change; run relevant checks. For an approved plan, read the current task and context and execute one task at a time. If any check fails, stop and report without committing. On success, inspect the diff and status, run `git diff --check`, make a task-specific commit, then report changes and verification. Do not use Pi bridge tools.
