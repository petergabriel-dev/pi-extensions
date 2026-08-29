# Manual delegation verification — workflow-modes/subagents

Scope: behavioral acceptance for async delegation guidance and the out-of-process `subagents` extension.

## Delegation policy

- **Discuss quick lookup stays inline:** Focused single-file lookups do not use `subagent`.
- **Plan fan-out delegates to explorer:** Multi-file discovery may use `subagent` with `agent: "explorer"`; parent synthesizes bounded findings.
- **Build uses one worker for substantial work:** Use `subagent` with `agent: "worker"` and explicit `fileOwnership` for one saved-plan task at a time. Parent owns inspection, verification, commits, and confirmation gates.
- **No over-delegation:** Do not delegate trivial lookups or one-line changes.

## Automated verification

Run from repository root with scratch writes outside the repository:

```bash
cd agent/extensions/subagents
TMPDIR=/tmp npm test
npm run typecheck
cd ../../..
npm run check:workspace
npm run check:package
git diff --check
git status --short
```

The subagent suite covers diagnostics permissions/bounds/redaction, bounded versus no-deadline IPC, child question/nested-spawn behavior, cmux fallback and screen capture, progress state, failure follow-up, ownership, browser proxying, and teardown.

## Live cmux acceptance

Run after `/reload` in the active cmux Pi session:

1. Confirm `cmux identify --json` and `cmux new-surface --help` work.
2. Launch one architecture-audit `subagent` with `agent: "worker"`, no edit request, and explicit ownership if needed. Audit task must call `ask_question`, wait for parent input, then report exactly three findings.
3. Confirm launch output identifies `cmux` and reports a Pi-owned diagnostics log path. The new tab must be named and unfocused.
4. Call `subagents_list`. Confirm owner, `running`/`waiting` state, transport, log path, and question ID appear.
5. Leave question unanswered for at least 10 seconds. Confirm child remains `waiting`; parked time must not trigger idle or max-total watchdogs.
6. Reply with matching `subagent_message` owner and question ID. Confirm child resumes and final result arrives as one parent follow-up.
7. Confirm final result closes the cmux surface and no child or failed tab remains.

## Failure acceptance

Use the focused fake-child and injected-cmux tests, or an equivalent disposable run, to force stderr output followed by disconnect. Confirm exactly one failure follow-up includes transport, secure log path, actionable error, and bounded recent output. Confirm the exact IPC token is absent from log, tail, screen snapshot, and displayed failure. Confirm failed cmux surfaces auto-close and headless fallback reports its reason. Do not retry automatically.

## Teardown

After every live run, inspect only disposable runtime state and child processes:

```bash
ps -axo pid=,command= | grep '[a]gent/extensions/subagents/child.ts' || true
find "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/subagents" -type s -print 2>/dev/null || true
cmux list-pane-surfaces --json 2>/dev/null || true
git status --short
```

Terminate only listed disposable child PIDs. Remove only disposable `PI_CODING_AGENT_DIR` contents after children exit. Close any surface left by a failed manual run with `cmux close-surface --surface <surface-ref>`. Runtime sockets, loadouts, logs, sessions, and credentials never belong in Git.
