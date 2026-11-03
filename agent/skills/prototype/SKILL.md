---
name: prototype
description: Build isolated, genuinely distinct UI variants behind an accessible picker when a frozen spec explicitly calls for exploration.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Prototype

Read [references/guide.md](references/guide.md) and follow [references/picker.md](references/picker.md) exactly. Keep prototypes isolated from production and make variants differ on a named axis. Do not decide unplanned product taste in Build; use only variants and axes authorized by the frozen plan.

## Pi workflow

- **Discuss/Plan:** decide the direction and any motion spec, including purpose, trigger, semantic tokens, and `prefers-reduced-motion`; record web-applicable token values in `docs/design/`.
- **Build:** create only the specified isolated prototype; if no exploration is specified, ask for Plan update.
- **Review:** findings only against frozen spec and accessibility.
