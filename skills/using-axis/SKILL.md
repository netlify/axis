---
name: using-axis
description: Run AXIS, read its reports, navigate its project layout, and interpret scores. Use when the user asks to run AXIS, invoke the CLI, compare runs, explain a score, find a regression, manage baselines, or understand where AXIS writes its files.
---

# Using AXIS

AXIS (Agent Experience Index Score) is a synthetic testing framework for AI agents. This skill is the operator's guide: how to invoke the CLI, where AXIS writes files, and how to read the scoring output.

For authoring scenarios and `axis.config.json`, see the `configure-axis` skill.

## When to use this skill

Trigger phrases include "run AXIS", "compare runs", "explain this score", "which scenario regressed", "set a baseline", "where does AXIS put its reports", "what does this dimension mean".

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

| Flag                        | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `-c, --config <path>`       | Config path (default discovers `axis.config.{json,js,ts,mjs}`)     |
| `-s, --scenario <keys>`     | Comma-separated keys with glob support (`cms/*`, `hello-*`)        |
| `-a, --agent <names>`       | Comma-separated agent names with glob support (`claude-code\|*`)   |
| `--concurrency <n>`         | Max parallel jobs (default 15)                                     |
| `--failed [reportId]`       | Re-run only failed pairs from a prior report (default `latest`)    |
| `--no-score`                | Skip the LLM judges, write raw results only                        |
| `--compare-baseline [name]` | Diff results against a saved baseline (default `main`)             |
| `--refresh-skills`          | Force re-clone of remote skills cached under `.axis/skills-cache/` |
| `--json`                    | Emit JSON to stdout instead of the live TTY display                |
| `-v, --verbose`             | Per-step logging                                                   |
| `--debug`                   | Capture raw agent stdout into `{agent}.debug.ndjson`               |
| `-o, --output-dir <dir>`    | Also write the report manifest to this directory                   |

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
    │               ├── <agent>.json           ← per-run detail
    │               ├── <agent>.raw.ndjson     ← raw transcript
    │               ├── <agent>.sparse-index.txt
    │               └── artifacts/             ← files captured by scenario.artifacts globs
    ├── baselines/
    │   └── <name>.json             ← saved baselines (default name: main)
    ├── remotes/                    ← cloned scenarios from remote git URLs
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

### Diagnosing a low score

Look at which dimension dropped, then inspect:

- **Goal dropped**: read `goalAchievement.criteria[]` and find entries with `score < 10`. The `rationale` says which check the agent failed.
- **Environment dropped**: read `environment.audits[]` and find entries with `success < 1`. Common causes: command-not-found, missing files, network errors.
- **Service dropped**: same as environment but for MCP / API calls. Audit entries point at the specific tool.
- **Agent dropped**: check `agent.dimensions.necessity` first. If it's low, the agent made redundant calls. `agent.dimensions.relevance` low means calls were off-task.

### Comparing against a baseline

Match by `scenarioKey` (variants like `foo@bar` are distinct keys). Subtract `axisScore` from the baseline entry's `axisScore`. The dimension that moved the most is the failure mode.

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
7. Do not invent CLI flags. The full surface is listed above; if a user asks for something not listed, say so and suggest the closest documented option.
8. Write paths relative to the project root. When you put an AXIS path into a runbook, analysis, plan, or any file you author, spell it as `.axis/reports/<reportId>/report.json`, NOT as an absolute path like `/tmp/axis-xyz/work/.axis/reports/<reportId>/report.json` or `/private/var/.../.axis/...`. Absolute workspace paths leak the agent's isolated temp directory and will not match what the user sees in their own checkout. The only correct form is the project-root-relative path.

## Reference

- Documentation site: https://axis.run
- Scoring source: `src/scoring/` in the netlify/axis repo (deep-eval.ts, category-score.ts, composite.ts)
- Report writer: `src/reports/writer.ts`
- Companion skill for authoring: `configure-axis`

## Installing this skill

Use the `skills` CLI:

```
npx skills add netlify/axis --all
```

This installs every AXIS skill (`configure-axis`, `using-axis`) into every detected agent config directory. `axis init` runs this automatically; pass `--no-skills` to opt out.
