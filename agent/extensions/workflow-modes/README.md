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
