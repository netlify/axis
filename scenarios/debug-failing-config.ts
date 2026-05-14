import type { ScenarioInput } from "../dist/index.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants(
  {
    key: "debug-failing-config",
    name: "Debug a failing AXIS configuration",

    setup: [
      {
        action: "run_script",
        command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/debug-failing-config/." .',
      },
    ],

    prompt:
      "Running `axis run` in this directory fails. There are exactly THREE bugs to fix. Find and fix each one without disabling validation, deleting scenarios, or removing the `echo` agent.\n\n" +
      "The three bugs:\n" +
      "  1. The `adapters` map references `./adapters/echo-adapter.ts`, but no file exists at that path. Create a minimal valid adapter file at that path that uses `createAgentAdapter` from `@netlify/axis` in `aggregate` mode and exports a default. The body can be a stub — it does not need to do anything useful.\n" +
      "  2. `scenarios/hello-world.json` uses `criteria` as the field name. The correct AXIS field name is `judge`. Rename it.\n" +
      '  3. The same scenario\'s setup action uses `"action": "run_command"`. The only valid lifecycle action type in AXIS is `run_script`. Fix it.\n\n' +
      "Do not modify any field except the three buggy ones. Do not invent extra fields or remove anything else.",

    judge: [
      {
        check: "File `adapters/echo-adapter.ts` now exists and references `createAgentAdapter` from `@netlify/axis`",
        weight: 0.25,
      },
      {
        check: 'The new adapter file uses `mode: "aggregate"` in its `streamConfig` and has a default export',
        weight: 0.15,
      },
      {
        check:
          "`scenarios/hello-world.json` no longer contains the field `criteria` and now contains a `judge` array with two items",
        weight: 0.25,
      },
      { check: 'The setup action in the scenario now has `"action": "run_script"` (not `"run_command"`)', weight: 0.2 },
      {
        check:
          "The `echo` agent is still listed in `agents` and the `adapters` field in `axis.config.json` is unchanged",
        weight: 0.15,
      },
    ],

    teardown: [{ action: "run_script", command: "rm -rf /tmp/axis-debug" }],
  },
  {
    docsPage: "https://axis.run",
  },
) satisfies ScenarioInput;
