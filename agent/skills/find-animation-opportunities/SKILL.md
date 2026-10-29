---
name: find-animation-opportunities
description: Identify rare, high-confidence interface moments that benefit from motion, while rejecting unnecessary animation. Use when asked what could be animated.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Find Animation Opportunities

Sweep the UI and apply every gate in [references/guide.md](references/guide.md). Report evidence, frequency, purpose, and exact token-backed motion; include rejected candidates. Restraint matters more than count.

## Pi workflow

- **Discuss/Plan:** recommend motion specs with meaning, trigger, semantic token names, and `prefers-reduced-motion`; record web-applicable token values in `docs/design/`.
- **Build:** implement only opportunities already frozen in the spec. Otherwise stop and ask for a Plan update; do not create standalone plans.
- **Review:** findings only, with `file:line` evidence.
