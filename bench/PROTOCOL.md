# Benchmark Pilot Protocol (pre-registered)

Written 2026-11-16, before any benchmark run. The rules below are fixed from this file's first commit. After the shakedown, any change goes in [Amendments](#13-amendments) with a date and reason; earlier text is never rewritten.

## 1. Purpose and questions

This pilot measures whether the cross-harness setups built in this repository help, compared with Pi working alone. It does not assume multi-agent workflows are better, and its answers apply only to the configurations in [section 3](#3-configurations-under-test), not to multi-agent workflows in general.

| # | Question |
|---|---|
| Q1 | Does a plan from Claude Code, built by Pi (Workflow B), pass more hidden tests than Pi planning and building alone (Workflow A)? Does adding Cursor review and one rework round (Workflow C) pass more than A or B? |
| Q2 | Does a reviewer find more seeded defects, and flag fewer non-defects, when it reads Pi's evidence bundle than when it reads only the git diff? (review evaluation, [section 9](#9-review-evaluation)) |
| Q3 | Do B and C drop or change requirements during hand-offs, or fail as workflows, more often than A? |
| Q4 | How much wall-clock time (agent time and hand-off wait), tokens, and estimated cost does each workflow use? |
| Q5 | Given Q1–Q4, does any workflow's gain justify its extra time and coordination in this pilot? |

Q5 is answered in the report's conclusions from the mechanical results of Q1–Q4; it has no separate formula.

## 2. Scope

- **Coding benchmark:** 4 tasks (`t1`–`t4`) × 3 workflows × 2 repetitions = 24 runs.
- **Review evaluation:** 6 fixtures (`r1`–`r6`) × 2 conditions × 2 repetitions = 24 reviews. It is measured separately and never feeds the coding verdicts.
- **Shakedown first:** task `t1` once in each workflow, plus fixture `r1` once in each review condition. Shakedown checks the tooling. Its results are excluded from the pilot results and listed separately in the report.
- **Expansion:** the 12-task set is considered only if the success rule ([section 8](#8-success-rule-coding-benchmark)) finds a signal, and only after the owner approves any spending.

## 3. Configurations under test

| Role | Tool | Model |
|---|---|---|
| Pi planner and builder | Pi, with this repository's extensions loaded from source (`pi --no-extensions -e <repo>`) | `openai-codex/gpt-6-luna`, thinking level `max` |
| Claude Code planner | Claude Code CLI | Opus (alias `opus`; the exact model id is read from each transcript) |
| Cursor reviewer | Cursor CLI (`cursor-agent`) | Pinned at shakedown and recorded in [Amendments](#13-amendments) |

Each run records the exact versions in its `run.json`: this repository's commit and whether the tree was dirty, Pi, the installed Pi package, Claude Code, Cursor, Node, and the model per role. Runs use the operator's existing subscriptions; no pay-per-use keys.

## 4. Workflows

Every run starts the same way: the repository root holds `SPEC.md`, and the first prompt to the first agent is exactly:

> Implement the task described in SPEC.md.

Nothing given to any agent mentions the benchmark, hidden tests, or other workflows.

- **A — Pi alone.** Pi in Plan mode writes a plan and saves it (`/plan save`). Pi in Build mode implements it, commits, and ticks each task. The run ends when Pi reports the plan done or the cap is reached.
- **B — Claude Code plans, Pi builds.** Claude Code runs `/pi-plan` and saves the plan to Pi (`save_plan`) when the operator confirms. Pi in Build mode implements, commits, and ticks each task.
- **C — B plus review.** After B's build, Cursor runs `/pi-review` on the ticked tasks and submits findings. In Pi, the operator approves **every** finding as suspected (`/review approve F<n>`), with no judgment. Claude Code then runs `/pi-plan` once to write a rework plan whose tasks cite the findings in a `**Findings:**` line, and Pi builds it. There is exactly one rework round and no re-review. If Cursor submits no findings, C ends after the review.

**Operator conduct.** The operator only performs the steps above: hand-offs, saving plans, approving the Build lease, and `/review` approvals. These are *gates*. Anything else is an *intervention* and is recorded with a reason. If an agent asks a question, the operator replies exactly "Use your best judgment based on SPEC.md." and records it as an intervention. A crashed harness is restarted once (an intervention); if the run cannot continue, it is abandoned.

**Tool access.** Each harness keeps its default tools plus the Pi bridge. The operator does not add or remove tools during runs. Harness differences that cannot be normalized are listed in [section 12](#12-threats-to-validity).

## 5. Isolation

- Each run gets a fresh git repository, built from the fixture app and the task's start state, at a unique path outside this repository.
- Each run gets a throwaway Pi agent directory with no memory, plans, or sessions. Its Pi login is a symlink to the host login, never a copy, and it is removed when the run is scored.
- Claude Code starts a new chat in the run repository; the unique path means no project memory carries over. Cursor starts a new chat.
- No other Pi session runs during a benchmark run.
- Workflow order rotates by the fixed schedule in [section 10](#10-run-schedule).

## 6. Budget and scoring

- The operator records `note <run> start` immediately before the first prompt. That starts the clock.
- The cap is **90 minutes** of wall-clock time, the same for every workflow. It includes hand-off waits and C's review and rework. At the cap, the operator stops all agents and records `timeout`.
- The **scored commit** is the last commit on the run repository's first-parent history whose committer date is at or before start + 90 minutes. If there is none, the start state is scored. Uncommitted work is never scored.
- Hidden tests run on a separate copy of the scored commit, outside every agent's reach.
- A run **passes** when every hidden test passes. Hidden test names begin with the requirement id they check (`R1`, `R2`, …), so per-requirement results are recorded too.
- The run's end time is the scored commit's committer date, or the cap for a timed-out run.

## 7. Metrics

When a source does not expose trustworthy data, the value is recorded as `unavailable`, never as 0 or a guess.

| Metric | How it is measured |
|---|---|
| Correctness | Run pass/fail on hidden tests; pass/fail per requirement |
| Workflow reliability | Failures recorded separately from correctness: `timeout`, `no-commit`, `abandon`, `harness-error` (a crash or bridge failure that blocks progress) |
| Wall-clock time | From `start` to the end time; split into hand-off wait and agent time. The operator records `note <run> handoff wait` when one harness finishes its part and `note <run> handoff go` when the next harness gets its first prompt; wait is the sum of wait→go gaps, and agent time is the rest |
| Tokens | Per role and model, from Pi session logs and Claude Code transcripts; Cursor only if it exposes usage |
| Estimated cost | Tokens × list price from `bench/prices.json`, which carries the date the prices were taken from the providers' official pricing pages. Always labeled *estimated*. A model with no price is `unavailable`. Pi's own computed estimate is recorded alongside for comparison |
| Human involvement | Gates and interventions, counted by kind, each with its reason |
| Context preservation | After the plan is saved, the operator compares it with `SPEC.md` and records `note <run> context-miss R<n> <reason>` for each requirement the plan has no task or acceptance criterion for (missing) or contradicts (altered). Per-requirement hidden-test failures are reported next to it |
| Contamination | A run whose logs show access to this repository's `bench/` paths or to hidden test file names is flagged |

## 8. Success rule (coding benchmark)

- Each workflow has 8 runs (4 tasks × 2 repetitions).
- For a pair of workflows X and Y, take per task `d = passes(X) − passes(Y)`. **X beats Y** only if the sum of `d` over the four tasks is at least 2 **and** `d > 0` on at least 2 different tasks. Otherwise the result is **"no meaningful difference"**.
- The verdict is computed for A–B, A–C, and B–C.
- The primary verdict uses every run. The report also shows the verdict without contaminated runs; if the two differ, the report says the verdict is not robust.
- Time, tokens, and cost are reported as medians per workflow and per task, with no verdict.
- No result is described as statistically significant.
- Any "beats" result is a signal that triggers a recommendation to run the 12-task set, subject to the owner's spending approval.

## 9. Review evaluation

**Fixtures.** Six small changes to the fixture app, each with a `SPEC.md`. Four contain one seeded defect each:

1. a logic error caught by a failing visible test,
2. a logic error no test covers,
3. missing error handling,
4. a regression in a caller the change did not touch.

Two are correct. Each seeded defect has a hidden label giving its file and line range. Labels never enter any prompt or run repository.

**Implementation.** Each fixture's change is applied by a scripted Pi Build that uses a local fake model instead of a real one, so every repetition gets the same evidence bundle. The scripted build runs the visible tests as their own command, commits with fixed dates, and ticks with the neutral note "Implemented per SPEC.md."

**Conditions.** The reviewer is the pinned Cursor model in both conditions, and both see the same `SPEC.md` and the same implementation (identical git tree, checked by the tooling).

- **bundle:** Cursor follows `/pi-review`: it reads the evidence through the Pi bridge and submits findings with `submit_review_findings`.
- **diff:** Cursor receives `SPEC.md` and the plain git diff, with no Pi bridge, and prints its findings as JSON with the same fields.

Each review starts from fresh state.

**Matching.**

- A finding is a **true positive** when it names the label's file and its line falls within the label's range ±3 lines. Each label matches at most one finding: the first in submission order.
- A later finding that matches an already-matched label is a **duplicate**. It counts as neither a true nor a false positive.
- A finding with no file, or one that matches no label, is a **false positive**. So is any finding on a correct fixture.
- A diff-condition finding that fails the submit schema is a false positive, recorded with its reason. In the bundle condition, Pi rejects invalid findings, so only recorded findings count.
- A label no finding matches is a **false negative**.
- A bundle-condition review that never reads the evidence is **invalid**. It is reported, then repeated once under a new repetition id; both are kept.

**Measures per condition.** Recall = true positives ÷ seeded labels. Precision = true positives ÷ (true + false positives). False positives on the two correct fixtures are also reported separately.

## 10. Run schedule

Coding runs go in this order, one at a time:

| Repetition | t1 | t2 | t3 | t4 |
|---|---|---|---|---|
| 1 | A, B, C | B, C, A | C, A, B | A, B, C |
| 2 | B, C, A | C, A, B | A, B, C | B, C, A |

Reviews go `r1` to `r6`. In repetition 1, odd fixtures run *bundle* then *diff*, and even fixtures run *diff* then *bundle*; repetition 2 reverses each pair.

## 11. Reporting rules

- Every prepared run appears in the report: scored, failed, timed-out, contaminated, abandoned, invalid, or incomplete. No run is dropped or quietly replaced.
- An agent failure is never re-run.
- A run broken by the benchmark tooling itself (a bench script bug, the machine sleeping, a network outage) may be repeated once under a new repetition id. The original stays in the report, labeled `tooling-failure`.
- Shakedown results are listed separately and excluded from the verdicts.

## 12. Threats to validity

- **Small sample.** 8 runs per workflow and 24 reviews can show only large differences.
- **Author bias.** The same person built the system, wrote the tasks and fixtures, and operates the runs. Mitigations: mechanical rules (approve every finding, the standard reply to questions, the pre-set success rule, hidden tests run outside agents' reach). The tasks may still, unintentionally, suit this repository's tools.
- **Model mix.** Each workflow uses a different mix of models, so a difference may come from the models rather than from the workflow shape.
- **Hand-off latency.** Operator delays sit inside the 90-minute cap for B and C; the wait/agent split reports how much.
- **Unequal harnesses.** Each harness has its own system prompt, tools, and defaults, which cannot be equalized. Workflow C also has extra operator steps.
- **Nondeterminism and load.** LLM output varies between runs, and provider latency and rate limits vary with time of day.
- **Cost comparability.** Providers count tokens differently, and list prices change, so cost is an estimate on a dated price table.
- **Contamination.** Agents can learn this repository's path from loaded extensions and skills and could find hidden tests. Runs are scanned and flagged, not removed.
- **Version drift.** Tools may update during the pilot. Versions are recorded per run; drift is reported.
- **Review realism.** Fixtures are small and synthetic. The diff condition has no reference checking, so malformed findings there count against it. A reviewer run headless may behave differently from one run interactively, so such runs are marked.

## 13. Amendments

Each entry: date, what changed, why, and whether it was before or after the shakedown.

- *None yet.* The Cursor reviewer model will be recorded here at shakedown.
