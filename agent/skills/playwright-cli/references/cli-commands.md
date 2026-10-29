# CLI commands for visual QA

Use these only in an authorized Build workflow. `snapshot` returns element refs; `--boxes` adds viewport coordinates.

```bash
playwright-cli open <url>
playwright-cli snapshot --boxes
playwright-cli resize <width> <height>
playwright-cli screenshot --filename=/tmp/component-375-default.png
playwright-cli click e3
playwright-cli hover e4
playwright-cli fill e5 "text"
playwright-cli press Tab
playwright-cli close
```

- **Hover:** `hover <ref>`, then screenshot.
- **Focus-visible:** press `Tab` (or `Shift+Tab`) until target receives keyboard focus; inspect focus indicator and screenshot.
- **Active:** read target bounds from `snapshot --boxes`; move to its center, `mousedown`, screenshot, then `mouseup`.
- **Disabled/loading/empty/error:** trigger the real app flow or approved fixture; verify visible state and expected behavior. Do not alter DOM/CSS to manufacture states.
- **Reduced motion / theme:** use built-in browser or harness emulation, or the app's theme controls, only when required by the spec. If the required condition cannot be emulated, report it as unverified.

Review screenshot files with the harness image viewer. A successful command or DOM snapshot alone is not visual verification. Avoid recording credentials or sensitive page data in screenshots or notes.
