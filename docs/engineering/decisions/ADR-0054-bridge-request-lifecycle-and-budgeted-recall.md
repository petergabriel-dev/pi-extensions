---
id: ADR-0054
title: Bridge request lifecycle and budgeted recall
status: Active
date: 2026-11-11
decision: Bridge requests move requests/ -> inflight/ (Pi claims by atomic rename) -> processed/ + responses/, clients wait in two stages and withdraw unclaimed requests, ambiguous outcomes are reported as outcome_unknown, scans may overlap with the queue bounded by time rather than depth, a client's one read re-send is flagged for the health count, and recall returns query-ranked doc sections and memory entries within a size budget.
why: A single 2 s deadline reported Pi-side commits as bridge-down, missed fs.watch events became timeouts, overlapping scans could run one request twice, and recall sent every engineering doc (723 KB), which overflowed harness tool-result limits.
affects: agent/extensions/claude-bridge/request-queue.ts, agent/extensions/claude-bridge/recall-rank.ts, agent/extensions/claude-bridge/index.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/claude-bridge-client/pi-peer-hook.js, agent/extensions/workflow-modes/index.ts, agent/claude-bridge-client/test-bridge-e2e.mjs, agent/extensions/claude-bridge/test/test_request_queue.ts, agent/claude-bridge-client/test-sessions.js, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md
consequences: Clients can tell not-delivered from may-have-applied, no request runs twice while its answer is retained, retries are counted, and recall fits harness limits; agents read full docs through line pointers, a Pi on older code needs a restart, handlers may interleave, bridge plan state is lost on restart before Pi's first assistant message, and RPC-driven lease approval is an open review item.
readWhen: changing the bridge request directories, claim or replay rules, scan overlap, client deadlines or retries, outcome codes, recall shape or budget, recall ranking, the health ring, or the bridge e2e
supersedes: None
extends: ADR-0001, ADR-0016, ADR-0047
---

# ADR-0054: Bridge request lifecycle and budgeted recall

## Decision

- The directory a request is in is its state: `requests/` (pending), `inflight/` (claimed by Pi through an atomic rename; only the scan that wins the rename runs the handler), `processed/` + `responses/` (answered; `processed/` is the replay cache), `withdrawn/` (the client gave up before Pi claimed it).
- Pi scans on `fs.watch` events plus a 500 ms unref'd poll. The poll clears `withdrawn/` and prunes `processed/` and `responses/` entries older than 10 minutes. Claimed files must be regular `0600` files; over 1 MiB they are answered `payload_too_large` unread.
- Scans are not serialized: watch events start one at most every 50 ms and the poll one every 500 ms, and none waits for a running scan, so a burst runs several handlers interleaved. Each scan handles one file at a time and the rename claim still runs each request once. The queue is bounded by time, not depth: write-side event waits time out at 1.5 s, and anything unclaimed at the client's pickup deadline is withdrawn.
- Clients wait in two stages: a pickup deadline (2 s), after which they rename the request into `withdrawn/` and report `not_delivered` with the exact bridge-down message, then a completion deadline (30 s), after which a claimed request is `outcome_unknown`. Both are configurable; the Claude peer hook uses 1 s + 1 s.
- `outcome_unknown` is never a plain failure. Pi also returns it for leftover `inflight/` requests after a restart (never re-run) and for timed-out write-side event waits. Clients re-send only reads, once, under a new ID; an identical bridge `save_plan` returns the active plan as `idempotent` unless the caller names another `planId`.
- A namespace without `inflight/` is served in legacy mode (one 2 s deadline, no withdraw) until Pi restarts on current code.
- Recall returns only the requested mode's prompt, saved plan, lease, a one-line doc index, and the doc sections and personal-memory entries that best match the query (BM25, H2/H3 sections with `path` and line range), within `max(budget - fixed, 8 KB)`, budget 32 KB by default. The fixed part is never cut; `meta` reports size and omissions. `recall_memory` returns compact text only.
- A 500-entry `health.jsonl` ring (codes, timings, sizes, and boolean `replay`/`retry` flags only) and `/bridge-health` report latency, sizes, and outcome counters. The client marks its one read re-send `retry: true` in the envelope; Pi counts it as `retries`, since the re-send's new ID cannot be linked to the first send.
- A cross-process e2e runs a real headless Pi in RPC mode in CI; its Build lease is approved through Pi's own confirm dialog.

## Why

- The old single deadline could not distinguish "never picked up" from "committed but slow", so a saved plan or tick could be reported as bridge-down and retried blindly.
- The request file stayed in `requests/` while handled, and scans had no in-flight guard, so overlapping scans could run one request twice; the rename claim closes that without a lock file.
- Rejected: client retries with backoff. A server poll covers missed watch events within one interval, and retrying a stuck Pi only multiplies the wait.
- Rejected: a general idempotency-key table. Ticks were already idempotent, and an identical-text check covers the one write a retry could duplicate (`save_plan`).
- Rejected: per-request-type timeouts (a table to maintain that still cannot tell pending from slow) and status files per transition (more writes and formats than folder state).
- Rejected: embeddings or `ccc_search` for recall. BM25 over sections is deterministic, dependency-free, testable against a fixed corpus, and ranks the current 610 KB of docs in under 20 ms.
- Rejected: a test-only lease approval flag. RPC mode has UI, so CI drives the real confirm dialog.
- Rejected: a queue-depth cap answering a new `busy` code. Every client (Claude, Cursor, OpenCode, Codex) would have to handle another outcome code, and the cap would need tuning, while the pickup withdraw already bounds how long a backlog lives.
- Rejected: single-flight scans. One slow handler would block every other request, and the Claude peer hook's 1 s + 1 s deadlines would then fail closed and block writes.
- Rejected: deriving retries from `outcome_unknown` answers. A client already past its completion deadline never re-sends, so the count would be too high.
- Plan amendments: the bridge reliability plan's same-ID retries with backoff and its bridge tool for targeted follow-up reads are resolved by this ADR rather than built. Retries are rejected above, and recall sections carry `path` and line ranges for the agent's own file reads.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/dev-workflow.md`

Code:

- `agent/extensions/claude-bridge/request-queue.ts`
- `agent/extensions/claude-bridge/recall-rank.ts`
- `agent/extensions/claude-bridge/index.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/claude-bridge-client/pi-peer-hook.js`
- `agent/extensions/workflow-modes/index.ts`
- `agent/claude-bridge-client/test-bridge-e2e.mjs`
- `agent/extensions/claude-bridge/test/test_request_queue.ts`
- `agent/claude-bridge-client/test-sessions.js`

## Consequences

- Good: callers can tell `not_delivered` (safe to retry) from `outcome_unknown` (check state first), and a withdrawn request can never run later.
- Good: no request ID runs twice while its answer is retained, including across overlapping scans and restarts.
- Good: recall drops from 723 KB to about 32 KB and fits harness tool-result limits; the e2e exercises the real client/server path in CI.
- Good: `/bridge-health` counts client read retries without putting IDs in the ring, and a 50-request burst test pins single execution across overlapping scans.
- Bad/risk: answers are retained for 10 minutes, so a request ID reused after that would run again; clients use fresh IDs.
- Bad/risk: agents no longer receive full docs in recall and must follow line pointers; ranking quality depends on query words.
- Bad/risk: a Pi on older code keeps old behavior until restarted (legacy mode on the client side).
- Bad/risk: whoever drives a Pi RPC session's stdin can approve a Build lease; whether a harness agent could self-approve that way is an open review item under ADR-0045 and ADR-0047.
- Bad/risk: overlapping scans interleave handlers, so handler code must not assume it runs alone.
- Bad/risk: the `health.jsonl` reload keeps only lines with the current key set, so adding `retry` drops earlier lines once on upgrade.
- Bad/risk: plan state saved and ticked through the bridge stays in memory until the Pi session's first assistant message, because Pi writes no session file before then, so a restart loses it. The e2e makes no model calls, so after its crash restart it checks lease release, not plan survival. Durable bridge plan state is an open follow-up.

## Read when

- changing bridge request directories, claim, replay, retention, or size rules
- changing scan scheduling or overlap, or adding a queue limit
- changing client deadlines, withdraw, retries, or outcome codes
- changing recall's shape, budget, ranking, or the `recall_memory` result format
- changing the health ring or `/bridge-health`
- changing the bridge e2e or how CI approves a Build lease

## Supersedes

- None (extends ADR-0001, ADR-0016, ADR-0047)
