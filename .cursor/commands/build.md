# Build

Use this command to execute an approved plan one task at a time.

## Execution loop

1. Read current task block, its Evidence, Target files, Given / When / Then, NFRs, and Verification Gate.
2. Load every named context file before editing. If a path is missing, stop and report it.
3. Change only files owned by current task. Prefer existing code, standard library, and smallest working change.
4. Run task Verification Gate first when possible, then targeted checks for changed files.
5. If any check fails, stop. Report failure, changed files, logs, and next action. Do not commit or start another task.
6. On success, inspect diff and status, run `git diff --check`, then make task-specific commit.
7. Confirm commit exists before starting next task. Never batch tasks or edit plan checkboxes to claim progress.
8. If project truth changes, update canonical engineering docs in same task or add a docs task before proceeding.
9. At end of each task report:
   - Task completed
   - Commit
   - Verification
   - Deviations
   - Next task

## Safety

Keep input validation, error handling, security, accessibility, and data-loss protections intact. Do not broaden scope to hide failing checks. Preserve generated-file boundaries and regenerate generated outputs from their canonical inputs.

Do not claim manual behavior was verified without observing it. If required verification needs unavailable tooling or interaction, stop at that checkpoint and state exactly what remains.
