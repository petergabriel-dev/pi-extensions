---
name: remove-animations
description: Find unnecessary or harmful animation and remove only motion that lacks purpose or harms frequent interactions. Use when an interface feels slow or over-animated.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Remove Animations

Apply the decision tree and removal hazards in [references/guide.md](references/guide.md). Check hidden start states, timing callbacks, focus behavior, tests, and orphaned code before removing motion. Do not remove dependencies without explicit approval.

## Pi workflow

- **Discuss/Plan:** recommend motion changes with purpose, trigger, semantic token names, and `prefers-reduced-motion`; record web-applicable token updates in `docs/design/`.
- **Build:** subtract only motion explicitly targeted by the frozen spec; no unplanned retuning. Missing scope -> ask for Plan update.
- **Review:** findings only, with `file:line` evidence.
