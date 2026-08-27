---
name: write-adr
description: Write project ADRs with valid engineering-docs metadata and a fresh decision index row.
---

# Write ADR

Use this skill when a project decision belongs in `docs/engineering/decisions/`.

## First: test whether decision earns an ADR

All three must be true:

1. **Hard to reverse:** changing course later has meaningful cost.
2. **Surprising without context:** a future reader could reasonably ask why the code works this way.
3. **Real trade-off:** alternatives existed and one was selected for specific reasons.

If any answer is no, do not create an ADR.

## Procedure

1. Read `docs/engineering/README.md`, relevant engineering docs, and existing ADRs.
2. Scan `docs/engineering/decisions/` for the highest existing `ADR-NNNN` id. Use next sequential id. Never edit `ADR-template.md` or reuse an id.
3. Create `docs/engineering/decisions/ADR-NNNN-short-slug.md` only when needed. Keep directory creation lazy.
4. Start file with this frontmatter. Required fields are `id`, `title`, `status`, and `date`.

```markdown
---
id: ADR-NNNN
title: Short decision title
status: Proposed
date: YYYY-MM-DD
decision: One-sentence decision.
why: One-sentence reason and trade-off.
affects: path/to/file, docs/engineering/area.md
consequences: Main benefits and risks.
readWhen: changing the affected boundary or behavior
supersedes: None
---
```

Use only valid statuses: `Proposed`, `Active`, `Superseded`, or `Deprecated`. Use ISO date format. Keep `decision`, `why`, `affects`, `consequences`, `readWhen`, and `supersedes` concise; include exact repository-relative paths in `affects`. Omit `supersedes` only when project convention permits it. Do not add a space before `date`.

5. Write body sections matching project ADRs:
   - `## Decision` — chosen behavior and boundaries
   - `## Why` — rationale and rejected alternatives
   - `## Affects` — `Docs:` and `Code:` lists with exact paths
   - `## Consequences` — `Good:` benefits and `Bad/risk:` trade-offs
   - `## Read when` — maintenance triggers
   - `## Supersedes` — prior ADR or `None`
6. Validate required metadata, status, id format, body claims, and every `affects` path before indexing.
7. Update `docs/engineering/decisions/README.md` by appending the generated row in ADR id order. Match generator output exactly:

```markdown
| ADR-NNNN | Proposed | Short decision title | changing the affected boundary or behavior |
```

The index header is:

```markdown
# Decisions

| ADR | Status | Summary | Read when |
|---|---|---|---|
```

The row uses frontmatter `id`, `status`, `title`, and `readWhen` verbatim. Keep rows sorted by id. Do not add filename links, extra columns, or prose. Later decision-index regeneration must produce no diff.
8. Run the repository's engineering-docs validation and decision-index regeneration/check if available. Inspect `git diff --check` and confirm only intended files changed.

## Minimalism

Do not create an ADR for reversible, obvious, or non-trade-off changes. Do not invent metadata or paths. Record rejected alternatives only when their rejection prevents a likely future mistake.
