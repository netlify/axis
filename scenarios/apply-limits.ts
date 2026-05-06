import type { ScenarioInput } from "../dist/index.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "apply-limits",
  name: "Apply run and per-scenario limits",

  setup: [
    { action: "run_script", command: "cp -R \"$AXIS_CONFIG_DIR/scenario-fixtures/apply-limits/.\" ." },
  ],

  prompt:
    "An AXIS project exists in this directory. Apply two limits:\n\n" +
    "1. Add an OVERALL run cap of 30 minutes to `axis.config.json`. When this limit is hit, every remaining and in-progress job should be aborted.\n" +
    "2. Add a per-scenario cap to `scenarios/long-task.json` ONLY: 5 minutes and 50,000 tokens.\n\n" +
    "Use the existing AXIS limits configuration shape — do not invent new field names. Do not modify any unrelated fields.",

  rubric: [
    {
      check:
        "`axis.config.json` still parses as valid JSON and preserves the original `scenarios` and `agents` fields",
      weight: 0.15,
    },
    { check: "The config contains `settings.limits.run` with `time_minutes: 30`", weight: 0.3 },
    {
      check:
        "`scenarios/long-task.json` still parses as valid JSON and preserves its `name`, `prompt`, and `rubric` fields",
      weight: 0.15,
    },
    {
      check: "The scenario file has a top-level `limits` object with `time_minutes: 5` and `tokens: 50000`",
      weight: 0.3,
    },
    {
      check:
        "The agent did NOT use any invented limit field names like `timeoutMinutes`, `maxTokens`, or `tokenLimit`",
      weight: 0.1,
    },
  ],
}, {
  docsPage: 'https://axis.run/configuration'
}) satisfies ScenarioInput;
