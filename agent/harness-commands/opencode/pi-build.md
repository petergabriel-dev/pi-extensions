# /pi-build — OpenCode Pi Build

Use this command to run an approved Pi saved plan through OpenCode's Pi build lease.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`.

- Outside a Pi project: do not call Pi bridge tools. Use the generic build loop below.
- Inside a Pi project: use the Pi branch only.

## OpenCode Code Mode bridge calls

OpenCode exposes bridge MCP tools through Code Mode `execute`. Before each bridge call, run synchronous `search({ query: "<tool name>", namespace: "pi-claude-bridge" })`, then call the exact path returned. Do not await `search` or call a bridge MCP tool directly. For example:

```js
const found = search({ query: "recall_memory", namespace: "pi-claude-bridge" });
if (!found.items.some((item) => item.path === 'tools["pi-claude-bridge"].recall_memory')) {
  throw new Error("Pi bridge recall tool is unavailable.");
}
return await tools["pi-claude-bridge"].recall_memory({
  query: "Build the user's goal using the active saved Pi plan.",
  mode: "build",
  harness: "opencode",
});
```

The plugin overwrites `sessionId` and `harness` from OpenCode's host `sessionID`. Never supply a model-invented session ID or `claudeSessionId`. Pass `cwd` only when OpenCode explicitly provides the current project path; otherwise rely on the configured MCP server cwd.

## Pi branch

1. Run the bridge recall above with the user's goal and known feature/module words.
2. If recall fails, returns `ok: false`, or omits `prompts.buildPrompt`, stop before editing or running shell commands. Quote the exact refusal; do not retry with another identity or bypass the lease.
3. Treat returned `prompts.buildPrompt` as authoritative Build behavior. Use returned `savedPlan` and active tracker; never edit the saved plan file or its checkboxes.
4. Map Pi-only workflow tools to bridge tools, using Code Mode search before each call:
   - `workflow_plan_tasks` → `read_plan_tasks`
   - `workflow_plan_tick` → `tick_plan_task`
   Recover tracker state only when missing or after compaction. Work exactly one next task at a time.
5. Load that task's context package, implement only its scope, then run its Verification Gate and targeted checks. If a check fails, stop without committing or ticking.
6. On success, inspect the diff and commit the task before calling `tick_plan_task` once. Never tick before commit or edit the saved plan to mark progress.
7. Report task, commit, verification, deviations, and next tracker task. Stop for user confirmation before advancing.

## Generic build loop outside Pi

Clarify unclear requirements; inspect relevant code; make the smallest requested change; run relevant checks. For an approved plan, read the current task and context and execute one task at a time. If any check fails, stop and report without committing. On success, inspect the diff and status, run `git diff --check`, make a task-specific commit, then report changes and verification. Do not call Pi bridge tools.
