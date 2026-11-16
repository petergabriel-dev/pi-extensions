# Benchmark pilot

A small, pre-registered benchmark comparing three ways of using this project's tools: Pi alone (A), Claude Code planning for Pi (B), and B plus Cursor review and one rework round (C), plus a separate review evaluation. The rules are fixed in [PROTOCOL.md](PROTOCOL.md); results go into [REPORT.md](REPORT.md).

Nothing under `bench/` ships in the npm package.

## Layout

| Path | What it is |
|---|---|
| `PROTOCOL.md` | The pre-registered rules. Change only through its Amendments section |
| `bench.ts` | The runner (commands below) |
| `fake-model.ts` | Local scripted model that drives Pi for review fixtures |
| `fixture/app` | The `stock-ledger` app every task starts from |
| `tasks/t1`–`t4` | Coding tasks: `SPEC.md`, `task.json`, `start.patch`, hidden tests, reference `solution.patch` |
| `review/r1`–`r6` | Review fixtures: `SPEC.md`, `impl.patch`, hidden `labels.json` |
| `prices.json` | Dated list prices for cost estimates; empty until you fill it |
| `results/` | Scored rows and redacted artifacts, created by the first `score` |
| `test-bench.ts` | Automated test, run by `npm run test:bench` and `npm test` |

Hidden tests, solutions, and labels are never copied into a run's repository, and agents are never told about them. `score` flags any run whose logs mention them.

## Commands

All commands run from the repository root as `npx --yes tsx bench/bench.ts <command>`.

```
prepare <task> <A|B|C> <rep>      Create run <task>-<wf>-r<rep> outside the repo and print launch steps
                                  (rep s1, s2, ... makes a shakedown run <task>-<wf>-s<n>)
note <run> <kind> [text]          Record start|handoff|gate|intervention|context-miss|timeout|abandon
score <run>                       Run hidden tests on the scored commit and append a results row
check-tasks                       Verify every task: hidden tests fail on start, pass on solution
review-prepare <rN> <bundle|diff> <rep>
                                  Build review run <rN>-<condition>-r<rep>; bundle keeps Pi running
review-stop <run>                 Stop the Pi that review-prepare keeps running for a bundle run
review-run <run> [--model <m>]    Run the Cursor reviewer headless (cursor-agent -p)
review-score <run>                Match findings to hidden labels, append a review row, stop Pi
report                            Rewrite the generated block of REPORT.md from results
```

Runs live in `$PI_BENCH_HOME` (default `~/.pi-bench/runs`), outside the repository, one private folder per run. They hold raw session logs and transcripts: keep them private and never commit them. Only redacted rows and artifacts under `bench/results/` are committed.

## Prerequisites

1. `npm run bootstrap` (review fixtures use the bundled Pi CLI).
2. Pi is logged in to `openai-codex`. Each run's agent folder links to your Pi login (`auth.json`) by symlink; `score` removes the link.
3. Harness setup is installed (`/harness` in Pi), so Claude Code and Cursor have the Pi bridge, `/pi-plan`, and `/pi-review`. `prepare` warns when the installed package version differs from this repository's.
4. `claude` and `cursor-agent` are installed and logged in.
5. **No other Pi session runs during a benchmark run.** It could refresh the shared login at the same moment.
6. `npx --yes tsx bench/bench.ts check-tasks` prints `ok` for t1–t4.
7. Fill `prices.json` from each provider's official pricing page (USD per million tokens), and set `asOf` and `source`. Add a key for every model id that appears in results (`<provider>/<model>` from Pi, `anthropic/<model>` from Claude Code). Leave a price `null` rather than guessing; that cost is then reported as unavailable.

## Standard phrases

Use these exact words, so runs differ only in the workflow:

| When | Type |
|---|---|
| First prompt to the first agent | `Implement the task described in SPEC.md.` |
| Starting Pi Build | `Build the saved plan.` |
| Pi Build asks whether to start or continue a task | `yes` |
| Any agent asks you anything else | `Use your best judgment based on SPEC.md.` — then `note <run> intervention agent question` |
| Workflow C rework plan in Claude Code | `/pi-plan Plan one rework round for the approved review findings.` |

## A coding run

1. `prepare <task> <A|B|C> <rep>` and open the printed terminals (Pi first; then Claude Code for B and C; Cursor for C).
2. `note <run> start` immediately before the first prompt. The 90-minute clock starts here.
3. Follow the workflow below. Record every approval you make as `note <run> gate <what>` and anything else you do as `note <run> intervention <why>`.
4. At every hand-off: `note <run> handoff wait` when one tool finishes its part, and `note <run> handoff go` just before the next tool gets its first prompt.
5. At 90 minutes, stop every agent and run `note <run> timeout`. If a harness crashes, restart it once (an intervention); if the run cannot go on, `note <run> abandon harness-error <why>` (or `tooling-failure <why>` when the bench tooling broke).
6. After the run, compare the saved plan (in the run's `agent/plans/` folder) with `SPEC.md`. For each requirement the plan lacks or contradicts: `note <run> context-miss R<n> missing|altered <why>`.
7. `score <run>`. Only committed work counts.

### Workflow A — Pi alone

1. In Pi: `/mode plan`, then the first prompt.
2. When Pi presents its final plan: `/plan save` (gate).
3. `/mode build`, then `Build the saved plan.`; answer `yes` to each task.

### Workflow B — Claude Code plans, Pi builds

1. In Claude Code: `/pi-plan Implement the task described in SPEC.md.`
2. When asked to save the plan to Pi, choose save (gate).
3. Hand-off: `handoff wait`; in Pi `/mode build`; `handoff go`; `Build the saved plan.`; answer `yes` to each task.

### Workflow C — B plus review

1. Run workflow B to the end.
2. Hand-off to Cursor (`handoff wait`, then `handoff go`) and type `/pi-review`. If Cursor does not find the command, paste the text of `agent/harness-commands/cursor/pi-review.md` instead and note it as an intervention.
3. When Cursor is done: `handoff wait`. In Pi, `/review`, then `/review approve F<n>` for **every** finding, choosing *suspected* (one gate each). Do not judge the findings.
4. If there were findings: `handoff go`; in Claude Code type the rework phrase and save the plan (gate); hand off to Pi and `Build the saved plan.` If there were none, the run ends after the review.
5. One rework round only, and no re-review.

## A review run

Order and repetitions are fixed in PROTOCOL.md section 10.

**Bundle condition** (two terminals):

1. `review-prepare <rN> bundle <rep>`. It builds the run with a scripted Pi Build and keeps Pi running; leave that terminal open.
2. `review-run <rN>-bundle-r<rep>`.
3. `review-score <rN>-bundle-r<rep>`. This also stops Pi.

**Diff condition:** `review-prepare <rN> diff <rep>`, then `review-run` and `review-score` as above.

A bundle review that never reads the evidence is scored invalid; repeat it once with the next rep id and keep both.

**Interactive fallback**, when headless Cursor cannot do the review: for a bundle run, keep `review-prepare` running, open `cursor-agent --model <pinned>` in the run's `repo`, and type `/pi-review`. For a diff run, paste the run's `prompt.md` into an interactive Cursor chat and save its JSON reply as `findings.json` in the run folder. Then `review-score`. Rows without a `review-run` are marked `interactive`.

## Shakedown, then the pilot

1. Shakedown runs use `s` rep ids and are excluded from every table: `prepare t1 A s1`, `prepare t1 B s1`, `prepare t1 C s1`, then `review-prepare r1 bundle s1` and `review-prepare r1 diff s1` (with `review-run … --model <candidate>`).
2. Check that each run scored sensibly: tokens found, hand-off waits recorded, the review parsed. Fix measurement problems before the pilot.
3. Pin the Cursor model: set `CURSOR_MODEL` in `bench.ts`, add a dated entry to PROTOCOL.md Amendments, and commit both.
4. Run the 24 coding runs (reps 1 and 2) and the 24 reviews in the PROTOCOL.md order. Never re-run a run because an agent failed; see PROTOCOL.md section 11 for tooling failures.
5. `report`, then write the hand-written sections of REPORT.md.

Switching to pay-per-use API keys, or growing to 12 tasks, needs the owner's approval of the spending first.

## Reproducing

From a clean checkout: `npm run bootstrap`, meet the prerequisites, then follow *Shakedown, then the pilot*. Every run records the repository commit and tool versions in its `run.json`, and every result row repeats them.
