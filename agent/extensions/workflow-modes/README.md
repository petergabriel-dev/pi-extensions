# Pi Workflow Modes

`/mode` selects branch-local workflow behavior.

| Mode | Purpose | Writes |
|---|---|---|
| Discuss | Shape ideas | blocked |
| Plan | Investigate and plan | blocked |
| Review | Read-only review | blocked |
| Design | Tokens and design specs | `docs/design/**` plus declared token CSS |
| Build | Implementation | allowed |
| Off | Normal Pi behavior | allowed |

Design mode composes with Caveman. Use `/mode design` for token layers, component specs, and previews; use `/mode build` for component source. Design writes fail closed outside `docs/design/**` and manifest-declared token files. Design Bash uses Plan read/test policy and sandbox wrapping.

## Mode announcement channel

For Discuss, Plan, Review, Design, and Build, `before_agent_start` returns both the composed system prompt and a hidden `workflow-mode-current` custom message on every user turn:

```text
[workflow-modes] Active workflow mode: Build.
```

The message is sent to the model but hidden from the TUI transcript. Regenerating it each turn repairs stale mode beliefs after compaction, branch navigation, and session resume.

Each active-mode system prompt opens with an authoritative header. It says the current header supersedes every earlier mode statement, including assistant claims and tool-result guidance; the agent must not request a switch to the mode already named and must attempt a believed-blocked tool once before refusing.

Off injects no per-turn workflow prompt or message. `/mode off` first persists `workflow-mode-set`, then sends one hidden `workflow-mode-transition` message naming Off. Active-mode switches rely on the next per-turn message and are not double-announced. If the Off message fails, the prior mode is restored and the error is surfaced.

## Tool results

Sandboxed Bash commands pass through with native output and exit status; workflow-modes adds no failure guidance. Block reasons describe the mode at tool-call time in past tense and direct the model to the latest `[workflow-modes]` line for current state.
