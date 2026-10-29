---
id: ADR-0030
title: Agent-driven browser verification
status: Active
date: 2026-08-26
decision: Provide gated Pi-native browser verification through one shared persistent context with bounded owner-keyed pages, and a manual `playwright-cli` skill for cross-harness visual verification.
why: Source inspection cannot prove live DOM, browser console, network, interaction, or visual behavior; bounded owner-keyed pages control Pi browser costs, while a local CLI playbook gives non-Pi harnesses an explicit path without bypassing Pi's gate.
affects: agent/extensions/browser/index.ts, agent/extensions/browser/package.json, agent/extensions/browser/package-lock.json, agent/extensions/browser/tsconfig.json, agent/extensions/browser/test/test_gate.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/test/test_agents.ts, agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/test/test_build_design_prompt.ts, agent/agents/explorer.md, agent/agents/worker.md, package.json, package-lock.json, scripts/check-workspace.mjs, README.md, docs/engineering/invariants.md, docs/engineering/architecture.md, docs/engineering/dev-workflow.md, docs/engineering/traps.md, agent/skills/web-debug/SKILL.md, agent/skills/playwright-cli/SKILL.md, agent/skills/playwright-cli/references/cli-commands.md, agent/skills/playwright-cli/references/session-management.md, agent/extensions/harness-setup/manifest.ts, agent/extensions/harness-setup/setup.ts, docs/engineering/decisions/ADR-0050-bundled-design-skills-and-harness-export.md, docs/engineering/decisions/ADR-0004-pi-subagents.md, docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md, docs/engineering/decisions/ADR-0031-subagent-browser-access.md, docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md, docs/engineering/decisions/README.md
consequences: Pi's native browser requires manual `cd agent/extensions/browser && npx playwright install chromium`; cross-harness verification requires manual `npm install -g @playwright/cli@latest` and is never auto-installed. Browser state persists in a Pi-owned profile; owner-keyed pages and capture buffers are bounded, network bodies are never captured, and unit tests remain browser-free.
readWhen: changing browser tools, Chromium or playwright-core setup, browser profile/lifecycle, console/network capture, page actions, screenshot handling, cross-harness `playwright-cli` guidance, or browser package tests
supersedes: None
---

# ADR-0030: Agent-driven browser verification

## Decision

- Ship `agent/extensions/browser/index.ts` as the tenth package extension. Keep browser tools registered but disabled by default; `/browser on` enables the tool surface, `/browser off`/`close`/`kill` disables it and closes the browser, and `/new` resets the gate to off through branch-local `browser:state` entries.
- Launch one persistent Chromium context and create one page lazily per validated owner with `context.newPage()`. The parent owns `parent`; the registry allows the parent plus `DEFAULT_BROWSER_CONCURRENCY_CAP` child pages, currently four total. Resolve the default profile through `getAgentDir()` at `extensions/browser/.profile`; allow `PI_BROWSER_PROFILE` to override it. Owner close, timeout, or abort closes only that page; `/browser off`, `/new`, disabled tree reconstruction, and `session_shutdown` close the context and all pages.
- Declare `playwright-core` in the root runtime dependencies and nested browser development package. Do not download Chromium in CI; require operators to run `cd agent/extensions/browser && npx playwright install chromium` for live verification.
- Expose navigation, evaluation, console, network, fill, click, screenshot, and close tools. Validate bounded inputs and operation timeouts; route CSS, `text=`, and `role=` selectors; return temporary PNG paths for `read`.
- Capture console/page errors and network request results in independent capped 1,000-entry buffers per owner page. Network capture stores headers only, never bodies; default output is terse, while `verbose` or case-insensitive `includeHeaders` opts into curated headers. Reads drain the caller's buffer by default and `clear: false` peeks.
- Expose browser operations to subagents through parent-injected `browser:request`/`browser:result` proxies because child sessions load no extensions. Build receives all eight browser proxies; other workflow modes receive only read-only console, screenshot, and network proxies. Keep automated browser-extension tests browser-free; use separate live smoke tests only when Chromium is installed, and verify shutdown leaves no Chromium process behind.
- Outside Pi, use the bundled `playwright-cli` skill for visual verification. Its one-time prerequisite, `npm install -g @playwright/cli@latest`, is manual and never auto-run. In Pi, prefer native `browser_*` tools and never bypass the `/browser` gate; unavailable CLI or browser means verification is unverified.

## Why

- Live web behavior includes runtime DOM state, browser-generated console errors, actual request headers/statuses, user interactions, and visual output that static source tests cannot establish.
- One shared persistent context preserves login/session state across parent and subagent pages without launching a second Chromium profile or allowing unbounded tabs. Owner-keyed pages prevent one agent's navigation, buffers, timeout, or close operation from disturbing another.
- Default-off tool activation avoids adding browser tool guidance to normal active-tool prompts and avoids loading `playwright-core` until a browser operation starts.
- Input bounds, owner/request correlation, timeout bounds, header curation, body exclusion, capped pages and buffers, and explicit profile ownership constrain trust-boundary and memory risks.
- Browser-free unit tests keep the normal CI workflow deterministic; Chromium remains a documented manual prerequisite rather than a CI download.
- The Pi browser extension is not available in Claude, Cursor, or OpenCode. A pinned local CLI playbook supplies their manual visual-verification path without weakening Pi's native gate.

## Affects

Code/config:

- `agent/extensions/browser/index.ts`
- `agent/extensions/browser/package.json`
- `agent/extensions/browser/package-lock.json`
- `agent/extensions/browser/tsconfig.json`
- `agent/extensions/browser/test/test_gate.ts`
- `agent/extensions/subagents/index.ts`
- `agent/extensions/subagents/test/test_agents.ts`
- `agent/extensions/workflow-modes/index.ts`
- `agent/extensions/workflow-modes/test/test_build_design_prompt.ts`
- `agent/agents/explorer.md`
- `agent/agents/worker.md`
- `package.json`
- `package-lock.json`
- `scripts/check-workspace.mjs`
- `agent/extensions/harness-setup/manifest.ts`
- `agent/extensions/harness-setup/setup.ts`

Docs:

- `README.md`
- `docs/engineering/invariants.md`
- `docs/engineering/architecture.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/traps.md`
- `agent/skills/web-debug/SKILL.md`
- `agent/skills/playwright-cli/SKILL.md`
- `agent/skills/playwright-cli/references/cli-commands.md`
- `agent/skills/playwright-cli/references/session-management.md`
- `docs/engineering/decisions/ADR-0029-consolidated-extension-dev-tooling.md`
- `docs/engineering/decisions/ADR-0004-pi-subagents.md`
- `docs/engineering/decisions/ADR-0031-subagent-browser-access.md`
- `docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md`
- `docs/engineering/decisions/ADR-0050-bundled-design-skills-and-harness-export.md`
- `docs/engineering/decisions/README.md`

## Consequences

- Good: The agent can navigate, inspect, interact with, and screenshot a live web app without asking a human to drive browser tools.
- Good: Persistent profile state supports authenticated flows, while `PI_BROWSER_PROFILE` provides a disposable clean-state escape hatch.
- Good: Browser processes are session-owned; owner cleanup is isolated, while disable and shutdown close the shared context.
- Good: Parent and subagent pages can verify independently; console/network memory and exposed headers remain bounded, and network bodies are excluded.
- Bad/risk: Chromium is a manual approximately 150 MB prerequisite, and a Playwright/Chromium mismatch can prevent launch.
- Bad/risk: Persistent profiles retain cookies and storage until an operator points `PI_BROWSER_PROFILE` at a disposable directory.
- Tradeoff: Live browser smoke tests require an installed browser; standard unit and CI tests do not.
- Good: non-Pi harnesses have offline skill guidance for screenshot-based verification; `/harness` only checks whether the CLI is on PATH and never executes it.
- Bad/risk: users must install the CLI and browser manually. PATH presence does not prove browser readiness, harness skill discovery, or a reviewed visual pass.
- Tradeoff: The capability supports one page per bounded owner, not arbitrary tab/window management; parent and child page output remains isolated by design.

## Read when

- changing browser tool registration or `/browser` gate state
- changing Chromium launch, profile, shutdown, or page ownership
- changing console/network buffers, header exposure, selectors, screenshots, or timeout validation
- changing browser dependencies, bootstrap, package checks, or live-test prerequisites
- changing cross-harness `playwright-cli` guidance, its manual prerequisite, or PATH advisory
- changing subagent browser proxies, owner-scoped pages, workflow-mode browser gating, or explorer capability

## Supersedes

- None
