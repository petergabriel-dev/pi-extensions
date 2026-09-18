---
id: ADR-0037
title: Design token adherence advisory on source writes
status: Active
date: 2026-09-18
decision: Surface bounded, read-only design-token advisories after successful source write/edit results; never block the mutation or replace its content.
why: Catch newly introduced raw colors in the same turn while keeping writes reliable, avoiding a source-analysis pipeline, and preserving the existing design-manifest boundary.
affects: agent/extensions/engineering-docs/design-adherence.ts, agent/extensions/engineering-docs/tracking.ts, agent/extensions/engineering-docs/test/test_design_adherence.ts, agent/extensions/engineering-docs/package.json, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/decisions/ADR-0024-design-mode-and-design-docs-root.md, docs/engineering/decisions/ADR-0037-design-token-adherence-advisory.md, docs/engineering/decisions/README.md
consequences: Successful write/edit results may gain one bounded advisory block; missing or invalid design manifests and any advisory error pass through unchanged, while token indexing adds only bounded manifest/token-file reads with in-process mtime caching.
readWhen: changing design-token parsing, source-write result handling, advisory scope or formatting, design-manifest permissions, or exact-match guidance
supersedes: None
---

# ADR-0037: Design token adherence advisory on source writes

## Decision

- Use the existing successful `tool_result` handler in `engineering-docs/tracking.ts` as the advisory channel. After existing docs-change tracking, append one text block to successful `write`/`edit` results; never block, set `isError`, or replace the tool's own content.
- Activate only when `docs/design/manifest.json` validates. Read the manifest and its validated `tokenFiles`; resolve primitive and semantic token aliases with a bounded five-hop cycle-guarded lookup and cache parsed token files by path and `mtimeMs`.
- Scope detection to colors: three-, four-, six-, and eight-digit hex literals plus `rgb()`/`rgba()`/`hsl()`/`hsla()`. Normalize RGB arithmetically and ignore alpha for exact matching. HSL is reported without a token suggestion.
- Offer suggestions only for exact normalized matches. Prefer a matching semantic token; otherwise name the matching primitive with a layer note; misses point to `docs/design/tokens.md`. Limit output to five distinct literals plus `+N more`, omit line numbers, and scan only newly written text below the 256 KiB bound.

## Why

- A non-blocking `tool_result` advisory catches a raw color in the same turn without turning design guidance into a write gate or risking data loss. Returning the original content first keeps extension result chaining safe.
- Colors are the narrowest useful signal supported by the existing token parser. Spacing, typography, layout, and named colors require broader semantics and are outside this advisory.
- Exact matching is explainable and deterministic. Nearest-color matching could recommend a visibly wrong token; line numbers would require reading and reconciling the final file even though `write`/`edit` input contains only new text fragments.
- Manifest-gated, bounded reads reuse the existing design permission boundary and avoid reporting the repository's legacy backlog. Fail-open behavior preserves tool reliability when design metadata is absent or damaged.

## Affects

Docs:

- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [ADR-0024-design-mode-and-design-docs-root.md](ADR-0024-design-mode-and-design-docs-root.md)
- [decisions index](README.md)

Code:

- [design-adherence.ts](../../../agent/extensions/engineering-docs/design-adherence.ts)
- [tracking.ts](../../../agent/extensions/engineering-docs/tracking.ts)
- [test_design_adherence.ts](../../../agent/extensions/engineering-docs/test/test_design_adherence.ts)
- [engineering-docs/package.json](../../../agent/extensions/engineering-docs/package.json)

## Consequences

- Good: Newly written raw colors receive a terse same-turn suggestion without blocking the write or hiding the original tool result.
- Good: Semantic aliases, primitive-only matches, misses, RGB conversion, alpha-insensitive matching, HSL limitations, and bounded output have deterministic behavior.
- Good: The design manifest remains the sole source permission and token-file reads are cached by path and modification time.
- Bad/risk: A color in a comment, fixture, or other allowlisted source extension can still produce an advisory; it is intentionally non-blocking.
- Bad/risk: Exact matching misses near-equivalent colors and HSL token values do not produce suggestions.

## Rejected alternatives

- **Source extraction pipeline:** Rejected as heavier, broader, and unnecessary for same-turn color literals; it would add parsers and final-file/provenance concerns.
- **Provenance and confidence fields:** Rejected because this advisory has one deterministic source text and exact-match rule; extra metadata would add output noise without improving the action.
- **Scored critic:** Rejected because heuristic severity or confidence would make a narrow policy less predictable and harder to trust.
- **Nearest-color matching:** Rejected because perceptual closeness is not semantic intent and can recommend the wrong token.
- **Auto-repair:** Rejected because replacing source text can alter behavior, requires final-file context, and turns advisory guidance into an unsafe mutation.

## Relationship to ADR-0024

ADR-0024 remains Active and is not superseded. It defines Design mode, the `docs/design/` root, manifest-declared token-file permissions, and design-system guidance. This ADR adds a read-only source-write advisory that consumes that manifest boundary; it does not change Design write permissions, manifest schema, prompt guidance, or preview rules.

## Read when

- changing `design-adherence.ts` detection, token indexing, cache bounds, or advisory formatting
- changing `tracking.ts` successful `write`/`edit` result handling or extension/path filters
- changing design manifest validation, token-file permissions, or the relationship to Design mode
- considering source extraction, confidence scoring, nearest-color suggestions, line mapping, or auto-repair

## Supersedes

- None
