---
name: ask-sonner
description: Guide implementation and troubleshooting for Sonner React toasts, including Toaster placement, toast variants, lifecycle, styling, and accessibility.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Ask Sonner

Use [references/guide.md](references/guide.md) for common patterns and [references/api.md](references/api.md) for exact props, types, and defaults. Check the project's installed Sonner version and follow its existing design tokens. Never install or fetch a dependency from this skill.

## Pi workflow

- **Discuss/Plan:** specify toast purpose, trigger, semantic motion tokens, and `prefers-reduced-motion`; record web-applicable values in `docs/design/`.
- **Build:** implement only frozen toast behavior and styling; if Sonner is absent or scope is unclear, ask for Plan update.
- **Review:** findings only, especially announcement semantics, dismissal, focus, and reduced motion.
