# Site generation evals

Reference-free, LLM-as-a-judge scenarios for site-building agents (Agent Runners). Everything here is built on hooks AXIS already has (inline scenarios, `teardown`, `artifacts`, `afterAll`, the `-c` flag), so the AXIS flow is unchanged: no edits to `src/`, the repo-root `scenarios/`, `npm test`, or CI.

```bash
npm run build

# Run the evals. Metrics are written to the report dir (metrics.md / metrics.json) when the run ends.
npx axis run -c evals/site-generation/axis.config.ts
npx axis run -c evals/site-generation/axis.config.ts -s 'hard-input/*'

# Re-print metrics, or track them against a baseline
npx jiti evals/site-generation/lib/metrics.ts [report-id|latest] [--by-scenario] [--json]
npx jiti evals/site-generation/lib/metrics.ts --save-baseline main
npx jiti evals/site-generation/lib/metrics.ts --compare main [--threshold 0.05]   # exits 1 on a regression

# Pairwise visual judging between two treatments (see below)
PAIRWISE_A=latest:claude-code PAIRWISE_B=latest:codex \
  npx axis run -c evals/site-generation/pairwise.config.ts --no-score

# Judge calibration against human labels (see below)
npx jiti evals/site-generation/lib/calibrate.ts template latest --sample 60
npx jiti evals/site-generation/lib/calibrate.ts score evals/site-generation/golden/<report-id>.json

# This folder's own tests (not part of npm test)
npx vitest run --config evals/site-generation/vitest.config.ts
```

## Layout

| Path                     | What's in it                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `specs/**/*.json`        | One scenario per file. The file path is the scenario key.               |
| `rubric/core.json`       | Checks every site gets: functional, JS errors, mobile, a11y, visual     |
| `rubric/site-types.json` | Table-stakes checklists per kind of site (local business, event, …)     |
| `rubric/audits.json`     | Reusable precision audits, e.g. `facts`                                 |
| `fixtures/`              | Files copied into the workspace by a spec's `setup` (e.g. an upload)    |
| `lib/compile.ts`         | Turns specs + rubric into AXIS scenarios. You shouldn't need to edit it |
| `lib/checks.mjs`         | Script checks, run in each workspace at teardown                        |
| `lib/metrics.ts`         | Recall / precision / F1 / pass rate per vertical, plus baselines        |
| `lib/pairwise.ts`        | Builds pairwise scenarios and summarizes win rates                      |
| `lib/calibrate.ts`       | Golden-label templates and judge-vs-human agreement                     |
| `baselines/`, `golden/`  | Created on first use. Commit them to track metrics and labels over time |

## How it hooks into AXIS

```
agent builds ./site/ → AXIS judge grades tagged checks → teardown: checks.mjs → artifacts captured → afterAll: metrics.ts --write
```

| Capability             | AXIS hook used                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| JSON specs             | `scenarios` accepts inline scenarios from `axis.config.ts`                                                                    |
| Recall/precision/pass  | Tagged judge criteria; counts parsed from the report's per-check grades                                                       |
| Script checks          | Scenario `teardown` writes `site-checks.json`, captured via `artifacts`; also summarized in the report through `$AXIS_OUTPUT` |
| Metrics after each run | `afterAll` with `$AXIS_REPORT_DIR`                                                                                            |
| Pairwise judging       | A second config whose agent is the judge; `setup` copies the two saved sites                                                  |
| Baselines, calibration | Scripts that read finished reports                                                                                            |

## Writing a spec

```json
{
  "name": "Local business site from a complete brief",
  "about": "Note for humans. Not sent to the agent or the judge.",
  "site_type": "local-business",
  "prompt": ["Lines are joined with spaces.", "So long prompts stay readable."],
  "picker": [{ "question": "Pick a style", "answer": "Warm & organic" }],
  "setup": [{ "action": "copy", "match": "fixtures/uploaded-logo/*", "destination": "uploads" }],
  "rubric": {
    "recall": { "content": ["The business name \"Crumb & Co.\", written exactly"] },
    "precision": ["facts"],
    "pass": { "input-handling": ["The site has no blog section"] }
  }
}
```

Everything except `name`, `prompt`, and `rubric` is optional. The compiler adds the site type's table stakes and the core checks, appends the picker selections plus an output contract (build static files in `./site/`) to the prompt, and adds the script checks to `teardown`. Unknown fields, site types, audits, or verticals fail loudly.

## Metrics instead of weights

There are no weights. The judge makes a yes/no call on every item and the metrics are computed from the counts:

| Metric        | Source             | What's counted                                                                                                                                   | Formula                               |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Recall**    | judge, `recall`    | PRESENT or MISSING for each item that should be on the site                                                                                      | present / listed                      |
| **Precision** | judge, `precision` | Every matching item on the site, labelled SUPPORTED, PLACEHOLDER, UNSUPPORTED                                                                    | supported / (supported + unsupported) |
| **F1**        | —                  | Balances precision and recall, for verticals that have both                                                                                      | 2PR / (P + R)                         |
| **Pass**      | judge, `pass`      | PASS or FAIL for each conformance check                                                                                                          | passed / listed                       |
| **Check**     | `checks.mjs`       | Exact counts: refs that resolve, scripts that parse, pages with viewport/lang/one h1/landmarks, images with alt, declared color pairs meeting AA | passed / inspected                    |

- Placeholders are left out of precision, so `[Your phone]` isn't penalised but a realistic invented phone number is.
- Precision audits have to write `supported=N placeholder=N unsupported=N` at the start of their rationale. If the judge skips it, the metric falls back to the 0–10 score and is marked `~`.
- Counts are pooled across runs and scenarios, so repeated runs tighten the numbers instead of averaging averages.
- `pass` and `check` overlap on purpose for mobile, accessibility, functional, and JS errors: where the judge and the script disagree, one of them is wrong.
- `checks.mjs` reads HTML/CSS without a browser. It counts what's declared (e.g. color pairs set in the same CSS rule), not what renders.
- The AXIS goal score still gets computed (it's now the share of checks met), but the numbers to read are the per-vertical ones.

Verticals: `content`, `table-stakes`, `input-handling`, `imagery`, `functional`, `js-errors`, `mobile`, `accessibility`, `visual`.

## Comparing treatments

**Per-vertical metrics.** Add agent entries to `axis.config.ts`: the same adapter with two models (Model A vs Model B), or the same model with different flags (Config A vs Config B). `metrics.ts` prints one column per agent. The judge is pinned to one model so every treatment is graded the same way.

**Pairwise visual judging.** `pairwise.config.ts` takes two treatments as `<report>:<agent>`, from one report or two. For each brief both treatments built a site for, the judge (running as the agent, default `claude-opus-5-5`, override with `PAIRWISE_JUDGE_MODEL`) gets both sites as `left/` and `right/`. It picks a winner on typography, spacing, composition, color, overall, and fit-to-brief. Every brief is judged twice with the sides swapped:

- win rate counts ties as half;
- `order-consistent` shows how often both orderings agreed. A low value means the judge is favouring a position, not a site.

Results land in the pairwise report's `pairwise.md`; re-print with `npx jiti evals/site-generation/lib/pairwise.ts [report]`. Pairwise runs share `.axis/reports/` with normal runs, and `latest` picks the right kind for each script.

**Baselines.** `--save-baseline <name>` snapshots per-vertical metrics into `baselines/<name>.json`. `--compare <name>` prints deltas and exits 1 if any metric drops more than `--threshold` (default 0.05), so it can gate CI on e.g. accessibility without averaging it into content.

## Calibrating the judge

1. `calibrate.ts template <report> [--sample N]` writes `golden/<report-id>.json` with one label per check. It copies the sites into `golden/<report-id>/sites/` so the set outlives `.axis/`, and leaves out the judge's verdicts so labellers aren't anchored by them.
2. People fill in `human`: `true`/`false` for recall and pass checks, `{"supported": N, "unsupported": N}` for audits.
3. `calibrate.ts score <golden file>` reports, per vertical:
   - the judge's accuracy, precision, recall, and Cohen's κ (agreement with humans corrected for chance) on yes/no checks;
   - the mean gap between judge and human precision on audits.

A vertical with low κ isn't ready to be trusted, whatever its score says.
