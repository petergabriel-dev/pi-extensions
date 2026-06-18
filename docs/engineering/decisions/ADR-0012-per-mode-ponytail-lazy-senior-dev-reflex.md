---
id: ADR-0012
title: Per-mode ponytail lazy-senior-dev reflex
status: Active
date: 2026-06-18
---

# ADR-0012: Per-mode ponytail lazy-senior-dev reflex

## Decision

- Mirror ponytail's AGENTS.md behavioral reflex into the workflow-modes prompt constants as the single source of truth.
- Build mode carries the full lazy-senior-dev ruleset: evaluate necessity first, prefer standard-library/native/existing-dependency/single-line solutions, reject needless abstraction/dependencies/boilerplate, preserve non-negotiable correctness areas, and leave one runnable check for non-trivial logic.
- Discuss and Plan modes carry the scope-time subset: question need, separate required behavior from nice-to-haves, prefer deletion/boring/smallest-file-count approaches, and keep correctness guardrails non-negotiable.
- Claude Code receives the reflex only through the bridge `prompts` payload (`discussPrompt`, `planPrompt`, `buildPrompt`). Claude command files reference the served prompt strings and do not duplicate the ponytail ruleset.
- Worker delegation stays prompt-only: Build mode tells the parent to include the minimalism bar in worker task text when workers are used.

## Why

- Workflow-modes already own per-mode behavior and bridge prompt export; adding the reflex there preserves one source of truth.
- Build needs the full ruleset because it writes code, tests, comments, and task-local shortcuts.
- Discuss and Plan need only scope-time pressure because they do not mutate source.
- Bridge propagation avoids drift between Pi and Claude commands.
- Prompt-only guidance matches existing workflow-modes architecture and avoids new mode toggles or enforcement paths.

## Alternatives rejected

- Paraphrasing the ruleset: rejected because fidelity matters more than shortening the Build prompt.
- Mode toggle: rejected because the reflex should be always-on across modes.
- Worker-prompt duplication: rejected because delegation should inherit from Build prompt text and task text, not a second source.
- Build-only placement: rejected because Discuss/Plan should prevent over-scoped work before implementation.
- Duplicating ponytail text into Claude command files: rejected because it would drift from Pi prompts.
- Adding new enforcement/structure: rejected because scope is prompt-only; existing read-only mutation gates remain unchanged.

## Notes

- Ponytail's author-specific hardware calibration non-negotiable was dropped.
- The `ponytail:` shortcut marker remains in Build prompt text.
- Debt-ledger harvesting for `ponytail:` comments is deferred and out of scope.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/decisions/README.md`
- `docs/engineering/decisions/ADR-0012-per-mode-ponytail-lazy-senior-dev-reflex.md`

Code:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/claude-bridge/index.ts`
- `/Users/petergabrielrlopez/.claude/commands/discuss.md`
- `/Users/petergabrielrlopez/.claude/commands/plan.md`

## Consequences

- Good: Pi and Claude share the same minimalism reflex without copied command text.
- Good: Scope pressure happens before implementation, reducing needless plan/tasks/code.
- Good: Correctness guardrails remain explicit: input validation at trust boundaries, data-loss-preventing error handling, security, accessibility, and explicitly requested features.
- Good: Existing workflow-mode mutation gates and bridge structure stay unchanged.
- Tradeoff: Build prompts cost more tokens per turn.
- Bad/risk: Prompt-only behavior can still be under- or over-applied by models and needs manual observation.

## Read when

- Changing workflow-mode prompts or per-mode behavior.
- Changing Claude bridge prompt payloads.
- Changing Claude `/discuss` or `/plan` command behavior for Pi projects.
- Changing worker delegation instructions in Build mode.
- Considering new enforcement, toggles, or debt-ledger harvesting for `ponytail:` comments.

## Supersedes

- None
