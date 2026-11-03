# Technical UI audit

Audit reports issues; it does not fix them. Inspect only the requested or changed UI scope and state which files, routes, screenshots, viewports, themes, and states were actually reviewed. Use source `path:line` citations. Missing evidence is unverified, not a pass.

## Dimensions

Score each applicable dimension 0–4 (0 severe, 1 major gaps, 2 partial, 3 good with minor gaps, 4 excellent). Use `n/a` only when genuinely inapplicable and state the reason.

1. **Accessibility:** text contrast (4.5:1 normal, 3:1 large), semantic roles, accessible names/states, keyboard order and visible focus, labels/errors, alt text, reduced motion, and screen-reader updates.
2. **Performance:** layout reads/writes in loops, unnecessary rendering/dependencies, oversized or unoptimized assets, layout shift, and expensive animation effects. Cite evidence; do not infer runtime performance from source alone.
3. **Theming:** hard-coded colors, token misuse, semantic light/dark values, native control colors, and theme switching.
4. **Responsive design:** fixed-width overflow, text scaling, breakpoint behavior, touch target size, and gesture paths. A rendered viewport proves layout only; gesture behavior needs an exercised interaction.
5. **Implementation integrity:** repeated shortcuts, divergence from shared components/tokens, misleading content, dead code, and consistency with the frozen spec.

## Summary and findings

Show the five dimensions, evidence, total, and rating band. The full total is `/20`; use `4 × scored dimensions` when any are `n/a` and state the denominator. Full-score bands: 18–20 excellent, 14–17 good, 10–13 acceptable, 6–9 poor, 0–5 critical. Uninspected evidence is unverified, not a zero.

Tag each issue P0–P3 (blocking, major, minor, polish). Include:

- **Issue and location:** `path:line` (plus screenshot filename, viewport, theme, and state when relevant).
- **Category and impact:** what rule fails and how it affects users.
- **Evidence and fix:** observed fact, applicable standard where relevant, and a concrete recommendation.

Report verified positives and recurring patterns. Do not edit files. No automatic detector is bundled: this checklist is a manual audit, not a whole-repository scan. Do not claim automated counts or full coverage; name every skipped check and why.
