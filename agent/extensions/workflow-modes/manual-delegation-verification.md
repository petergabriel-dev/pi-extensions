# Manual delegation verification — workflow-modes/subagents

Scope: behavioral acceptance for async delegation guidance and the out-of-process `subagents` extension.

## Delegation policy

- **Discuss quick lookup stays inline:** Focused single-file lookups do not use `subagent`.
- **Plan fan-out delegates to explorer:** Multi-file discovery may use `subagent` with `agent: "explorer"`; parent synthesizes bounded findings.
- **Build uses one worker for substantial work:** Use `subagent` with `agent: "worker"` and explicit `fileOwnership` for one saved-plan task at a time. Parent owns inspection, verification, commits, and confirmation gates.
- **No over-delegation:** Do not delegate trivial lookups or one-line changes.

## Automated verification

Run from repository root after bootstrap:

```bash
npm --prefix agent/extensions/subagents test
npm --prefix agent/extensions/subagents run typecheck
npm run check
git diff --check
git status --short
```

The subagent suite covers RPC framing/commands/UI, per-run IPC authentication and lazy connection, child question/nested-spawn behavior, lifecycle races, watchdogs, progress, failure follow-up, ownership, browser proxying, and teardown. Root `npm test` runs the full configured gate after bootstrap; it does not run the installed-Pi smoke.

## Live RPC acceptance

From repository root, run:

```bash
npm run smoke:subagents
```

The smoke resolves installed Pi through global npm metadata, binds its scripted endpoint and test page to loopback, filters inherited Pi/API-secret environment variables, creates a fresh `0700` `PI_CODING_AGENT_DIR` instead of normal `~/.pi` state, and removes it after the run. It exercises parent-to-explorer launch, a child question answered with `subagent_message`, worker-to-nested-explorer spawn, and browser proxy navigation to a local page. It verifies child-process cleanup and fails if the expected final response does not arrive within 120 seconds. Expect `Subagent RPC smoke passed against installed Pi <version>` and `Browser smoke: PASS`; if Chromium is unavailable, the smoke must print an explicit `Browser smoke: SKIP` while the other checks pass. This checkout's successful live run used installed Pi 1.1.0.

For classified failure-path acceptance, run `npm run smoke:subagents -- --break-final`; expect a nonzero exit with `[protocol]`, no leftover child process, and temporary state cleanup.

## Failure acceptance

The fake RPC child and lifecycle suite cover pre-settle process exit, readiness timeout, handled prompts, abort, late settlement, and side-channel disconnect. Confirm failures remain classified, include a secure log path and bounded tail, and never expose the per-run token. A side-channel disconnect must not fail the child run. Do not retry automatically.

## Teardown

The smoke verifies child-process exit and removes its temporary agent directory. For manual runs, inspect only disposable child processes and Git state:

```bash
ps -axo pid=,command= | grep '[a]gent/extensions/subagents/child.ts' || true
git status --short
```

Terminate only listed disposable child PIDs. Remove only a disposable `PI_CODING_AGENT_DIR` after children exit; never delete normal user state. Runtime sockets, loadouts, logs, sessions, and credentials never belong in Git.
