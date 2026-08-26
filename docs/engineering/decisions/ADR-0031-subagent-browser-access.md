---
id: ADR-0031
title: Subagent browser access
status: Active
date: 2026-08-26
decision: Give subagents owner-scoped browser pages through parent-injected browser:* request/result proxies, with Build-only explorer mutation capability.
why: Child sessions load no extensions, so parent-owned proxies provide browser verification without importing browser state or launching a second persistent context; owner keys, bounded pages, and mode-scoped tool sets preserve isolation and safety.
affects: agent/extensions/browser/index.ts, agent/extensions/subagents/index.ts, agent/extensions/workflow-modes/index.ts, agent/agents/explorer.md, agent/agents/worker.md, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, agent/skills/web-debug/SKILL.md, docs/engineering/decisions/ADR-0004-pi-subagents.md, docs/engineering/decisions/ADR-0030-agent-driven-browser-verification.md, docs/engineering/decisions/ADR-0031-subagent-browser-access.md, docs/engineering/decisions/README.md
consequences: Workers and explorers can verify live pages without sharing parent page state; Build receives all eight browser proxies while other modes receive three read-only proxies; browser page count and buffers remain bounded, but explorers may affect external web state in Build.
readWhen: changing browser page ownership, browser:* proxy events, subagent browser tools, explorer capability validation, or workflow-mode browser gating
supersedes: None
---

# ADR-0031: Subagent browser access

## Decision

- Keep one persistent Chromium context per Pi browser extension and create one lazy Playwright page per validated owner. The parent owns `parent`; each worker or explorer run receives a distinct owner key and page. The registry allows the parent plus `DEFAULT_BROWSER_CONCURRENCY_CAP` child pages, currently four total.
- Expose browser operations across the extension boundary with namespaced `browser:request` and `browser:result` events. Every request carries a validated `requestId`, owner, tool, and params; results must correlate to that request and owner. Requests have bounded waits and return explicit malformed, gate-off, timeout, or operation errors.
- Build the browser proxy tools in the parent `subagents` extension and inject them into child sessions because child loaders disable extensions. Build workers and explorers receive `browser_goto`, `browser_eval`, `browser_console`, `browser_network`, `browser_fill`, `browser_click`, `browser_screenshot`, and `browser_close`.
- In Discuss, Plan, Review, and Design, explorers receive only `browser_console`, `browser_screenshot`, and `browser_network`; console and network clearing is forced false. The parent resolves this mode-scoped set at spawn time, and workflow-modes blocks browser mutations in read-only modes.
- Reap an owner's page on `browser_close`, operation timeout, abort, or subagent exit. Only `/browser off`, `/new`, disabled tree reconstruction, and `session_shutdown` close the shared context and all pages.

## Why

- Child sessions intentionally load no extensions, so direct browser imports or inherited hooks cannot provide safe browser access. Parent-side proxies preserve the extension boundary and keep the browser lifecycle under one owner.
- Separate pages prevent a worker or explorer from navigating, buffering, or closing the parent's page while shared context cookies and storage remain available.
- Explicit owner, request, page, and buffer bounds prevent unbounded browser resources and cross-agent result confusion.
- Build-only explorer mutation access is deliberate: browser verification can affect external web state, but explorers retain repository-read-only enforcement and never receive repository mutation tools.

## Affects

Docs:

- [architecture.md](../architecture.md)
- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [web-debug/SKILL.md](../../../agent/skills/web-debug/SKILL.md)
- [ADR-0004-pi-subagents.md](ADR-0004-pi-subagents.md)
- [ADR-0030-agent-driven-browser-verification.md](ADR-0030-agent-driven-browser-verification.md)
- [ADR-0031-subagent-browser-access.md](ADR-0031-subagent-browser-access.md)
- [README.md](README.md)

Code:

- [browser/index.ts](../../../agent/extensions/browser/index.ts) (page registry, lifecycle, channel owner)
- [subagents/index.ts](../../../agent/extensions/subagents/index.ts) (proxy tools, mode selection, child cleanup)
- [workflow-modes/index.ts](../../../agent/extensions/workflow-modes/index.ts) (browser mutation gate)
- [explorer.md](../../../agent/agents/explorer.md)
- [worker.md](../../../agent/agents/worker.md)

## Consequences

- Good: Workers and explorers can verify live DOM, console, network, actions, and screenshots without importing browser module state or sharing a page.
- Good: Parent-plus-child page caps, per-page 1,000-entry buffers, owner correlation, and bounded waits constrain memory and concurrency.
- Good: Restricted explorers retain repository-read-only tools and cannot drain console/network buffers.
- Bad/risk: Build explorers can cause external browser side effects; the ADR narrows the explorer claim to repository-read-only.
- Bad/risk: A child browser request can fail when the browser gate is off, the page cap is exhausted, Chromium is unavailable, or the bounded channel wait expires.
- Tradeoff: Shared context cookies/storage remain available, but page state and console/network output are intentionally not shared between owners.

## Read when

- changing `browser:request`/`browser:result` payloads or proxy correlation
- changing per-agent page creation, cleanup, caps, or buffers
- changing explorer validation, mode-scoped browser capability, or child extension loading

## Supersedes

- None
