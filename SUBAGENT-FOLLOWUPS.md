# Subagent Follow-ups

This backlog carries deferred audit items 4 and 6. Audit items 1–2 were fixed and recorded in the subagent policy/listen changes and engineering docs; item 3 is closed by `agent/extensions/subagents/test/test_lifecycle.ts`.

## 4. Define ownership alias semantics

**Severity:** Medium — safety-boundary verification gap.

**Open residue:** This change makes read-only children skip ownership locks, but writer ownership identity remains lexical. Symlink aliases, case differences on case-insensitive filesystems, and alternate relative paths remain undefined.

**Follow-up:** Decide and test whether ownership identity uses lexical normalization, real paths, case folding, or a documented combination. Cover symlinked directories, case variants, and equivalent relative paths before changing the lock boundary.

## 6. Check generated-doc enforcement

**Severity:** Low/medium — process risk.

**Evidence:** `docs/engineering/manifest.json:14-18` identifies generated decision indexes and root spokes. `package.json:62-65` runs workspace/package checks but does not invoke `/docs check --check` or decision-index regeneration. CI runs `npm test` at `.github/workflows/ci.yml:20-22`, so generated-doc freshness enforcement is not explicit in the current workflow.

**Follow-up:** Determine whether another CI or release path detects stale spokes/indexes. If not, add a read-only freshness check that fails on stale generated docs without permitting CI to rewrite canonical or generated files.
