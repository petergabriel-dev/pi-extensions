# Structured Plan Template

When the user confirms the approach and asks you to produce the final plan, follow this structure exactly. Output the plan in the conversation — do not write it to a file.

---

## Section 1 — Non-Functional Requirements

List the quality constraints that apply across all tasks for this feature. Cover:

- **Performance:** Response time targets, throughput expectations
- **Security:** Auth requirements, data validation, sensitive data handling
- **Reliability:** Error handling expectations, retry behavior, uptime requirements
- **Scalability:** Load assumptions, concurrency constraints
- **Usability:** Accessibility standards, loading state expectations

Be specific and measurable — replace vague terms like "fast" or "secure" with quantifiable targets.

---

## Section 2 — Success Metrics

How success will be measured after implementation:

- **Functional:** Feature works end-to-end without errors
- **Performance:** NFR benchmarks met under expected load
- **Quality:** Test coverage targets (e.g., 100% pass rate on critical paths)
- **Business:** User-facing outcomes tied to the feature

---

## Section 3 — Risks and Assumptions

Surface unknowns before coding begins. Group under **Assumptions** and **Risks** subheadings. For each, include the mitigation or validation approach.

---

## Section 3.5 — Context Package

Files, schemas, and existing code that must be loaded into context before starting each task cluster:

- **Database tasks:** Relevant migration files, current schema, query files
- **Backend tasks:** Existing service interfaces, handler signatures, middleware
- **Frontend tasks:** Existing component tree, API client types, relevant hooks
- **All tasks:** Any third-party API contracts, relevant config files

Do not begin a task without confirming this context is present.

---

## Section 4 — Tasks

Unchecked top-level task checkboxes seed workflow task tracker when plan is saved. Build progress lives in session branch tick entries; do not edit plan checkboxes to record progress. Keep tasks atomic, implementation-ready, ordered by implementation sequence:

1. Database migrations
2. Backend service and handler
3. Frontend components and API integration
4. Tests

### Task Format

```
- [ ] Task description (Use Skill: [skill])
  - **Given** [precondition] **When** [action] **Then** [expected outcome]
  - **NFRs:** [task-specific constraints, or "See Section 1"]
  - **Verification Gate:** [what must be manually confirmed before proceeding to the next task]
  - **Checkpoint:** Commit before starting the next task — do not batch commits across tasks
```

### Skill Tags

Before writing tasks, discover available skills by searching the project for `SKILL.md` files and reading relevant ones. Tag each task with the applicable skill name if one exists. Omit the tag if no relevant skill is found.

### Docs Task Tags

When implementation changes project truth (behavior, architecture, setup, conventions, invariants, known traps, or high-impact decisions), the plan must include a docs task. Tag docs tasks with the area they affect:

| Tag | Use when |
|---|---|
| `[DOCS:architecture]` | System shape, component boundaries, data flow changed |
| `[DOCS:dev-workflow]` | Setup, env, commands, build/test/deploy steps changed |
| `[DOCS:conventions]` | Naming, style, patterns, coding rules changed |
| `[DOCS:invariants]` | Must-not-break rules added or changed |
| `[DOCS:traps]` | New gotchas, pitfalls, or known issues discovered |
| `[DOCS:decisions]` | High-impact decision recorded as ADR |

A `[DOCS:decisions]` task must also include one of:

- `[ADR:new]` — new architectural decision
- `[ADR:update]` — revise an existing ADR
- `[ADR:supersede]` — supersede a previous ADR

Example docs tasks:

```
- [ ] [DOCS:architecture][DOCS:traps] Update engineering docs for auth flow
  - **Given** auth behavior is verified **When** docs are updated **Then** architecture and traps reflect current auth flow
  - **NFRs:** Concise, evidence-backed, human-readable
  - **Verification Gate:** `docs/engineering/architecture.md` and `traps.md` mention only verified behavior
  - **Checkpoint:** Commit before next task

- [ ] [DOCS:decisions][ADR:new] Record session-cookie auth decision
  - **Given** auth model decided **When** ADR is written **Then** `docs/engineering/decisions/` has ADR file with metadata and index is regenerated
  - **NFRs:** Concise rationale, exact docs/code refs in Affects, decision index regenerated
  - **Verification Gate:** ADR file created; `docs/engineering/decisions/README.md` regenerated
  - **Checkpoint:** Commit before next task
```

Omit `[DOCS:*]` tags only when no project truth changes. A `[DOCS]` tag without a specific area is invalid — always specify the area.

---

## Section 5 — Definition of Done

A checklist that must be fully checked before the feature is considered complete:

- [ ] All tasks above are implemented and committed
- [ ] Each task was verified and committed before the next began — no batch commits
- [ ] Verification gate passed for every task before proceeding
- [ ] No [LOAD-BEARING] task was skipped or deferred
- [ ] Plan mode used for any task marked [LOAD-BEARING]
- [ ] Acceptance criteria pass for every task
- [ ] All `[DOCS:*]` and `[ADR:*]` tasks from Section 4 are implemented
- [ ] NFR benchmarks verified (manually or via test)
- [ ] No critical or high-severity bugs open
- [ ] Peer code review completed
- [ ] CI/CD pipeline passing (build, lint, tests)

---

Do not append extra commentary after the plan. The plan is complete when Section 5 is finished.
