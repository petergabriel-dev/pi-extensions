---
id: ADR-0030
title: Agent-driven browser verification
status: Active
date: 2026-08-26
decision: Add a gated browser extension backed by playwright-core and a user-installed Chromium binary for agent-driven web verification.
why: Source inspection cannot prove live DOM, browser console, network, interaction, or visual behavior; a persistent one-page browser lets the agent verify those paths while bounded capture, validation, and browser-free tests limit runtime and security costs.
affects: agent/extensions/browser/index.ts, agent/extensions/browser/package.json, agent/extensions/browser/package-lock.json, agent/extensions/browser/tsconfig.json, agent/extensions/browser/test/test_gate.ts, package.json, package-lock.json, scripts/check-workspace.mjs, README.md, docs/engineering/invariants.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md, docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md, docs/engineering/decisions/README.md
consequences: The package gains playwright-core as a runtime dependency and requires manual npx playwright install chromium; browser state persists cookies/storage in a Pi-owned profile, while PI_BROWSER_PROFILE supports clean isolated runs; console/network memory is capped and network bodies are never captured; live tests need Chromium but unit tests remain browser-free.
readWhen: changing browser tools, Chromium or playwright-core setup, browser profile/lifecycle, console/network capture, page actions, screenshot handling, or browser package tests
supersedes: None
---

# ADR-0030: Agent-driven browser verification

## Decision

- Ship `agent/extensions/browser/index.ts` as the tenth package extension. Keep browser tools registered but disabled by default; `/browser on` enables the tool surface, `/browser off`/`close`/`kill` disables it and closes the browser, and `/new` resets the gate to off through branch-local `browser:state` entries.
- Launch one persistent Chromium context and one page lazily on the first browser operation. Resolve the default profile through `getAgentDir()` at `extensions/browser/.profile`; allow `PI_BROWSER_PROFILE` to override it, and close the context on disable, `browser_close`/`browser_kill`, and `session_shutdown`.
- Declare `playwright-core` in the root runtime dependencies and nested browser development package. Do not download Chromium in CI; require operators to run `cd agent/extensions/browser && npx playwright install chromium` for live verification.
- Expose navigation, evaluation, console, network, fill, click, screenshot, and close tools. Validate bounded inputs and operation timeouts; route CSS, `text=`, and `role=` selectors; return temporary PNG paths for `read`.
- Capture console/page errors and network request results in capped 1,000-entry buffers. Network capture stores headers only, never bodies; default output is terse, while `verbose` or case-insensitive `includeHeaders` opts into curated headers. Reads drain the full buffer by default and `clear: false` peeks.
- Keep automated browser-extension tests browser-free. Use separate live smoke tests only when a Chromium binary is installed, and verify shutdown leaves no Chromium process behind.

## Why

- Live web behavior includes runtime DOM state, browser-generated console errors, actual request headers/statuses, user interactions, and visual output that static source tests cannot establish.
- A single persistent page preserves login/session state across tool calls without adding tab management or unbounded browser resources.
- Default-off tool activation avoids adding browser tool guidance to normal active-tool prompts and avoids loading `playwright-core` until a browser operation starts.
- Input bounds, timeout bounds, header curation, body exclusion, capped buffers, and explicit profile ownership constrain trust-boundary and memory risks.
- Browser-free unit tests keep the normal CI workflow deterministic; Chromium remains a documented manual prerequisite rather than a CI download.

## Affects

Code/config:

- `agent/extensions/browser/index.ts`
- `agent/extensions/browser/package.json`
- `agent/extensions/browser/package-lock.json`
- `agent/extensions/browser/tsconfig.json`
- `agent/extensions/browser/test/test_gate.ts`
- `package.json`
- `package-lock.json`
- `scripts/check-workspace.mjs`

Docs:

- `README.md`
- `docs/engineering/invariants.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/traps.md`
- `docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md`
- `docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md`
- `docs/engineering/decisions/README.md`

## Consequences

- Good: The agent can navigate, inspect, interact with, and screenshot a live web app without asking a human to drive browser tools.
- Good: Persistent profile state supports authenticated flows, while `PI_BROWSER_PROFILE` provides a disposable clean-state escape hatch.
- Good: Browser processes are session-owned and cleanup is exercised on disable and shutdown.
- Good: Console/network memory and exposed headers remain bounded; network bodies are excluded.
- Bad/risk: Chromium is a manual approximately 150 MB prerequisite, and a Playwright/Chromium mismatch can prevent launch.
- Bad/risk: Persistent profiles retain cookies and storage until an operator points `PI_BROWSER_PROFILE` at a disposable directory.
- Tradeoff: Live browser smoke tests require an installed browser; standard unit and CI tests do not.
- Tradeoff: The capability supports exactly one page; tab/window management is intentionally out of scope.

## Read when

- changing browser tool registration or `/browser` gate state
- changing Chromium launch, profile, shutdown, or page ownership
- changing console/network buffers, header exposure, selectors, screenshots, or timeout validation
- changing browser dependencies, bootstrap, package checks, or live-test prerequisites

## Supersedes

- None
