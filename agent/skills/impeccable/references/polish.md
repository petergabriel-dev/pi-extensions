# Scoped polish

Polish is refinement, not concealed redesign. Use only in Build. The saved frontend spec and `docs/design/` contracts override taste defaults. Preserve the identity the saved spec sets (incumbent, or a confirmed redesign's promoted specs), plus behavior, copy, and anything outside scope. If the concept is wrong or a binding rule is unclear, stop and ask for a Plan decision.

## Establish the system

Read `docs/design/README.md`, `docs/design/manifest.json`, declared token files, relevant component specs, shared components, neighboring flows, and representative source/screenshots. Reuse the existing system or base library, except where the saved plan restyles or replaces it. Do not create a second token/component system.

Classify drift before fixing:

- **Missing reusable token:** update a declared token source and semantic light/dark values.
- **One-off implementation:** use the documented shared component or pattern.
- **Spec mismatch:** implement the approved contract; ask before changing it.
- **Local defect:** fix the narrow incomplete or inconsistent implementation.

## Triage and refine

Fix in this order: blocked tasks/data loss/accessibility; missing loading/empty/error/success/disabled states; flow, hierarchy, responsive, and token drift; visual/motion/copy inconsistencies; dead code and cleanup. Fix the cause at the narrowest correct level.

Check the complete user path, not one screenshot. Verify every specified viewport; if none are listed, use widths 375, 768, and 1280 px. Check each required theme, component state, and interaction. Inspect role, labels, keyboard behavior, visible focus, contrast, reduced motion, content length, and error recovery. Use local `web-design-guidelines` rules when available. Do not add animation or abstraction just to make a change look substantial.

## Finish

After fixes, render and inspect the same required viewports/states again. Use existing project checks that apply; do not install a new detector or claim a visual check that did not run. Review the source diff for accidental churn and confirm every edit remains within the frozen spec. Report changed files, verification evidence, and any unverified conditions.
