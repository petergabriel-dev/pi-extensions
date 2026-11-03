---
name: animate-expo
description: Design or implement React Native and Expo motion, gestures, sheets, haptics, and interruption-safe animations. Use for mobile-native animation tasks.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Animate Expo

Use the decision sequence in [references/guide.md](references/guide.md); consult [references/recipes.md](references/recipes.md) for concrete gesture and animation patterns. Prefer platform-native behavior and project dependencies already present. Never install packages from this skill.

## Pi workflow

- **Discuss/Plan:** specify motion purpose, trigger, semantic token/value, gesture behavior, and reduced-motion behavior in the frontend plan. Record web-applicable shared motion tokens in `docs/design/`.
- **Build:** implement only frozen choices and approved dependencies. Missing package/setup or missing spec -> stop and ask for Plan update.
- **Review:** findings only, including device-verification limits.
