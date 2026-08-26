---
name: web-debug
description: Debug broken web pages, failed logins, blank screens, console errors, missing request headers, cookie or storage mismatches, and UI actions that do not produce expected requests.
---

# Web Debug

## Preconditions

1. Work from a reproducible symptom. Record URL, action, expected result, actual result, and timestamp.
2. Browser navigation, eval, click, fill, and close require Build mode. If current `[workflow-modes]` line is not Build, stop. Run `/mode build`.
3. If any browser tool reports `Browser gate is off. Run /browser on first.`, stop retrying. Run `/browser on`.
4. If Chromium is unavailable, stop. Run `cd agent/extensions/browser && npx playwright install chromium`.
5. Use a disposable profile for clean-state checks: `PI_BROWSER_PROFILE="$(mktemp -d)" pi`. Never paste credentials, tokens, or full cookie values into notes.

## Core loop

1. Navigate with `browser_goto`.
2. Read `browser_console` for JavaScript errors and page errors. Read `browser_network` with `urlFilter` or `status` when request behavior matters.
3. Inspect DOM and storage with `browser_eval`. Use one expression, function source, or IIFE. Prefer keys, types, and redacted values.
4. Reproduce one user action with `browser_fill` or `browser_click`, using CSS, `text=`, or `role=` selectors.
5. Read console and network again. Compare timestamps, URL, status, request headers, and visible state. Use `browser_screenshot` when layout or rendering matters.
6. State first useful observation, likely boundary, and next narrow check. Do not claim root cause from one symptom.

## Symptom routing

| Symptom | First observation | Next check |
| --- | --- | --- |
| Login fails or loops | `browser_console`, then filtered `browser_network` | Inspect status, auth-related headers, and storage keys; redact secrets |
| Blank page or crash | `browser_console` | `browser_eval` for `document.readyState` and visible text; take screenshot |
| Click/fill has no effect | `browser_eval` for target state | Use `role=` or `text=` selector; read network after action |
| Wrong data or stale session | Filtered `browser_network` | Inspect local/session storage keys and response status; compare clean profile |
| Slow or missing request | `browser_network` with URL filter | Check console, then reproduce after `browser_goto` completes |

## Playbooks

### Login or session

1. `browser_goto` login page.
2. Read console; inspect storage keys with `browser_eval`.
3. Fill fields and click submit.
4. Read filtered network output. Inspect only needed headers; redact values.
5. Compare status, redirect URL, visible error, and storage changes.

### Blank or crashed page

1. `browser_goto` target URL.
2. Read console, including page errors.
3. Eval `document.readyState`, title, and visible text.
4. Take screenshot.
5. Filter network by failing or relevant URL; separate failed requests from rendering symptoms.

### Request or UI mismatch

1. `browser_goto` target URL.
2. Confirm target exists with `browser_eval`.
3. Use one `browser_click` or `browser_fill` action.
4. Read network with `urlFilter`; read console if request is absent or rejected.
5. Repeat once only after changing one variable.

## Pitfalls

- `browser_goto` waits for `domcontentloaded`, not every async request (`agent/extensions/browser/index.ts:579-585`).
- Eval serializes DOM nodes as exact placeholder `"ref: <Node>"`; `undefined`, functions, and symbols become `null`, cycles become `"[Circular]"` (`browser/index.ts:474-496`).
- `browser_console` and `browser_network` drain buffers by default. Pass `clear:false` to peek (`browser/index.ts:629-650`).
- Failed requests expose `request.failure()?.errorText`; live verification produced exact `net::ERR_EMPTY_RESPONSE`. `ERR_ABORTED` was not reproduced; do not treat it as expected (`browser/index.ts:756-763`).
- Network output stores request/response headers, never bodies. Request output defaults to status, method, and URL (`browser/index.ts:641-658`).
- Persistent profiles retain site state. Use `PI_BROWSER_PROFILE` for clean state; close browser after live checks.

## When not to use

- Do not use for backend-only failures, API contract tests, or server logs when no browser symptom exists.
- Do not use for destructive or credential-sensitive actions without explicit authorization.
- Do not bypass `/browser` gate or workflow-mode blocks. In read-only modes, inspect existing console/network/screenshot data only; run `/mode build` before navigation or interaction.
