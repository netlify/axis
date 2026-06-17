import type { ScenarioInput } from "../src/types/scenario.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "locate-axis-files",
  name: "Locate AXIS report and baseline files",

  prompt:
    "An AXIS run failed this morning and we want to compare it against the saved `main` baseline. The latest report's reportId is `2026-06-12-205816`, and the scenario that regressed is `cms/create-post@baseline`.\n\n" +
    "Write a runbook to `runbook.md` in the workspace root that lists, with exact relative paths from the project root and exact commands:\n\n" +
    "1. The path to the run manifest for that report.\n" +
    "2. The path to the per-run detail file for the regressed scenario (the agent name is `claude-code`).\n" +
    "3. The path to the `main` baseline file.\n" +
    "4. The one CLI command that performs the comparison automatically (do not write a multi-step procedure).\n" +
    "5. The alternative CLI command that re-runs only the failed pairs from that report.\n\n" +
    "Write paths relative to the project root (starting with `.axis/`), not absolute paths to the current workspace. Use real AXIS paths and real CLI flags. Do not invent paths or flags.",

  judge: [
    { check: "File `runbook.md` exists in the workspace root and has substantive content", weight: 0.1 },
    {
      check:
        "References the run manifest at a path ending in `.axis/reports/2026-06-12-205816/report.json`. The path itself counts whether written as the relative form (`.axis/reports/2026-06-12-205816/report.json`) or as an absolute workspace path that ends in the same suffix.",
      weight: 0.15,
    },
    {
      check:
        "References the per-run detail file at a path ending in `.axis/reports/2026-06-12-205816/scenarios/cms/create-post@baseline/claude-code.json`. Either relative or absolute spelling is fine as long as it ends in that exact suffix.",
      weight: 0.2,
    },
    {
      check:
        "References the baseline at a path ending in `.axis/baselines/main.json`. Either relative or absolute spelling is fine.",
      weight: 0.15,
    },
    {
      check: "Names `axis baseline compare` (or `axis baseline compare main`) as the single comparison command",
      weight: 0.15,
    },
    { check: "Names `axis run --failed` (with the reportId or `latest`) as the failed-rerun command", weight: 0.15 },
    {
      check:
        "Does NOT invent paths such as `.axis/results.json`, `.axis/main.json`, `axis/reports/...`, or `axis-reports/...`",
      weight: 0.05,
    },
    {
      check:
        "Does NOT invent CLI flags or commands such as `axis diff`, `axis compare`, `axis rerun`, or `--baseline-compare`",
      weight: 0.05,
    },
  ],

  artifacts: ["runbook.md"],
}) satisfies ScenarioInput;
