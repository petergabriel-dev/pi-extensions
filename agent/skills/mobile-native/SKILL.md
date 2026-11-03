---
name: mobile-native
description: Fix web-app behaviors that feel wrong on touch devices, including hover, viewport, safe areas, tap feedback, scroll, and keyboard handling.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Mobile Native

Use the symptom table and platform fixes in [references/guide.md](references/guide.md). Prefer capability media queries and native platform behavior over device sniffing or custom JavaScript. Never disable zoom. Emulation is not real-device verification; report checks that remain.

## Pi workflow

- **Discuss/Plan:** specify mobile interaction, trigger, semantic motion tokens, and `prefers-reduced-motion` where relevant; record web-applicable tokens in `docs/design/`.
- **Build:** implement frozen requirements only; missing viewport or interaction contract -> ask for Plan update.
- **Review:** findings only, include accessibility and real-device verification gaps.
