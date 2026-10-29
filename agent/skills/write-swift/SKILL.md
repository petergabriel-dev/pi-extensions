---
name: write-swift
description: Write or review modern Swift with value semantics, safe concurrency, explicit error handling, and current language conventions.
license: MIT (see ../THIRD_PARTY_NOTICES.md)
---

# Write Swift

Use [references/guide.md](references/guide.md) as a detailed Swift reference. Follow the project's actual Swift toolchain and build settings; verify version-sensitive guidance before relying on it. Prefer simple value types and structured concurrency; state uncertainty where versions differ.

## Pi workflow

- **Discuss/Plan:** record required Swift behavior and API contracts in the plan; motion details apply only when the task has UI motion.
- **Build:** implement the frozen contract and existing project conventions; missing requirements -> ask for Plan update.
- **Review:** findings only, cite source locations.
