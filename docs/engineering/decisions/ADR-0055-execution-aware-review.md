---
id: ADR-0055
title: Execution-aware review of saved-plan tasks
status: Active
date: 2026-11-12
decision: Pi records execution evidence for each ticked saved-plan task (verified commit, captured Build commands, subagent run summaries, redacted copied diff) in write-once bundles; reviewers in any paired harness read it and submit structured findings through the bridge; findings stay suspected until a human decides in interactive Pi /review; rework runs as follow-up plans citing the findings, and only a non-author may resolve a finding.
why: A reviewer in another harness had only the implementer's claims and free-text tick notes, findings had no home, and nothing stopped an implementer from signing off its own fix.
affects: agent/extensions/workflow-modes/index.ts, agent/extensions/workflow-modes/git.ts, agent/extensions/workflow-modes/plan-state.ts, agent/extensions/workflow-modes/plan-tasks.ts, agent/extensions/workflow-modes/plan-file.ts, agent/extensions/workflow-modes/review-redact.ts, agent/extensions/workflow-modes/review-store.ts, agent/extensions/workflow-modes/review-capture.ts, agent/extensions/workflow-modes/review-bundle.ts, agent/extensions/workflow-modes/review-state.ts, agent/extensions/workflow-modes/plan-template.md, agent/extensions/subagents/launch.ts, agent/extensions/subagents/index.ts, agent/extensions/claude-bridge/index.ts, agent/extensions/claude-bridge/build-lease.ts, agent/extensions/claude-bridge/review-payloads.ts, agent/claude-bridge-client/pi-bridge-mcp.js, agent/harness-commands, agent/extensions/harness-setup/manifest.ts, scripts/security-corpus.json, docs/engineering/architecture.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/dev-workflow.md
consequences: Reviewers can see what changed, how it was tested, and why changes were requested, with references Pi checks; decisions are human-only and an implementer cannot resolve its own fix; evidence is bounded and redacted. Exit codes depend on Pi's error wording, redaction is pattern-based, harness builds leave git-only evidence, findings are session-scoped, and the live seeded-defect acceptance is deferred.
readWhen: changing tick commit or author fields, Build evidence capture, subagent run summaries, evidence bundles or their GC, redaction, reviews.jsonl, finding validation, review states, the /review command, the review bridge operations or recall mode, or the pi-review harness templates
supersedes: None
extends: ADR-0001, ADR-0019, ADR-0026, ADR-0045, ADR-0047
---

# ADR-0055: Execution-aware review of saved-plan tasks

## Decision

- **Scope.** The full proposal is built, adapted to the existing bridge, tracker, and git: Pi-captured evidence, write-once bundles, structured findings with Pi-controlled classification, derived review states, human decisions, and harness review commands. It supersedes the thin slice chosen first in the same discussion (tick commit plus findings only).
- **Snapshot.** A git commit is the code snapshot. `workflow_plan_tick` and bridge `tick_plan_task` take an optional commit, verified by git and stored as the full SHA, and record a host-derived author: `pi`, or `<harness>:<id>` from the bridge's stamped peer. The first tick's note, commit, and author win.
- **Capture.** Only Pi Build is captured: `bash`, `edit`, `write`, and `subagent` calls attach to the tracker's next task as one attempt (baseline = HEAD at the first of them; reads and the tick never open one), and each subagent run emits one redacted summary that attaches when the run started inside the attempt. Harness-lease builds get git-only bundles with an explicit unavailable warning. Abandoned attempts log counts only.
- **Bundles.** After every durable tick, Pi writes a content-addressed (`sha256`), write-once JSON bundle with redacted, bounded, copied hunks (128 KiB, bundle 256 KiB), captured commands, subagent runs, and a warning for every gap, including `incomplete` when the baseline equals the ticked commit. Copying the diff keeps evidence valid after rebase, squash, or GC. A Pi tick waits at most 1 s for the bundle and a bridge tick at most 300 ms; a slower bundle reports `pending` and finishes in the background. No tick fails or reverts because of the bundle.
- **Redaction.** Before any write: values of secret-named env vars, known token shapes, and private-key blocks; hunks for sensitive paths (`.env*`, `*.pem`, `*.key`, `id_*`) are dropped with their path kept.
- **Store.** An append-only, session-scoped `reviews.jsonl` beside the plan bodies holds every review event; finding ids are store-assigned.
- **Findings.** Any paired peer or Pi may submit; every finding and reference is validated against git or a bundle record of the same task, then the whole submit is appended in one write, so it records all its findings or none; each is recorded as suspected. A finding becomes verified only when a human approves it as verified and it has a reference that checks out then.
- **Authority.** Approve, reject, and task approval happen only in interactive Pi `/review` with a literal-true confirm; no bridge operation can make them. Resolve requires an approved finding and a fix commit ticked on a task whose `**Findings:**` metadata cites it, and is refused to the active Build lease holder and to any identity that ticked a task with that commit.
- **Rework and state.** Rework runs as follow-up plans whose tasks cite findings; plan bodies stay immutable. Review state is derived from ticks, bundles, and the log, never stored; `/review` warns from the third rework round.
- **Retention.** Evidence older than 30 days is deleted unless an unresolved finding cites it, and never while the log has unreadable lines; `reviews.jsonl` is never deleted.
- **Surfaces.** Bridge `recall(mode: "review")`, `read_task_evidence`, `submit_review_findings`, and `resolve_review_finding`; Pi tools `review_evidence_read`, `review_findings_submit`, and `review_finding_resolve`; `/pi-review` for Claude, Cursor, and OpenCode and `$pi-review` for Codex. The modules live inside `workflow-modes`, which already owns mode, tracker, and plan storage.

## Why

- A reviewer in another harness had only tick notes and the implementer's word; evidence Pi captured itself, tied to a verified commit, is checkable.
- Git already pins code, so a separate snapshot store would duplicate it; copying the hunks into the bundle covers rewritten history.
- Hooks pass every bridge tool by name, so authority has to be enforced inside Pi from host-stamped identity.
- A bridge tick shares the bridge's fixed 1.5 s wait with commit validation and the durable tick, so a 1 s bundle wait could time out a tick that had already been recorded.
- A submit that wrote finding by finding could stop partway at the log cap and leave part of a batch recorded.
- Rejected: the thin slice (tick commit plus findings only), superseded by the user's choice of full scope.
- Rejected: reopening tasks through a tracker overlay or auto-revised plans with tick carry-over; both change tracker semantics that follow-up plans leave alone.
- Rejected: findings in session branch entries (branch navigation would hide review history) or a project-level store (it crosses the session-scoped plan model).
- Rejected: reviewer-set verified status, a mechanical rule (a stale failing command would verify a fixed claim), and Pi re-running a finding's repro (deferred; it executes reviewer-supplied commands).
- Rejected: a stored review state machine (drift on branch navigation), a hard rework-round cap (the human gate is the limit), keeping all evidence forever, a new thirteenth extension, and an explicit `start_review` operation (reading evidence records it).
- Rejected: the first resolve rule, "anyone but the lease holder", because a review recall releases the holder's own lease; and resolving with any ticked commit, which would let the original task commit "fix" its own finding.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/dev-workflow.md`

Code:

- `agent/extensions/workflow-modes/` (`git.ts`, `review-redact.ts`, `review-store.ts`, `review-capture.ts`, `review-bundle.ts`, `review-state.ts`, `plan-state.ts`, `plan-tasks.ts`, `plan-file.ts`, `index.ts`, `plan-template.md`)
- `agent/extensions/subagents/launch.ts`, `agent/extensions/subagents/index.ts`
- `agent/extensions/claude-bridge/index.ts`, `agent/extensions/claude-bridge/build-lease.ts`, `agent/extensions/claude-bridge/review-payloads.ts`
- `agent/claude-bridge-client/pi-bridge-mcp.js`
- `agent/harness-commands/{claude,cursor,opencode}/pi-review.md`, `agent/harness-commands/codex/pi-review/`, `agent/extensions/harness-setup/manifest.ts`
- `scripts/security-corpus.json`, `scripts/check-package.mjs`

## Consequences

- Good: for any ticked task a reviewer can see the diff, the commands and exit codes, subagent activity, and every gap, and Pi rejects references it cannot check.
- Good: decisions are human-only, findings start suspected, and an implementer cannot resolve its own fix even after its lease ends.
- Good: evidence and logs are bounded, redacted before they are written, write-once or append-only, and covered by a deterministic seeded-defect fixture and 24 corpus cases.
- Bad/risk: exit codes are parsed from Pi's `Command exited with code N`; a wording change degrades them to `null` (a test pins the phrase).
- Bad/risk: redaction misses secrets that match no pattern and no secret-named env var.
- Bad/risk: events are credited to the tracker's next task; off-task work only produces an outside-Files warning.
- Bad/risk: harness-lease builds have no command evidence; findings and evidence are visible only in the Pi session that recorded them.
- Bad/risk: in a slow repository a bridge tick reports `pending` with no bundle id; reviewers get the id from the review overview.
- Bad/risk: a running Pi uses its installed package, so these features appear only after Pi loads this code.
- Bad/risk: live acceptance (Claude plans, Pi builds, Cursor reviews the seeded fixture; pass at two of three defects) is deferred and not yet run.

## Read when

- changing tick commit or author fields, or how Build evidence is captured
- changing subagent run summaries or their redaction
- changing evidence bundles, their size limits, or their GC
- changing redaction rules
- changing `reviews.jsonl`, finding validation, or derived review states
- changing `/review`, the review bridge operations, the review recall mode, or the `pi-review` templates
