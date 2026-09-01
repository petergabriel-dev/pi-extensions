# Subagent Follow-ups

This backlog carries deferred audit items 3, 4, and 6. Audit items 1–2 were fixed and recorded in the subagent policy/listen changes and engineering docs.

## 3. Add lifecycle race integration matrix

**Severity:** Medium — verification gap, not a confirmed defect.

**Evidence:** `agent/extensions/subagents/launch.ts:501-507` funnels child errors, exits, and watchdog timeouts into failure finalization. Abort, host close, result, and failure paths cancel watchdogs at `:567-576`, `:605-614`, `:697-705`, and `:718-743`. Focused coverage exists in `agent/extensions/subagents/test/test_launch.ts`, `agent/extensions/subagents/test/test_timeout.ts`, and `agent/extensions/subagents/test/test_interaction.ts`, but no combined race matrix proves every cleanup ordering.

**Follow-up:** Add integration coverage for:

- timeout racing with child exit
- cancellation racing with IPC disconnect
- parent close racing with browser cleanup
- nested worker failure and concurrency-slot release
- late result after record eviction

Verify ownership, watchdog, browser page, cmux surface, pending request, and parent-record cleanup for each ordering.

## 4. Define ownership alias semantics

**Severity:** Medium — safety-boundary verification gap.

**Open residue:** This change makes read-only children skip ownership locks, but writer ownership identity remains lexical. Symlink aliases, case differences on case-insensitive filesystems, and alternate relative paths remain undefined.

**Follow-up:** Decide and test whether ownership identity uses lexical normalization, real paths, case folding, or a documented combination. Cover symlinked directories, case variants, and equivalent relative paths before changing the lock boundary.

## 6. Check generated-doc enforcement

**Severity:** Low/medium — process risk.

**Evidence:** `docs/engineering/manifest.json:14-18` identifies generated decision indexes and root spokes. `package.json:62-65` runs workspace/package checks but does not invoke `/docs check --check` or decision-index regeneration. CI runs `npm test` at `.github/workflows/ci.yml:20-22`, so generated-doc freshness enforcement is not explicit in the current workflow.

**Follow-up:** Determine whether another CI or release path detects stale spokes/indexes. If not, add a read-only freshness check that fails on stale generated docs without permitting CI to rewrite canonical or generated files.
