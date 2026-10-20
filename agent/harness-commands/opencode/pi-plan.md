# /pi-plan — OpenCode Pi Plan

Use this command to plan work with Pi when the project is a Pi project.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`.

- Outside a Pi project: use the non-Pi fallback below; do not call Pi bridge tools.
- Inside a Pi project: use the bridge workflow below.

## OpenCode Code Mode bridge calls

MCP tools are exposed through Code Mode `execute`. Before each bridge call, run synchronous `search({ query: "<tool name>", namespace: "pi-claude-bridge" })`, then call the exact path returned. Do not await `search` or call a bridge MCP tool directly. Example path: `tools["pi-claude-bridge"].recall_memory(...)`.

The plugin overwrites `sessionId` and `harness` from OpenCode's host `sessionID`. Never supply a model-invented session ID or `claudeSessionId`; use `harness: "opencode"` for bridge calls. Pass `cwd` only when OpenCode explicitly provides the current project path; otherwise rely on the configured MCP server cwd.

## Pi-project planning

1. Call `recall_memory` with:
   - `query`: the feature/topic plus known target files/modules
   - `mode`: `plan`
   - `harness`: `"opencode"`
2. If the bridge call fails or returns `ok: false`, stop and quote the exact refusal. If unavailable, say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
3. Read and investigate using read-only tools. Do not create or edit files. Adopt returned `prompts.planPrompt` as authoritative planning behavior.
4. Use Pi's plan structure:
   - Section 1 — Non-Functional Requirements
   - Section 2 — Success Metrics
   - Section 3 — Risks and Assumptions
   - Section 3.5 — Context Package
   - Section 4 — Tasks
   - Section 5 — Definition of Done
5. Section 4 tasks must be Markdown checkboxes with Given/When/Then, NFRs, Verification Gate, and Checkpoint. Add specific `[DOCS:*]` tags when project truth changes; `[DOCS:decisions]` also needs `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`. Never use bare `[DOCS]`.
6. After each confirmed requirement, decision, constraint, open question, preference, or important implementation fact, say `Recording this in Pi now.` and call `capture_note` through Code Mode with typed notes, `context`, and `harness: "opencode"`. Types: `requirement`, `decision`, `constraint`, `action`, `question`, `preference`, `implementation`, `lesson`. If capture fails, stop.
7. Before finalizing, call `validate_docs_tags` with the full plan. Fix invalid tags and validate again; do not save an invalid plan.
8. Present the complete plan, then ask: `Save this plan to Pi build handoff?`
9. Only after explicit user confirmation, call `save_plan` with the complete `planText`, `confirmed: true`, and a short stable `planId` if useful. Do not supply path, timestamps, or task state. If saving fails, stop; do not claim handoff succeeded.
10. End with: `Switch to Pi /mode build to apply.`

## Non-Pi planning fallback

1. Ask which feature to plan.
2. Look for `specs/shadow/[FeatureName].shadow.md`.
3. If no shadow spec exists, stop and tell the user to run `/spec` first.
4. Read the shadow spec and `specs/FEATURES.md`.
5. Generate a plan using Sections 1–5.
6. In non-Pi projects only, legacy behavior may write `docs/prompts/[NN]_[feature-name-kebab].md` if the user expects it.
7. Do not use Pi bridge tools.
