---
name: animation-vocabulary
description: Map a plain-language description of motion to a precise animation term. Use when someone asks what an effect is called.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Animation Vocabulary

Read [references/guide.md](references/guide.md). Match the user's intent to the glossary, quote its definition, and give at most two useful alternatives when terms overlap. Do not invent terms outside the glossary.

## Pi workflow

- **Discuss/Plan:** when a term becomes a web motion choice, specify its purpose, trigger, semantic token names, and `prefers-reduced-motion` in the frontend plan; record applicable tokens in `docs/design/`.
- **Build:** use terminology to implement only the frozen spec; missing spec -> ask for Plan update.
- **Review:** findings only, use precise glossary terms.
