---
id: ADR-0022
title: Network-allowed read-only Review sandbox
status: Active
date: 2026-07-16
decision: Review Bash is policy-gated before sandbox wrapping; approved commands use a network-enabled sandbox variant with filesystem writes denied.
why: PR review needs GitHub access and controlled review publishing without broad remote-operation or secret-exfiltration risk.
affects: agent/extensions/workflow-modes/sandbox.ts, agent/extensions/workflow-modes/policy.ts, agent/extensions/workflow-modes/index.ts
consequences: Review gains controlled GitHub access, while network-readable secrets and launcher fallback remain risks requiring conservative policy.
readWhen: changing Review mode command policy, sandbox wrapping, fallback behavior, or GitHub review workflows
---

# ADR-0022: Network-allowed read-only Review sandbox

## Decision

- Review Bash is policy-gated before sandbox wrapping.
- Approved Review commands use a sandbox variant with network enabled while filesystem writes remain denied. Seatbelt drops only `(deny network*)`; Bubblewrap drops only `--unshare-net`, retaining its read-only root and scratch setup.
- Review policy allows read commands plus scoped `gh pr view|diff|list|review|comment|status|checks`. Common mutation and redirect denies apply, and Review denies raw network clients and destructive `gh` operations.
- The same scoped policy applies when the launcher is unavailable or wrapping throws; fallback must not admit commands outside the allow-list.
- Discuss and Plan network-denied behavior remains unchanged.

## Why

- PR review needs GitHub read access and controlled review publishing.
- Network access combined with readable secrets creates exfiltration risk, while broad `gh` access creates destructive remote-operation risk; the policy is therefore load-bearing.
- The prompt requires a draft and explicit confirmation before one `gh pr review`, but that confirmation is prompt-enforced rather than a hard hook.

## Affects

Docs:

- `docs/engineering/architecture.md`
- `docs/engineering/invariants.md`
- `docs/engineering/traps.md`
- `docs/engineering/dev-workflow.md`
- `docs/engineering/decisions/ADR-0022-network-allowed-read-only-review-sandbox.md`
- `docs/engineering/decisions/README.md`

Code:

- `agent/extensions/workflow-modes/sandbox.ts`
- `agent/extensions/workflow-modes/policy.ts`
- `agent/extensions/workflow-modes/index.ts`

## Consequences

- Good: Review can inspect pull requests and publish controlled review actions without granting general network or filesystem mutation access.
- Good: Read-only filesystems require review bodies to be inline; there is no body-file workflow.
- Bad/risk: Network plus readable secrets still permits exfiltration if policy is broadened or bypassed.
- Bad/risk: Missing launcher fallback lacks structural sandbox isolation and relies on conservative policy.
- Bad/risk: Live smoke tests require `gh` installation and authentication; tests do not require `gh`.

## Read when

- changing Review mode command policy, sandbox wrapping, fallback behavior, or GitHub review workflows
- changing network-denied Discuss or Plan sandbox behavior

## Supersedes

- None
