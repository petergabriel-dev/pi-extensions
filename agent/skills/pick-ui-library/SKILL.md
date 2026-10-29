---
name: pick-ui-library
description: Recommend one library from Emil Kowalski's curated UI technology list for a specific frontend task. Use when explicitly asked to choose a library.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Pick UI Library

Read [references/guide.md](references/guide.md). Inspect the project's declared dependencies and recommend one listed choice; do not churn an existing alternative. Treat dependency selection as a Plan decision. Never install or fetch a package from this skill.

## Pi workflow

- **Discuss/Plan:** settle the library and any motion contract in the plan; name purpose, trigger, semantic tokens, and `prefers-reduced-motion` where applicable. Record web motion tokens in `docs/design/`.
- **Build:** use only the selected, available dependency. If missing or not approved, stop and ask for Plan update.
- **Review:** findings only.
