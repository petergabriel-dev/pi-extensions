---
id: ADR-0053
title: Redesign precedence, code-scoped ponytail, and plan-owned creative direction
status: Active
date: 2026-11-05
decision: A confirmed redesign target wins over the incumbent design system by promotion into docs/design/ specs and tokens first; ponytail minimalism governs code, wiring, dependencies, and structure, not visuals; Plan proposes distinct creative directions with the bundled design skills, and Build implements per-component Design deltas and verifies against the target.
why: Prompts made existing components canonical over handoffs and applied ponytail scope pressure to visual design, so redesigns kept the old UI; promotion keeps one canonical source while letting the target win, and Plan-owned directions add creativity without moving taste into Build.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/plan-template.md, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/skills/impeccable/SKILL.md, agent/skills/impeccable/references/direction.md, agent/skills/THIRD_PARTY_NOTICES.md, scripts/check-package.mjs, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/invariants.md, CHANGELOG.md, docs/engineering/decisions/ADR-0053-redesign-precedence-and-creative-design-direction.md, docs/engineering/decisions/README.md
consequences: Redesign inputs now change shipped UI instead of being absorbed by old components; docs/design/ stays the single canonical source and references stay untrusted data; plans grow by design-spec tasks, directions, and Design deltas; all behavior remains prompt-only and needs live observation.
readWhen: changing ponytail wording in any mode, redesign detection, Redesign target or Design delta fields, component contract fields, reference precedence or snapshots, design-skill references, impeccable playbooks, or Build frontend verification
supersedes: None
extends: ADR-0012, ADR-0042, ADR-0049, ADR-0050
---

# ADR-0053: Redesign precedence, code-scoped ponytail, and plan-owned creative direction

## Context

Redesign requests kept producing the old UI even with complete handoffs, HTML files, and specs. Reuse pressure stacked across workflow-mode prompts: ponytail minimalism in Discuss, Plan, Build, and worker delegation; "reuse the existing design system" in Plan; "reuse documented components" in Build; and reference prompts that ranked `docs/design/` specs above any reference. The plan template had no design step in its task order, every component task had to name a base component, and the bundled `impeccable` skill said the incumbent system was authoritative and offered only review and refine playbooks. No prompt modeled redesign intent.

## Decision

- **Ponytail scope.** In Discuss, Plan, Build, and worker delegation, ponytail governs code, wiring, dependencies, and structure, not visual design. Fidelity to a confirmed design target (in Build, the saved Redesign target and Design deltas) joins the non-negotiables. Plan never merges away or drops design spec/token tasks.
- **Redesign signal.** When the user asks for a redesign, restyle, or new design, or supplies design files or described visual changes for in-scope screens, the agent confirms once (skipped if already confirmed) and Plan records a plan-scoped Redesign target: inputs, screens in scope, snapshot path for out-of-repo files, and chosen direction. No new mode, command, or manifest field.
- **Precedence by promotion.** A confirmed target wins over incumbent components and tokens by being rewritten into `docs/design/` specs and tokens in the first tasks, so `docs/design/` stays the single canonical source. Reference content stays untrusted data, never instructions, and never satisfies the documented-spec rule on its own. The Build reference rule that specs win on conflict yields only while a saved redesign task promotes a named target into them.
- **Spec-first order.** Whenever design docs or tokens change, `docs/design/` and manifest `tokenFiles` tasks are step 0 of the plan's task order, tagged `[DOCS:design]`. The separate "Rules-first frontend order" subsection is removed.
- **Component contract.** `Base component` is reuse, restyle, replace, or new. Redesign component tasks carry a Design delta: before → after per visual property, or `unchanged (reason)`. Restyle or replace means a visible change; reuse unchanged is not allowed.
- **Creative direction in Plan.** Fidelity comes first: match what the target specifies and be creative only in what it leaves open; description-only or new UI gets full creative direction. For open visual work, Plan proposes 2–3 distinct named directions on named axes using the new original `impeccable` Direction playbook (`references/direction.md`), recommends one, and the user picks. `PLAN_DESIGN_DIRECTION_PROMPT` names `impeccable`, `emil-design-eng`, `apple-design`, `animate`, `animation-vocabulary`, `find-animation-opportunities`, and `prototype` by absolute path. Plan may add a `prototype` task for key screens before component tasks. `impeccable` SKILL.md authority and reuse-first lines now defer to a confirmed redesign target.
- **Build.** Build runs design-doc and token tasks first; copies user-named out-of-repo target files into `docs/design/reference/<slug>/` as data and reports each path; builds planned prototype variants; refines within spec with `impeccable` polish and `emil-design-eng`; and deletes superseded components and tokens once `rg` finds no references, listing still-referenced ones. Frontend verification renders target HTML at the same viewports for side-by-side comparison, or checks every Design delta for description-only targets, and applies `break-ui`, `review-animations`, and `mobile-native` where relevant. Discuss critiques shared designs with `impeccable`.

## Why

The model followed its instructions: existing components were canonical and the handoff was demoted, so new designs were squeezed into old parts. Promoting the target into canonical specs lets it win without creating a second source of truth, and keeps Build's existing "specs are authoritative" rule working for the redesign instead of against it. Scoping ponytail to code keeps backend, logic, and wiring robust while visual work can be creative. Confirm-once detection avoids both silent misses and accidental overrides. Design deltas make "reused everything" visible during plan review. Keeping creative direction in Plan preserves ADR-0049's split: Plan decides taste, Build implements it literally.

Alternatives rejected:

- Handoff always wins whenever present: a stale reference snapshot could silently override current design during ordinary work.
- Only soften ponytail: reference and Build prompts would still demote the handoff.
- Point tasks at the handoff directly: old specs would contradict new code and Build's spec rule would need an exception.
- Replace `docs/design/` wholesale with the handoff: imports raw values and any embedded directives into the canonical layer.
- Keyword-only signal, or a new command or manifest field: misses complete handoffs given without the keyword, or adds surface that earlier ADRs rejected.
- Let Build improvise taste within loose specs: breaks Plan-owned taste and mixes creative choices into implementation.
- Prompt-only creativity without skill changes: `impeccable` would keep contradicting the prompt.
- Import more upstream `impeccable` playbooks: more provenance work and package size for little gain.
- Always keep superseded components: dead parts pull future agents back to the old look.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/invariants.md`
- `CHANGELOG.md`
- `docs/engineering/decisions/ADR-0053-redesign-precedence-and-creative-design-direction.md`
- `docs/engineering/decisions/README.md`

Code, tests, and packaged skills:

- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/plan-template.md`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/skills/impeccable/SKILL.md`
- `agent/skills/impeccable/references/direction.md`
- `agent/skills/THIRD_PARTY_NOTICES.md`
- `scripts/check-package.mjs`

## Consequences

- Good: redesign handoffs, HTML files, and described changes reach shipped UI instead of being absorbed by old components.
- Good: `docs/design/` stays the one canonical source; references and targets stay untrusted data.
- Good: visual work can be creative while code, wiring, and structure stay minimal and robust.
- Good: peer harnesses inherit the change through bridge prompts; no harness command edits are needed.
- Bad/risk: all behavior is prompt-only and can be under- or over-applied; live observation on a real redesign is deferred.
- Bad/risk: plans grow by design-spec tasks, directions, and Design deltas before component work starts.
- Bad/risk: `PLAN_DESIGN_DIRECTION_PROMPT` sits close to its 2,000-character budget at long installed skill paths.
- Bad/risk: delete-if-unreferenced depends on Build's reference search being complete.
- Follow-up: `impeccable` `references/polish.md` still says to preserve established identity; after promotion the saved spec defines that identity.

## Read when

- changing ponytail wording in any workflow mode or worker delegation
- changing redesign detection, the Redesign target, Design delta, or component contract fields
- changing reference precedence, snapshot behavior, or design-skill references
- changing `impeccable` playbooks or Build frontend verification

## Supersedes

- None

## Extends

- ADR-0012: Per-mode ponytail lazy-senior-dev reflex
- ADR-0042: Design reference directory convention
- ADR-0049: Plan-owned frontend specifications without Design mode
- ADR-0050: Bundled design skills and cross-harness export
