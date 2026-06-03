---
id: ADR-0009
title: Bridge staging validity and malformed quarantine
status: Active
date: 2026-06-03
---

# ADR-0009: Bridge staging validity and malformed quarantine

## Decision

- Claude bridge `capture_note` keeps lesson notes as persistent-memory lesson candidates rather than downgrading them to domain facts or other types.
- Bridge-staged lesson candidates must include a valid non-empty trigger list at write time, using the shared `deriveLessonTriggers(...)` helper.
- Existing malformed staging files are repaired in-process by the reconcile loader before classification; repairable lesson candidates with missing or empty triggers are rewritten as valid staging and processed normally.
- Staging files that remain structurally malformed after repair are written to the existing `deadletter/` store with candidate/original content preserved, then removed from `staging/`.
- Wrong-project staging files remain preserved and are not quarantined by the malformed-staging path.

## Why

- Native lesson normalization intentionally requires at least one valid trigger. Weakening that rule would regress retrieval quality and violate the lesson invariant.
- The Claude bridge previously wrote lessons with `triggers: []`, making valid-looking bridge captures structurally malformed to `normalizeStagingFile(...)` and causing old `claude-code-*` files to be preserved indefinitely.
- Deriving a lightweight topic trigger at capture/repair time makes the staging schema valid without adding extra careful-model calls; final authoritative lesson triggers are still assigned by reconciliation.
- Repair-before-quarantine avoids losing fixable bridge captures, while dead-lettering unrepairable malformed staging gives bounded behavior and preserves forensic content.
- Reusing the existing dead-letter store keeps malformed-staging handling aligned with reconciliation validation dead-letter behavior.

## Affects

Docs:

- `docs/engineering/traps.md`
- `docs/engineering/invariants.md`
- `docs/engineering/decisions/ADR-0009-bridge-staging-validity-malformed-quarantine.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/claude-bridge/index.ts`
- `agent/extensions/persistent-memory/consolidation/staging.ts`
- `agent/extensions/persistent-memory/consolidation/reconcile.ts`
- `agent/extensions/persistent-memory/test/test_staging_repair.ts`
- `agent/extensions/persistent-memory/test/test_bridge_capture_staging.ts`
- `agent/extensions/persistent-memory/test/test_reconcile_loader_repair_quarantine.ts`

## Consequences

- Good: fresh bridge lesson captures produce staging accepted by `normalizeStagingFile(...)`.
- Good: the old stuck `claude-code-*` bridge files can be repaired and reconciled rather than discarded.
- Good: genuinely unrepairable malformed staging no longer remains in `staging/` indefinitely.
- Good: trigger derivation/repair logic lives once in persistent-memory and is reused by the bridge.
- Risk: derived trigger topics are heuristic and may be low fidelity; reconciliation remains responsible for final model-assigned lesson triggers.
- Risk: malformed whole-file dead-letter records may use a fallback category when candidate categories cannot be extracted, so consumers should treat them as forensic records rather than normalized memory candidates.

## Read when

- changing Claude bridge `capture_note` staging behavior
- changing persistent-memory lesson candidate validation or trigger requirements
- changing staging loader classification, repair, quarantine, or dead-letter handling
- debugging `malformed` staging counts, stuck `claude-code-*` files, or `/memory deadletter` output

## Supersedes

- None. ADR-0002 and ADR-0006 still govern partial reconciliation, validation dead-lettering, and chunked reconcile behavior.
