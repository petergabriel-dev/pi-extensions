# Pi Workflow Modes

`/mode` selects branch-local workflow behavior.

| Mode | Purpose | Writes |
|---|---|---|
| Off | Normal Pi behavior | allowed |
| Discuss | Shape ideas | blocked |
| Plan | Investigate and plan | blocked |
| Build | Implement saved specs | allowed |
| Review | Read-only review | blocked |

## Saved plans and task progress

`/plan` stores plan bodies outside the repository at `<agentDir>/plans/<sessionId>/<planId>.md`. The selected session branch stores only plan pointer/activation/clear entries and task-tick entries. Plan files are bounded, written atomically, reread before each active-mode turn, and treated as immutable specs during Build. Plan owns frontend taste and contract-level component specs; it remains read-only and browser-blind.

- `/plan save` creates and activates a new plan; it seeds tasks from top-level unchecked Section 4 items.
- `/plan select <planId>` activates an ancestry-visible plan; `/plan view` lists plans and progress; `/plan clear` deactivates the active plan without deleting its body.
- `workflow_plan_tick` completes one seeded task by durable branch entry. Its optional note is trimmed and validated to 1–500 characters; first note persists on idempotent re-ticks. Tracker progress is the Build queue; Section 4 checkboxes are seed syntax only.
- The per-turn marker carries plan id, path, savedAt, progress counts, and next task—not the full task list.
- Bridge `save_plan`, `read_plan_tasks`, and `tick_plan_task` route through this owner. Bridge clients never read plan files directly.

## Frontend planning and implementation

Use Plan → Build. Plan decides taste and freezes contract-level component specs without file writes or browser use; schedule design docs and token tasks before component work. Build implements the saved spec literally and asks to resolve missing or contradictory specs in Plan. `docs/design/**` and validated manifest `tokenFiles` are writable only in Build/Off. Optional `docs/design/reference/` snapshots enter Plan/Build context only when present and remain untrusted visual data; canonical specs and tokens win.

Build verifies each frontend task with reviewed screenshots for every spec viewport and required state, checks them against the spec and `web-design-guidelines`, and allows at most three fix/review passes. Pi uses native `browser_*` tools and respects `/browser on`; other harnesses use `playwright-cli` after a manual install. Missing CLI/browser means an honest `unverified:` tick note, never a claimed pass. Selecting `design` reports an unknown mode; restored legacy `design` state fails closed.

## Mode announcement channel

For Discuss, Plan, Build, and Review, `before_agent_start` returns both the composed system prompt and a hidden `workflow-mode-current` custom message on every user turn:

```text
[workflow-modes] Active workflow mode: Build.
```

The message is sent to the model but hidden from the TUI transcript. Regenerating it each turn repairs stale mode beliefs after compaction, branch navigation, and session resume.

Each active-mode system prompt opens with an authoritative header. It says the current header supersedes every earlier mode statement, including assistant claims and tool-result guidance; the agent must not request a switch to the mode already named and must attempt a believed-blocked tool once before refusing.

Off injects no per-turn workflow prompt or message. `/mode off` first persists `workflow-mode-set`, then sends one hidden `workflow-mode-transition` message naming Off. Active-mode switches rely on the next per-turn message and are not double-announced. If the Off message fails, the prior mode is restored and the error is surfaced.

## Tool results

Sandboxed Bash commands pass through with native output and exit status; workflow-modes adds no failure guidance. Block reasons describe the mode at tool-call time in past tense and direct the model to the latest `[workflow-modes]` line for current state.
