---
name: using-axis
description: Run AXIS, read its reports, navigate its project layout, and interpret scores. Use when the user asks to run AXIS, invoke the CLI, run a specific profile or suite, compare runs, explain a score, find a regression, manage baselines, or understand where AXIS writes its files.
---

# Using AXIS

AXIS (Agent Experience Index Score) is a synthetic testing framework for AI agents. This skill is the operator's guide: how to invoke the CLI, where AXIS writes files, and how to read the scoring output.

For authoring scenarios and `axis.config.json`, see the `configure-axis` skill.

## When to use this skill

Trigger phrases include "run AXIS", "run the ask suite", "what does --profile do", "compare runs", "explain this score", "which scenario regressed", "set a baseline", "where does AXIS put its reports", "what does this dimension mean".

Refer to the framework's output as the **AXIS Result**. The acronym is **Agent Experience Index Score**.

## CLI commands

The binary is `axis` (or `npx @netlify/axis` without a global install).

### `axis init`

Scaffold `axis.config.json` and a sample scenario, then install AXIS skills via `npx skills`.

| Flag                     | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `-s, --scenarios <path>` | Scenarios directory (default `./scenarios`)       |
| `-a, --agent <names>`    | Comma-separated agents (e.g. `claude-code,codex`) |
| `--format <format>`      | `json` (default), `js`, or `ts`                   |
| `-f, --force`            | Overwrite existing files                          |
| `--no-skills`            | Skip the automatic skills install                 |

### `axis run`

Execute every scenario against every configured agent in isolated workspaces, score the results, and write a report.

| Flag                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `-c, --config <path>`       | Config path (default discovers `axis.config.{json,js,ts,mjs}`)         |
| `-s, --scenario <keys>`     | Comma-separated keys with glob support (`cms/*`, `hello-*`)            |
| `-a, --agent <names>`       | Comma-separated agent names with glob support (`claude-code\|*`)       |
| `--scenarios` / `--agents`  | Plural aliases for the two options above                               |
| `-p, --profile <name>`      | Apply a named overlay from the config's `profiles` map                 |
| `--concurrency <n>`         | Max parallel jobs (default 15)                                         |
| `--runs <n>`                | Run each pair n times; must be odd (default 1, or `settings.runs`)     |
| `--failed [reportId]`       | Re-run only failed pairs from a prior report (default `latest`)        |
| `--no-score`                | Skip the LLM judges, write raw results only                            |
| `--compare-baseline [name]` | Diff results against a saved baseline (default `main`)                 |
| `--refresh-skills`          | Force re-clone of remote skills cached under `.axis/skills-cache/`     |
| `--refresh-repos`           | Force re-clone of repos cached under `.axis/repos/` for `copy` actions |
| `--json`                    | Emit JSON to stdout instead of the live TTY display                    |
| `-v, --verbose`             | Per-step logging                                                       |
| `--debug`                   | Capture raw agent stdout into `{agent}.debug.ndjson`                   |
| `-o, --output-dir <dir>`    | Also write the report manifest to this directory                       |

`--failed` can be combined with `--profile` (though not with `-s`/`-a`), but retry a report under the profile that produced it: profiles can rename agents and narrow the suite, so pairs from a different suite match nothing and the run exits non-zero having discovered no jobs. A repeated pair is retried in full, not run by run, so the retry report holds a complete sample.

`--runs` must be odd (1, 3, 5, up to 19): an even sample has no middle run, so the median falls between two runs, and at `runs: 2` the representative selection degenerates to "always run 1". Even values error out rather than rounding.

`--runs` trades cost for score stability. Each extra run is a full agent execution plus its four judge calls, so `--runs 3` costs roughly 3x the tokens and 3x the wall clock. Use it for baselines and CI gates, not for every exploratory run. See "Repeated runs" below for how the reported number is chosen.

If the config defines `profiles`, `axis run` runs the default suite and `axis run --profile <name>` swaps in that overlay: usually a different agent matrix and a different slice of scenarios. An unknown profile name is an error, not a fallback to the default suite, so a typo in CI cannot quietly run the wrong suite. `-s` and `-a` narrow within the active suite; neither can reach a scenario the suite excluded. The active profile is recorded in the report manifest as `profile`.

### `axis reports`

View past runs. Three call shapes:

- `axis reports` lists every report in `.axis/reports/` (most recent first; `-n` to cap the list).
- `axis reports <reportId|latest>` shows the manifest for one run, scored summary per scenario.
- `axis reports <reportId|latest> <scenarioKey>` opens the per-run detail (transcript, audits, criteria). Use `-a <agent>` to filter when multiple agents ran the same scenario.

Flags: `--json` for machine output, `--html` to open the rendered report in a browser.

### `axis baseline`

Manage saved baselines for regression detection. A baseline is a snapshot of one report's scenario scores under a name (default `main`).

- `axis baseline set [name]` saves the latest report as a baseline.
- `axis baseline list` lists saved baselines.
- `axis baseline show [name]` prints the saved entries.
- `axis baseline compare [name]` diffs the latest report against the baseline.
- `axis baseline delete [name]` removes a baseline.

`axis run --compare-baseline` combines a fresh run with an immediate diff in one step.

## Expected directories

Everything AXIS writes lives under `.axis/` at the config directory (typically the project root). Source-of-truth files (config, scenarios, skills) are NOT under `.axis/`.

```
project/
├── axis.config.{json,js,ts}        ← config (you author this)
├── scenarios/                      ← scenarios (you author these)
│   └── hello-world.json
├── skills/                         ← optional local skills referenced by config
│   └── <skill-name>/SKILL.md
├── adapters/                       ← optional custom adapter modules
│   └── <name>.{ts,js}
└── .axis/                          ← AXIS-managed, safe to gitignore
    ├── reports/
    │   └── <reportId>/             ← e.g. 2026-06-12-205816
    │       ├── report.json         ← run manifest (summary, results[])
    │       ├── report.html         ← rendered HTML report
    │       └── scenarios/
    │           └── <scenarioKey>/
    │               ├── <agent>.json           ← per-run detail (pair that ran once)
    │               ├── <agent>.raw.ndjson     ← raw transcript
    │               ├── <agent>.sparse-index.txt
    │               └── <agent>/
    │                   ├── artifacts/         ← files captured by scenario.artifacts globs
    │                   └── run-<i>/           ← only when the pair ran more than once
    │                       ├── result.json    ← that run's detail
    │                       ├── raw.ndjson
    │                       ├── sparse-index.txt
    │                       └── artifacts/
    ├── baselines/
    │   └── <name>.json             ← saved baselines (default name: main)
    ├── remotes/                    ← cloned scenarios from remote git URLs
    ├── repos/                      ← repos cloned by `copy` actions (per repo + ref)
    └── skills-cache/               ← cloned remote skills
```

When asked "where is X", the answer is almost always here. Do not search the project tree blindly; jump to the path.

## Scoring framework

Every run is scored on four independent dimensions, each 0-100, combined into a weighted composite.

| Dimension        | Default weight | What it measures                                                   |
| ---------------- | -------------- | ------------------------------------------------------------------ |
| Goal achievement | 0.4            | LLM judge scores the run against the scenario's `judge` checks     |
| Environment      | 0.2            | Execution reliability of filesystem, shell, and network operations |
| Service          | 0.2            | Execution reliability of external service interactions (APIs, MCP) |
| Agent            | 0.2            | Decision quality across every tool call the agent made             |

Override weights in `axis.config.json` under `settings.scoring_weights`.

### Important distinctions

- **Environment and Service evaluate execution reliability only.** Did `ls`, `cat`, `bash`, `fetch`, MCP calls succeed cleanly? They do NOT judge whether the output was useful or task-fit.
- **The Agent dimension is decision quality across every interaction.** Every tool call is an agent choice, even a plain `ls`. The agent judge audits every interaction, not just calls tagged as agent-y.
- **Speed is always heuristic** (threshold buckets per category), never LLM-evaluated. Every other dimension uses an LLM judge.

### Agent sub-dimensions

The agent dimension weights its own sub-dimensions:

| Sub-dimension | Weight | What it captures                                                   |
| ------------- | ------ | ------------------------------------------------------------------ |
| Necessity     | 0.4    | Was the call needed at all? Redundant exploration tanks this hard. |
| Relevance     | 0.2    | Did the call advance the goal?                                     |
| Weight        | 0.2    | Was the call's cost proportionate to its value?                    |
| Success       | 0.1    | Did the call succeed?                                              |
| Speed         | 0.1    | Heuristic speed buckets                                            |

Env and Service sub-dimensions are simpler: success 0.7, speed 0.3, rest 0.

### Composite formula

`axisScore = goal * w_goal + environment * w_env + service * w_svc + agent * w_agent`

### Calibration

All dimensions use log-normal CDF mapping with median 0.5 and sigma 0.4:

| Raw input | Mapped score |
| --------- | ------------ |
| 0.5       | 50           |
| 0.8       | 88           |
| 0.985     | 96           |

Practical consequence: even flawless runs cap around 95-99. Treat 95+ as a top-band result. A clean 100 is structurally near-impossible across all four dimensions.

## Reading a report

`.axis/reports/<reportId>/report.json` has:

- `version`, `reportId`, `timestamp`, `durationMs`
- `summary: { total, completed, failed, averageAxisScore }`
- `results[]`, one entry per (scenario, agent) pair

Each result entry contains:

- `scenarioKey`, `scenarioName`, `agentName`
- `durationMs`, `exitCode`, `tokenUsage: { input, output, cacheReadInput }`
- `score.axisScore` (0-100 composite)
- `score.goalAchievement.{score, criteria[]}` where each criterion has `check`, `weight`, `score`, `rationale`
- `score.environment.{score, dimensions, audits[]}`
- `score.service.{score, dimensions, audits[]}`
- `score.agent.{score, dimensions, audits[]}` (audits every interaction, not just agent-tagged)

Each `dimensions` object has `{ success, speed, weight, relevance, necessity }` mapped to 0-100.

### Repeated runs

A pair configured with `runs > 1` still occupies **one** `results[]` entry. Its `score`, `durationMs`, `tokenUsage`, and `file` describe the **representative run**: the real run whose composite sits nearest the median composite. Because run counts are odd, that run's score _is_ the median, so the headline equals the median of the runs listed in `runs[]`. AXIS never averages composites into a headline, because an average has no transcript behind it to explain.

Three extra fields appear:

- `runCount` -runs configured for the pair (absent when 1).
- `runs[]` -one entry per run: `runIndex`, `axisScore`, `dimensionScores` (the four dimensions), the complete `score`, `durationMs`, `tokenUsage`, `totalCostUsd`, `file`, plus `failed` / `withheld` / `representative` flags. A withheld run publishes no score at all; a failed run publishes its zeros. The representative's `score` is the same as the pair's top-level one.
- `spread` -`axisScore: { median, min, max, mean, stdev }` and `representativeRunIndex`, computed over successful runs only. Per-dimension variance lives in `runs[].dimensionScores`, not here.
- `reliability` -`{ succeeded, total, withheld }`.

`summary.total` / `completed` / `failed` count **pairs**, with `runsTotal` / `runsFailed` alongside them for individual executions. A pair is completed when at least one run scored, failed only when none did.

Reading these correctly:

- Quote the representative's `axisScore` as the pair's result, and quote `spread` when discussing stability. "86, with runs spanning 79 to 91 (sigma 5.1)" is the honest phrasing.
- `reliability.total` excludes withheld runs, so `2/2 scored (1 withheld)` means the agent succeeded on both runs it was actually measured on. Do not report a withheld run as an agent failure.
- Never report a `p` value as if it were an effect size, or the reverse. "p=0.002" says the move is unlikely to be chance; "d=-3.3" says it is large. A move can be significant and trivial (tight runs, tiny gap) or huge and insignificant (scattered runs). Quote both.
- A wide `spread` with a healthy median is a volatility finding, not a quality finding. Say so rather than reporting the median alone.
- When the composite is steady but a dimension is not, compare `runs[].dimensionScores` across runs. "AXIS held at 84 across three runs, but goal achievement ranged 62 to 95" is a finding the composite alone hides.
- Per-run detail lives at `.axis/reports/<reportId>/scenarios/<key>/<agent>/run-<i>/result.json`, but you rarely need it: every run's full score is already in `report.json` under `runs[].score`. The HTML report opens on the representative and lets you select any row to switch the breakdown to that run.

### Diagnosing a low score

Look at which dimension dropped, then inspect:

- **Goal dropped**: read `goalAchievement.criteria[]` and find entries with `score < 10`. The `rationale` says which check the agent failed.
- **Environment dropped**: read `environment.audits[]` and find entries with `success < 1`. Common causes: command-not-found, missing files, network errors.
- **Service dropped**: same as environment but for MCP / API calls. Audit entries point at the specific tool.
- **Agent dropped**: check `agent.dimensions.necessity` first. If it's low, the agent made redundant calls. `agent.dimensions.relevance` low means calls were off-task.

### Comparing against a baseline

Match by `scenarioKey` (variants like `foo@bar` are distinct keys). Subtract `axisScore` from the baseline entry's `axisScore`. The dimension that moved the most is the failure mode.

Each row reports **two** verdicts and you should quote whichever the question calls for.

The **tolerance band** is the simple view: did the representative value move further than the baseline's own measured spread. The **significance test** is Welch's two-sample t-test over both distributions, present only when baseline and current each ran the pair more than once, and reported per metric as `d=` (Cohen's effect size) and `p=`. Markers: `●` significant with a large effect, `◐` significant but smaller, `○` not separable from noise.

The two can disagree, and that is not a bug. At three runs a side the test needs about 2.27 sigma where the band needs 2.00, so the band flags slightly more. The test only becomes the sharper instrument at higher run counts, where it tightens and the band does not.

Significance covers duration and tokens as well as the scores, and its verdicts are direction-aware: duration or tokens going _down_ is an improvement, the same drop in a score dimension is a regression.

The **exit code follows the band**, not the test. `summary.significant` is a separate tally.

Deltas are judged against a per-row noise band, not a flat threshold. The band is `max(1, 2 * stdev)`, where `stdev` is the spread the baseline measured across its own runs; a baseline captured from a single run has no measured sigma and falls back to the 1-point floor. Each comparison row reports the `band` it used, so a large delta counted as unchanged is explainable. A drop in `reliability` is a regression on its own, even when the score holds.

### Citing numbers in analyses

Open the file and read it. Do not invent values.

- "AXIS Result dropped from 84 to 53, a 31-point regression"
- "Service success collapsed from 0.95 to 0.30"
- "Agent necessity was 0.32, meaning roughly 68% of tool calls were judged unnecessary"
- "5 of 7 service interactions returned errors per the audits[] entries"

## Rules you must follow

1. Refer to the framework's output as the **AXIS Result**, never "AXIS Score" (which reads as "score score"). The acronym is **Agent Experience Index Score**, never "eXperience".
2. Do not use em dashes in any prose, comment, or analysis you author. Use a comma, semicolon, colon, parenthesis, or a new sentence instead.
3. When asked to read a report, open the actual file. Do not paraphrase, do not guess at numbers. Cite values verbatim from `report.json` or the per-scenario detail JSON.
4. Treat `95+` as the practical top band. Do not call a 95 result "merely good" or imply 100 is the realistic target; the log-normal calibration makes a clean 100 nearly impossible.
5. Distinguish execution quality (Environment, Service) from decision quality (Agent). They measure different things; using them interchangeably is wrong.
6. When the user asks where AXIS writes something, give the exact path from the directory map above. Do not search.
7. Do not invent CLI flags. The full surface is listed above; if a user asks for something not listed, say so and suggest the closest documented option. `--scenario`/`--scenarios` and `--agent`/`--agents` are interchangeable on `axis run`, but note `axis init --scenarios <path>` is a separate option that sets where the scenarios directory is written.
8. For a repeated pair, never present the median or the representative score as if it were the only number. Quote the spread alongside it, and keep withheld runs out of any reliability claim about the agent: a dead judge is a measurement failure, not an agent failure.
9. Write paths relative to the project root. When you put an AXIS path into a runbook, analysis, plan, or any file you author, spell it as `.axis/reports/<reportId>/report.json`, NOT as an absolute path like `/tmp/axis-xyz/work/.axis/reports/<reportId>/report.json` or `/private/var/.../.axis/...`. Absolute workspace paths leak the agent's isolated temp directory and will not match what the user sees in their own checkout. The only correct form is the project-root-relative path.

## Reference

- Documentation site: https://axis.run
- Scoring source: `src/scoring/` in the netlify/axis repo (deep-eval.ts, category-score.ts, composite.ts, aggregate.ts)
- Report writer: `src/reports/writer.ts`; per-run file layout: `src/reports/paths.ts`
- Companion skill for authoring: `configure-axis`

## Installing this skill

Use the `skills` CLI:

```
npx skills add netlify/axis --all
```

This installs every AXIS skill (`configure-axis`, `using-axis`) into every detected agent config directory. `axis init` runs this automatically; pass `--no-skills` to opt out.
