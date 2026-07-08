# Pi Plan

Use this command when planning work in Cursor inside a Pi project.

1. Detect whether cwd or any ancestor contains `.pi/`. If not, use Cursor's normal planning behavior and do not call Pi bridge tools.
2. In a Pi project, call MCP tool `pi-claude-bridge.recall_memory` first with:
   - `query`: feature/topic plus target files/modules if known
   - `mode`: `plan`
   - `cwd`: current workspace/cwd if available
3. If recall fails, stop and say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
4. Read/investigate using read-only tools only. Do not create or edit files.
5. Adopt `prompts.planPrompt` from the recall result as authoritative mode behavior. Ignore Pi-only tools you do not have; keep the plan structure, capture, validation, and save steps below.
6. Final plan structure must use Pi sections:
   - Section 1 — Non-Functional Requirements
   - Section 2 — Success Metrics
   - Section 3 — Risks and Assumptions
   - Section 3.5 — Context Package
   - Section 4 — Tasks
   - Section 5 — Definition of Done
7. Section 4 tasks must be markdown checkboxes with Given/When/Then, NFRs, Verification Gate, and Checkpoint.
8. Docs tags: use specific `[DOCS:*]` tags when project truth changes. `[DOCS:decisions]` must include `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`. Never use bare `[DOCS]`.
9. Mandatory capture checkpoints: after each confirmed requirement, decision, constraint, open question, preference, or important implementation fact:
   - Say: `Recording this in Pi now.`
   - Call MCP tool `pi-claude-bridge.capture_note`.
   - Include `sessionId`: Cursor `conversation_id` when available.
   - If capture fails, stop.
10. Before finalizing plan, call MCP tool `pi-claude-bridge.validate_docs_tags` with full plan text. Fix invalid tags and validate again. Do not save invalid plans.
11. After presenting final plan, ask:
    > Save this plan to Pi build handoff?
12. Only after explicit user confirmation, call MCP tool `pi-claude-bridge.save_plan` with:
    - `planText`: final plan
    - `confirmed`: `true`
    - `planId`: short stable id if useful
13. If `save_plan` fails, stop. Do not claim handoff succeeded.
14. End with:
    > Switch to Pi `/mode build` to apply.
