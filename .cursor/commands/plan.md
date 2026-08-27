# Plan

Use this command to produce an implementation-ready plan. Do not edit source files while planning.

## Workflow

1. Read canonical engineering docs and all files needed to understand current behavior.
2. Separate verified evidence from assumptions. Do not invent paths, interfaces, tests, or commands.
3. Inventory exact target files. Create no files merely because a directory is absent.
4. Make each task atomic and ordered. A task may create only files it names.
5. For documentation, create only the specific document required by a task; do not create an entire documentation tree as setup.
6. Include one verification gate and one commit boundary per task.
7. Before presenting the plan, check every docs tag and confirm each tagged task has a concrete documentation target.

## Required output

### Evidence

List verified facts with source paths and line references where useful. Call out unknowns separately.

### Target files

List every file to inspect or change. Use exact repository-relative paths. Mark generated files and source inputs.

### Tasks

Use this format for every task:

- [ ] Task description
  - **Given** preconditions and verified facts
  - **When** implementation action occurs
  - **Then** observable result
  - **NFRs:** task-specific security, reliability, accessibility, portability, or performance constraints
  - **Verification Gate:** runnable checks plus manual behavior to confirm
  - **Checkpoint:** Commit before starting the next task — do not batch commits across tasks

### Docs tag reference

| Tag | Use when |
|---|---|
| `[DOCS:architecture]` | System shape, component boundaries, data flow changed |
| `[DOCS:dev-workflow]` | Setup, env, commands, build/test/deploy steps changed |
| `[DOCS:conventions]` | Naming, style, patterns, coding rules changed |
| `[DOCS:invariants]` | Must-not-break rules added or changed |
| `[DOCS:traps]` | New gotchas, failure modes, or known issues discovered |
| `[DOCS:decisions]` | High-impact decision recorded as ADR |

A `[DOCS:decisions]` task must also include `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`. Never use bare `[DOCS]`.

### Definition of done

- [ ] Every task has Given / When / Then, NFRs, verification, and checkpoint.
- [ ] Every target path exists or is created by a named task.
- [ ] Each task is verified and committed before the next task starts.
- [ ] Generated outputs are regenerated from canonical inputs.
- [ ] No unresolved blocker is hidden in the plan.
