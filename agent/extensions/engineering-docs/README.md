# Pi Engineering Docs Extension

Managed engineering documentation for projects using Pi.

## Overview

This extension creates and maintains `docs/engineering/` as a project knowledge layer. It provides:

- **Init** — scaffold managed engineering docs
- **Check** — validate docs status, ADR metadata, decision index, and root spokes
- **Status** — view docs state, workflow mode, and spoke health
- **Decision index** — auto-generated ADR catalog
- **Root spokes** — generated `AGENTS.md` and `CLAUDE.md` pointers to canonical docs
- **Patch suggestions** — detect code changes that may need docs updates
- **Workflow-mode gates** — block docs writes in Discuss/Plan mode
- **Tag validation** — validate `[DOCS:*]` and `[ADR:*]` task tags

## Commands

### `/docs` — Dashboard

Opens an interactive dashboard showing:

- Docs status (managed / unmanaged / missing)
- Current workflow mode and write permissions
- ADR count and index freshness
- Root spoke health for `AGENTS.md` and `CLAUDE.md`
- Available actions

### `/docs init [--yes] [--check]`

Create `docs/engineering/` skeleton with manifest and root spokes (`AGENTS.md`, `CLAUDE.md`).

| Flag | Behavior |
|------|----------|
| (none) | Interactive: inspect, report, ask before changes |
| `--yes` | Non-interactive: create missing files, never overwrite existing |
| `--check` | Validation only: no writes, exit nonzero if broken |

Existing curated files are never overwritten. Root spokes use a managed marker block, preserving all content outside that block.

### `/docs check`

Validate docs status, ADR metadata, and tag rules. Reports:

- Managed / unmanaged / missing status
- Missing doc files
- ADR validation errors
- Decision index freshness
- Root spoke missing/stale blocks and dead doc links
- Docs tag issues (if plan text given)

In Build/Off mode, `/docs check` repairs missing or stale spoke blocks. `/docs check --check` validates only and never writes.

### `/docs status`

Detailed status overlay with manifest info, ADR count, and workflow mode.

### `/docs update-index`

Regenerate `docs/engineering/decisions/README.md` from ADR metadata.

Blocked in Discuss/Plan/Unknown mode. Requires Build or Off mode.

### `/docs patch`

Suggest docs updates based on recent code changes. Shows:

- Which docs areas are affected
- Which files triggered the suggestion
- Options: generate patch, view individual docs, or skip

### `/docs validate-tags`

Show valid docs area tags, ADR action tags, and common tag issues.

## Workflow Mode Gates

| Mode | Docs writes | `/docs patch` | Reminder |
|------|-------------|---------------|----------|
| Discuss | ❌ blocked | ❌ blocked | ❌ none |
| Plan | ❌ blocked | ❌ blocked | ❌ none |
| Build | ✅ allowed | ✅ allowed | ✅ shown |
| Off | ✅ allowed | ✅ allowed | ✅ shown |
| Unknown | ❌ fail-closed | ❌ blocked | ❌ none |

When mode is unknown (workflow-modes extension not loaded), write actions are disabled. Use `/mode build` or `/mode off` to enable docs writes.

## Docs Structure

```
docs/engineering/
  manifest.json           # Marks managed docs, lists canonical/generated files
  README.md              # Index and how-to
  architecture.md        # System shape, component boundaries, data flow
  dev-workflow.md         # Setup, env vars, commands, build/test/deploy
  conventions.md         # Naming, style, patterns, coding rules
  invariants.md           # Must-not-break rules
  traps.md                # Known gotchas, pitfalls, issues
  decisions/
    README.md             # Auto-generated decision index
    ADR-template.md        # Template for new decisions
    ADR-0001-*.md          # Individual decisions

AGENTS.md                  # Generated root pointer spoke
CLAUDE.md                  # Generated root pointer spoke
```

## Docs Task Tags

When implementation changes project truth, Plan mode should include a docs task in Section 4.

### Area Tags

| Tag | Use when |
|-----|----------|
| `[DOCS:architecture]` | System shape, component boundaries, data flow changed |
| `[DOCS:dev-workflow]` | Setup, env, commands, build/test/deploy changed |
| `[DOCS:conventions]` | Naming, style, patterns, coding rules changed |
| `[DOCS:invariants]` | Must-not-break rules added or changed |
| `[DOCS:traps]` | New gotchas, pitfalls, or issues discovered |
| `[DOCS:decisions]` | High-impact decision recorded |

### ADR Tags

`[DOCS:decisions]` tasks must include one of:

| Tag | Meaning |
|-----|---------|
| `[ADR:new]` | New architectural decision |
| `[ADR:update]` | Revise existing ADR |
| `[ADR:supersede]` | Supersede previous ADR |

### Tag Rules

- **Invalid:** `[DOCS]` without area — always specify the area
- **Invalid:** `[DOCS:decisions]` without `[ADR:new|update|supersede]`
- **Valid:** `[DOCS:architecture][DOCS:traps]` — multiple areas on one task
- **Valid:** `[DOCS:decisions][ADR:new]` — decision with ADR action

## ADR Template

```markdown
---
id: ADR-000N
title: Short title
status: Proposed | Active | Superseded | Deprecated
date: YYYY-MM-DD
---

# ADR-000N: Short title

## Decision
- Decision point 1

## Why
- Main reason/tradeoff

## Affects
Docs:
- `docs/engineering/...`

Code:
- `src/...`

## Consequences
- Good: benefit
- Bad/risk: risk

## Read when
- touching relevant area

## Supersedes
- (ADR-XXXXX, if any)
```

## Decision Index

`docs/engineering/decisions/README.md` is auto-generated from ADR frontmatter. Run `/docs update-index` after adding or editing ADR files.

The index contains:

| ADR | Status | Summary | Read when |
|-----|--------|---------|-----------|
| ADR-0001 | Active | Auth model | touching auth |

## Manifest

`docs/engineering/manifest.json` marks managed docs:

```json
{
  "version": 1,
  "kind": "engineering-docs",
  "managedBy": "pi-docs-extension",
  "entrypoint": "docs/engineering/README.md",
  "canonicalDocs": [
    "docs/engineering/README.md",
    "docs/engineering/architecture.md",
    "docs/engineering/dev-workflow.md",
    "docs/engineering/conventions.md",
    "docs/engineering/invariants.md",
    "docs/engineering/traps.md"
  ],
  "generated": [
    "docs/engineering/decisions/README.md",
    "AGENTS.md",
    "CLAUDE.md"
  ]
}
```

## Root Spokes

`AGENTS.md` and `CLAUDE.md` are generated entrypoint spokes for coding agents. They contain no project facts beyond canonical doc paths and point agents to:

- `docs/engineering/invariants.md`
- `docs/engineering/conventions.md`
- `docs/engineering/`

Managed block contract:

```markdown
<!-- pi-docs:start (generated — edit docs/engineering/, not this block) -->
...
<!-- pi-docs:end -->
```

Generation is non-destructive: absent files become block-only, files without markers get the block appended, and files with markers replace only the managed block. Content outside markers is user-owned.

V1 spoke set: `AGENTS.md`, `CLAUDE.md`.

## Build-End Reminder

When code/config changes are detected and `docs/engineering/` was not touched during the session, the extension shows a one-time reminder in Build/Off mode:

> 📋 Docs update suggested
> N relevant file(s) changed but docs/engineering/ was not touched
> Update docs?

**Dismiss** snoozes the reminder for the session. **Confirm** points to `/docs patch`.

## Safety Model

- **No silent writes** — all writes require explicit confirmation
- **No generated factual claims** — patch prompts instruct agents to mark unsupported claims as `<!-- TODO: verify -->`
- **No overwrites on init** — `--yes` skips prompts but never overwrites existing curated files
- **Non-destructive spokes** — root spokes update only the managed marker block
- **Mode gates enforced in tools** — write/edit to `docs/engineering/` blocked in Discuss/Plan/Unknown even if agent forgets
- **Decision index regenerated** — never hand-maintained, always generated from ADR metadata
- **Evidence-backed patches** — patch suggestions list which files triggered the recommendation

## Interoperability

The extension communicates with `workflow-modes` via `pi.events`:

| Event | Direction | Data |
|-------|-----------|------|
| `workflow-modes:changed` | Emitted | `{ mode, hasPlan }` |
| `workflow-modes:get` | Received | Request current state |
| `workflow-modes:state` | Received | `{ mode, hasPlan, plan? }` |

If workflow-modes is not loaded, the docs extension defaults to unknown mode (write-blocked).

## Agent Tool

The extension registers `docs_validate_tags` for validating `[DOCS:*]` and `[ADR:*]` tags in plan text. This can be called by the agent to check plan task tags before implementation.

## File Layout

```
agent/extensions/engineering-docs/
  package.json        # Extension package
  index.ts            # Main extension, commands, dashboard, events
  constants.ts        # Types, paths, config
  mode.ts             # Workflow mode interop
  filesystem.ts      # Init, check, ADR, decision index
  tracking.ts        # Change tracking and reminder state
  patch.ts            # Patch suggestion and preview
```