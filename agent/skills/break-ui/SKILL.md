---
name: break-ui
description: Stress-test UI with realistic worst-case data and states, then report layout failures and fixes. Use when asked to find component edge cases.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Break UI

Map rendered values and their constraints, select plausible worst cases from [references/catalog.md](references/catalog.md), and exercise empty, single, and large-list states when applicable. Change fixtures at the data boundary, never markup to manufacture a failure. Report before fixing.

## Pi workflow

- **Discuss/Plan:** capture required states, breakpoints, and any motion contract (purpose, trigger, token names, reduced-motion) in the plan; record web-applicable tokens in `docs/design/`.
- **Build:** test and fix only frozen requirements; preserve user data and do not invent new designs.
- **Review:** findings only, with `file:line` evidence.
