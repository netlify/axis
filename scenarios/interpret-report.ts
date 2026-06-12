import type { ScenarioInput } from "../src/types/scenario.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "interpret-report",
  name: "Identify the regressed scenario",

  setup: [{ action: "run_script", command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/interpret-report/." .' }],

  prompt:
    "An AXIS report and a baseline already exist in this directory. Read `.axis/baselines/main.json` and `.axis/reports/2026-05-04-1200/report.json`, compare the two, and identify which scenario regressed the most. Write your analysis to `analysis.md` in the workspace root. The analysis must (a) name the regressed scenario, (b) report the AXIS Result delta versus the baseline, and (c) identify which of the four dimensions (Goal Achievement, Environment, Service, Agent) dropped the most and by how much.",

  judge: [
    { check: "File `analysis.md` was created in the workspace root with substantive content", weight: 0.15 },
    { check: "Analysis correctly names `fetch-and-summarize` as the regressed scenario", weight: 0.25 },
    { check: "Analysis cites the AXIS Result delta (84 → 53, a drop of ~31 points)", weight: 0.2 },
    {
      check: "Analysis identifies Service as the dimension that dropped the most (80 → 30, a drop of 50)",
      weight: 0.25,
    },
    { check: "Analysis cites the actual numeric values from the files rather than guessing", weight: 0.15 },
  ],
}) satisfies ScenarioInput;
