# Workflow: Task Planning

## Pi-project branch (preferred)

First, detect whether cwd or any ancestor contains `.pi/`.

If this is a Pi project:

1. **Use Pi bridge recall first.** Call MCP tool `mcp__pi-claude-bridge__recall_memory` with:
   - `query`: feature/topic plus target files/modules if known
   - `mode`: `plan`
   - `cwd`: current cwd if available

2. If bridge recall fails, stop. Say exactly:
   > Pi bridge not responding; start/focus Pi in this project.

3. Read/investigate using read-only tools only. Do not create or edit files. Claude Code is planning surface; Pi build owns writes.

3.5 Adopt Pi's plan behavior from the bridge: the recall_memory result includes prompts.planPrompt. Treat that string as authoritative mode behavior, including its ponytail lazy-senior-dev reflex. Ignore tools you do not have; keep the plan structure, capture, validation, and save steps below.

4. Plan structure must follow Pi plan template:
   - Section 1 — Non-Functional Requirements
   - Section 2 — Success Metrics
   - Section 3 — Risks and Assumptions
   - Section 3.5 — Context Package
   - Section 4 — Tasks
   - Section 5 — Definition of Done

5. Section 4 tasks must be markdown checkboxes:

```markdown
- [ ] Task description (Use Skill: [skill])
  - **Given** [precondition] **When** [action] **Then** [expected outcome]
  - **NFRs:** [task-specific constraints, or "See Section 1"]
  - **Verification Gate:** [what must be confirmed before next task]
  - **Checkpoint:** Commit before starting next task — do not batch commits across tasks
```

6. Docs tags:
   - Use `[DOCS:architecture]`, `[DOCS:dev-workflow]`, `[DOCS:conventions]`, `[DOCS:invariants]`, `[DOCS:traps]`, `[DOCS:decisions]` when project truth changes.
   - `[DOCS:decisions]` must also have `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`.
   - Never use bare `[DOCS]`.

7. **Explicit capture checkpoints are mandatory.** After each confirmed requirement, decision, constraint, open question, preference, or important implementation fact:
   - Say: `Recording this in Pi now.`
   - Call MCP tool `mcp__pi-claude-bridge__capture_note`.
   - If capture fails, stop.

8. Before finalizing plan:
   - Call MCP tool `mcp__pi-claude-bridge__validate_docs_tags` with full plan text.
   - If invalid tags are returned, fix plan and validate again.
   - Do not save invalid plan.

9. After presenting final plan, ask user:
   > Save this plan to Pi build handoff?

10. Only if user explicitly confirms, call MCP tool `mcp__pi-claude-bridge__save_plan` with:
   - `planText`: final plan
   - `confirmed`: `true`
   - `planId`: short stable id if useful

11. If `save_plan` fails, stop. Do not claim handoff succeeded.

12. End with:
   > Switch to Pi `/mode build` to apply.

**Unsupported model caveat:** These are behavioral wrapper instructions, not hard enforcement. If model skips capture/validation/save checkpoints, workflow fails acceptance; user should switch model or explicitly force tool calls.

## Non-Pi fallback branch

If no `.pi/` ancestor exists, preserve previous generic planning behavior:

1. Ask which feature to plan.
2. Look for `specs/shadow/[FeatureName].shadow.md`.
3. If no shadow spec exists, stop and tell user to run `/spec` first.
4. Read shadow spec and `specs/FEATURES.md`.
5. Generate plan using Sections 1–5.
6. In non-Pi projects only, legacy behavior may write `docs/prompts/[NN]_[feature-name-kebab].md` if user expects it.
7. Do not use Pi bridge tools.
