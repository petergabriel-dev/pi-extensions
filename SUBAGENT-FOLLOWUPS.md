# Subagent Follow-ups

This backlog carries deferred audit items 3–6. Audit items 1–2 were fixed and recorded in the subagent policy/listen changes and engineering docs.

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

**Evidence:** `agent/extensions/subagents/ownership.ts:13-23` trims, deduplicates, sorts, and compares lexical ownership paths/globs. `agent/extensions/subagents/test/test_policy.ts:33-40` covers ordinary glob overlap only; it does not define symlink aliases, case differences on case-insensitive filesystems, or alternate relative paths.

**Follow-up:** Decide and test whether ownership identity uses lexical normalization, real paths, case folding, or a documented combination. Cover symlinked directories, case variants, and equivalent relative paths before changing the lock boundary.

## 5. Improve worker finalization ergonomics

**Severity:** Low — operational/documentation risk; no confirmed correctness defect.

**Evidence:** `agent/extensions/subagents/timeout.ts:64-109` treats silent active work as idle while preserving a separate max-total cap. Waiting pauses timers at `:93-104`. `agent/extensions/subagents/launch.ts:570`, `:612`, `:703`, and `:739` cancel the watchdog on abort, host close, result, and failure finalization.

The lead “worker finished yet reported idle timeout” is unconfirmed. Watchdog cancellation exists on all observed settle paths, so investigate notification ordering and finalization races rather than treating this as a defect.

**Follow-up:** Bound audit/discovery tasks more tightly, use lower effort for discovery-only work where appropriate, and consider bounded finalization grace without weakening hard max-total limits.

## 6. Check generated-doc enforcement

**Severity:** Low/medium — process risk.

**Evidence:** `docs/engineering/manifest.json:14-18` identifies generated decision indexes and root spokes. `package.json:62-65` runs workspace/package checks but does not invoke `/docs check --check` or decision-index regeneration. CI runs `npm test` at `.github/workflows/ci.yml:20-22`, so generated-doc freshness enforcement is not explicit in the current workflow.

**Follow-up:** Determine whether another CI or release path detects stale spokes/indexes. If not, add a read-only freshness check that fails on stale generated docs without permitting CI to rewrite canonical or generated files.
