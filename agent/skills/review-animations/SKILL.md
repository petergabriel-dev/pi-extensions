---
name: review-animations
description: Review animation and motion changes against usability, performance, physicality, and accessibility standards. Use for focused motion QA.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Review Animations

Review the diff against the frontend spec and list actionable motion findings with `file:line` evidence. Read [references/guide.md](references/guide.md); load [references/standards.md](references/standards.md) for exact criteria and values. Findings default to blocking when motion violates accessibility or frozen design contracts.

## Pi workflow

- **Discuss/Plan:** recommend motion specs with purpose, trigger, semantic token names, and `prefers-reduced-motion`; record web-applicable values in `docs/design/`.
- **Build:** only apply review findings explicitly authorized by frozen spec; otherwise report and ask for Plan update.
- **Review:** findings only. Never edit.
