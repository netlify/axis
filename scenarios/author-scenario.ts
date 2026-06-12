import type { ScenarioInput } from "../src/types/scenario.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "author-scenario",
  name: "Author a scenario with setup and teardown",

  setup: [{ action: "run_script", command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/author-scenario/." .' }],

  prompt:
    "An AXIS project already exists in this directory. Add a new scenario file at `scenarios/refactor-add.json` that tests whether an agent can refactor a buggy function. The scenario must:\n\n" +
    "1. Use a `setup` lifecycle action to create `/tmp/axis-refactor/math.js` containing a function `add(a, b)` that incorrectly returns `a - b`.\n" +
    "2. Prompt the agent to find and fix the bug, then run the file to verify.\n" +
    "3. Include a `judge` with at least three weighted criteria (weights summing to 1.0) covering: the bug was identified, the fix was applied, and the fix was verified.\n" +
    "4. Use a `teardown` action that removes `/tmp/axis-refactor`.\n\n" +
    "Do not run the scenario — just author the file.",

  judge: [
    { check: "File `scenarios/refactor-add.json` exists in the workspace and contains valid JSON", weight: 0.15 },
    {
      check:
        "Scenario has a `setup` array with a `run_script` action that creates `/tmp/axis-refactor/math.js` with a buggy `add` function",
      weight: 0.2,
    },
    {
      check: "The `prompt` field clearly asks the agent to identify and fix the bug and verify by running",
      weight: 0.15,
    },
    { check: "The `judge` is an array of at least three objects, each with a `check` field", weight: 0.2 },
    { check: "All judge `weight` values are present and sum to approximately 1.0", weight: 0.15 },
    { check: "A `teardown` action exists that removes `/tmp/axis-refactor`", weight: 0.15 },
  ],

  teardown: [{ action: "run_script", command: "rm -rf /tmp/axis-refactor" }],
}) satisfies ScenarioInput;
