---
name: improve-animations
description: Audit a codebase's motion, prioritize confirmed issues and opportunities, and record precise approved changes. Use for a broad animation improvement pass.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Improve Animations

Survey motion, verify every finding at its source, and prioritize by user impact and effort. Read [references/guide.md](references/guide.md), [references/audit.md](references/audit.md), and [references/plan-template.md](references/plan-template.md) as needed. In Pi, record approved choices in the frozen frontend spec, not separate `plans/` files.

## Pi workflow

- **Discuss/Plan:** propose motion specs with purpose, trigger, semantic token names, and `prefers-reduced-motion`; update web-applicable tokens in `docs/design/` before component tasks.
- **Build:** implement only changes named in the frozen spec; missing or incorrect spec -> stop and ask for Plan update.
- **Review:** findings only. Cite `file:line`; distinguish code-verified issues from feel checks still needed.
