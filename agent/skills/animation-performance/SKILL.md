---
name: animation-performance
description: Diagnose animation jank and choose low-cost properties and execution paths. Use when motion stutters, drops frames, or needs performance review.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Animation Performance

Name the cause before changing code. Read [references/guide.md](references/guide.md) for diagnosis and [references/performance-cheatsheet.md](references/performance-cheatsheet.md) for quick fixes. Do not claim smoothness from code inspection or a fast machine alone; identify device checks still needed.

## Pi workflow

- **Discuss/Plan:** specify performance goal, trigger, semantic motion tokens, and reduced-motion behavior; record web-applicable token values in `docs/design/`.
- **Build:** fix only performance issues within frozen spec; no speculative `will-change` or unplanned animation changes.
- **Review:** findings only, tied to evidence and spec.
