import type { ScenarioInput } from "../dist/index.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants(
  {
    key: "explain-score",
    name: "Explain why the Agent dimension scored low",

    setup: [{ action: "run_script", command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/explain-score/." .' }],

    prompt:
      "A scored AXIS report exists at `.axis/reports/2026-05-04-0900/report.json`. The Agent dimension scored 41 while Environment scored 94 and Service scored 91. Read the report, then write an explanation to `score-analysis.md` (in the workspace root) that answers: why did the Agent dimension score so much lower than Environment and Service, even though the agent successfully completed the task? Your answer must distinguish between *execution quality* (what Environment and Service measure) and *decision quality* (what Agent measures), and cite the specific signals from the report that explain the gap.",

    rubric: [
      { check: "File `score-analysis.md` was created in the workspace root with substantive content", weight: 0.15 },
      {
        check:
          "Explanation correctly states that Environment and Service measure execution quality (success and speed of individual calls)",
        weight: 0.2,
      },
      {
        check:
          "Explanation correctly states that the Agent dimension measures decision quality — whether the agent's choices were necessary, relevant, and well-weighted",
        weight: 0.2,
      },
      {
        check: "Explanation cites the low contextRelevance (0.41) and necessity (0.32) signals as the cause of the gap",
        weight: 0.25,
      },
      { check: "Explanation references the redundant calls and duplicate deploy noted in the report", weight: 0.2 },
    ],
  },
  {
    docsPage: "https://axis.run/scoring",
  },
) satisfies ScenarioInput;
