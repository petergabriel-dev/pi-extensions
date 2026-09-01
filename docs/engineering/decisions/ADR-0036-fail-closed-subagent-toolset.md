---
id: ADR-0036
title: Fail-closed subagent toolset policy
status: Active
date: 2026-09-01
decision: Enforce a closed read-only tool allowlist for non-Build subagent launches and retain Build as the unrestricted mode.
why: A closed allowlist blocks unenumerated host tools such as powershell without mirroring a host registry, at the cost of refusing external definitions that name unlisted tools outside Build.
affects: agent/extensions/subagents/policy.ts, agent/extensions/subagents/index.ts, agent/extensions/subagents/test/test_policy.ts, agent/extensions/subagents/test/test_agents.ts, agent/agents/explorer.md, agent/agents/worker.md, docs/engineering/invariants.md, docs/engineering/traps.md, docs/engineering/decisions/README.md
consequences: Restricted launches fail closed against unknown tools while Build behavior remains unchanged; external definitions using unlisted tools require allowlist review.
readWhen: changing subagent tool validation, browser proxy loadouts, agent definitions, or workflow-mode launch gates
supersedes: None
---

# ADR-0036: Fail-closed subagent toolset policy

## Decision

- Define `REPOSITORY_READ_ONLY_TOOLS` as `read`, `grep`, `find`, and `ls` in `agent/extensions/subagents/policy.ts`.
- Permit only those repository tools, `ask_question`, optional nested `subagent`, and restricted browser proxies outside Build. Normalize tool names by trimming and lowercasing before membership checks.
- Return early for Build mode. Refuse every other tool outside Build, naming each offending tool and the restricted mode in the error.
- Derive explorer validation and browser-proxy exports from the shared policy constants rather than maintaining duplicate tool lists in `index.ts`.

## Why

The former mutation denylist was fail-open: it could not refuse a host tool that was absent from its inventory, such as `powershell`. Patching the denylist with `powershell` alone was rejected because each future host tool would recreate the gap. Mirroring the host tool registry was rejected because it couples this safety boundary to host implementation details and registry drift. The closed allowlist accepts a compatibility cost: external agent definitions naming an unlisted tool refuse outside Build, even when that tool is benign or read-only, until the policy explicitly lists it.

## Affects

Docs:

- [invariants.md](../invariants.md)
- [traps.md](../traps.md)
- [ADR-0034-async-out-of-process-subagents.md](ADR-0034-async-out-of-process-subagents.md)
- [decisions index](README.md)

Code:

- [policy.ts](../../../agent/extensions/subagents/policy.ts)
- [index.ts](../../../agent/extensions/subagents/index.ts)
- [test_policy.ts](../../../agent/extensions/subagents/test/test_policy.ts)
- [test_agents.ts](../../../agent/extensions/subagents/test/test_agents.ts)
- [explorer.md](../../../agent/agents/explorer.md)
- [worker.md](../../../agent/agents/worker.md)

## Consequences

- Good: Unknown or unenumerated host tools cannot enter restricted subagent loadouts through a fail-open gap.
- Good: Bundled `explorer` and `worker` definitions retain their current behavior; shared constants keep explorer and browser-proxy policy aligned.
- Bad/risk: External definitions using an unlisted tool begin refusing outside Build, including definitions that intended only benign or read-only behavior.
- Bad/risk: New tools require an explicit policy decision and test coverage before restricted launches can use them; Build remains unrestricted by this gate.

## Read when

- changing `validateSubagentToolset()` or restricted-mode capability policy
- adding host tools, browser proxies, or bundled/external agent definitions
- changing workflow-mode gates for subagent launch

## Supersedes

- None
