---
name: apple-design
description: Apply Apple's principles for direct manipulation, fluid gestures, momentum, interruptibility, and motion restraint to web interfaces.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Apple Design

Read [references/guide.md](references/guide.md) for gesture, motion, typography, and material guidance. Translate platform ideas to the web deliberately; preserve accessibility, direct control, and current project conventions.

## Pi workflow

- **Discuss/Plan:** freeze motion purpose, trigger, semantic token names, gesture behavior, and `prefers-reduced-motion` in the frontend plan; place web-applicable tokens in `docs/design/`.
- **Build:** implement only frozen choices. No unplanned platform styling or taste changes; missing spec -> ask for Plan update.
- **Review:** findings only, especially around gesture control and accessibility.
