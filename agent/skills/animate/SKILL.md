---
name: animate
description: Design or implement web animation with deliberate choices about purpose, frequency, properties, easing, interruption, and accessibility. Use when asked to add or refine web motion.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Animate

Use the build sequence in [references/guide.md](references/guide.md), then consult [references/recipes.md](references/recipes.md) for matching patterns. Prefer existing CSS and project tokens; choose motion only when purpose and frequency justify it.

## Pi workflow

- **Discuss/Plan:** recommend motion specs in the frontend plan: meaning/purpose, trigger, semantic token names, and `prefers-reduced-motion`. Add or update web-applicable token values in `docs/design/` before component tasks.
- **Build:** implement frozen spec literally. No unplanned motion, taste changes, or new dependencies. Missing or wrong spec -> stop and ask for Plan update.
- **Review:** findings only, checked against spec and accessibility requirements.
