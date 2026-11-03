---
name: pi-plan
description: Pi Plan workflow for Codex. Use ONLY when the user explicitly invokes $pi-plan; never trigger implicitly.
---

# $pi-plan — Codex Pi Plan

Use this skill to plan work with Pi when the project is a Pi project.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`. Pi's global agent dir `~/.pi` does not mark a project.

- Outside a Pi project: use the non-Pi fallback below; do not call Pi bridge tools.
- Inside a Pi project: use the bridge workflow below.

## Codex bridge calls

Pi bridge tools are on the `pi-claude-bridge` MCP server. The Pi Codex hook injects `sessionId` and `harness` from Codex's host session; never supply a session ID or `claudeSessionId`. Pass `harness: "codex"` or omit it. Pass `cwd` only when you know the current project path.

Codex reads files through shell. Without a Build lease the Pi hook allows only provably read-only commands (`rg`, `cat`, `head`, `tail`, `ls`, `find`, `wc`, `git status|log|show|diff|blame`, simple pipes). Avoid `$(...)`, backticks, redirects, and unquoted globs; quote patterns instead.

## Pi-project planning

1. Call `recall_memory` with:
   - `query`: the feature/topic plus known target files/modules
   - `mode`: `plan`
2. If the bridge call fails or returns `ok: false`, stop and quote the exact refusal. If unavailable, say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
3. Read and investigate using read-only tools. Do not create or edit files. Adopt returned `prompts.planPrompt` as authoritative planning behavior, including its ponytail reflex; ignore tools it names that you do not have.
4. Ask product questions with Codex's question tool (`request_user_input`, or `request_user_input_async` in the desktop app) when available; otherwise say no question tool exists, then ask in prose.
5. Use Pi's plan structure:
   - Section 1 — Non-Functional Requirements
   - Section 2 — Success Metrics
   - Section 3 — Risks and Assumptions
   - Section 3.5 — Context Package
   - Section 4 — Tasks
   - Section 5 — Definition of Done
6. Section 4 tasks must be Markdown checkboxes with Given/When/Then, NFRs, Verification Gate, and Checkpoint. Add specific `[DOCS:*]` tags when project truth changes; `[DOCS:decisions]` also needs `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`. Never use bare `[DOCS]`.
7. After each confirmed requirement, decision, constraint, open question, preference, or important implementation fact, say `Recording this in Pi now.` and call `capture_note` with typed notes and `context`. Types: `requirement`, `decision`, `constraint`, `action`, `question`, `preference`, `implementation`, `lesson`. If capture fails, stop.
8. Before finalizing, call `validate_docs_tags` with the full plan. Fix invalid tags and validate again; do not save an invalid plan.
9. Present the complete plan, then ask: `Save this plan to Pi build handoff?`
10. Only after explicit user confirmation, call `save_plan` with the complete `planText`, `confirmed: true`, and a short stable `planId` if useful. Do not supply path, timestamps, or task state. If saving fails, stop; do not claim handoff succeeded.
11. End with: `Switch to Pi /mode build to apply, or run $pi-build here.`

Do not run `$pi-plan` while this Codex session holds a Pi Build lease: a Plan recall releases the lease.

## Non-Pi planning fallback

1. Ask which feature to plan.
2. Look for `specs/shadow/[FeatureName].shadow.md`.
3. If no shadow spec exists, stop and tell the user to write a spec first.
4. Read the shadow spec and `specs/FEATURES.md`.
5. Generate a plan using Sections 1–5.
