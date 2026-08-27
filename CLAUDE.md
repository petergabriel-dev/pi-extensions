<!-- pi-docs:start (generated — edit docs/engineering/, not this block) -->
# Project knowledge
Before writing code, read:
- docs/engineering/invariants.md — rules that must not break
- docs/engineering/conventions.md — how this codebase is written
Full docs (architecture, ADRs, traps): docs/engineering/
<!-- pi-docs:end -->

<!-- HAND-WRITTEN: keep this section outside pi-docs markers. -->
## Write-back discipline (hand-written, not generated)

Project truth lives in canonical `docs/engineering/` docs. When implementation changes behavior, architecture, workflow, invariants, traps, or decisions:

- Update the smallest relevant canonical engineering doc.
- Add a specific docs tag to the plan task. Never use bare `[DOCS]`.
- A `[DOCS:decisions]` task must include `[ADR:new]`, `[ADR:update]`, or `[ADR:supersede]`.
- Keep generated spoke and index content generated; regenerate after changing canonical inputs.

| Tag | Use when |
|---|---|
| `[DOCS:architecture]` | System shape, component boundaries, data flow changed |
| `[DOCS:dev-workflow]` | Setup, env, commands, build/test/deploy steps changed |
| `[DOCS:conventions]` | Naming, style, patterns, coding rules changed |
| `[DOCS:invariants]` | Must-not-break rules added or changed |
| `[DOCS:traps]` | New gotchas, failure modes, or known issues discovered |
| `[DOCS:decisions]` | High-impact decision recorded as ADR |
| `[ADR:new]` | New architectural decision |
| `[ADR:update]` | Revise existing ADR |
| `[ADR:supersede]` | Supersede previous ADR |
