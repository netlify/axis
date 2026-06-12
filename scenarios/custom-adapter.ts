import type { ScenarioInput } from "../src/types/scenario.js";
import { withSharedVariants } from "./shared/variants.js";

export default withSharedVariants({
  key: "custom-adapter",
  name: "Build and register a custom adapter",

  setup: [{ action: "run_script", command: 'cp -R "$AXIS_CONFIG_DIR/scenario-fixtures/custom-adapter/." .' }],

  prompt:
    "Build a custom AXIS adapter that wraps the toy `adapters/echo.sh` script as if it were an AI agent.\n\n" +
    "1. Create `adapters/echo-adapter.ts` that calls `createAgentAdapter` from `@netlify/axis` (you do NOT need to install the package — just write the code as if it were available).\n" +
    '2. The adapter must spawn `bash adapters/echo.sh "<prompt>"` and capture its full stdout as the assistant response. Since the script emits everything at once, use the `aggregate` streaming mode (NOT `lines`).\n' +
    "3. The module must export the adapter as the default export.\n" +
    "4. Register the adapter in `axis.config.json` under the top-level `adapters` field with the name `echo`, pointing at `./adapters/echo-adapter.ts`. Add `echo` to the `agents` list so it actually runs.",

  judge: [
    { check: "File `adapters/echo-adapter.ts` exists in the workspace", weight: 0.1 },
    {
      check:
        "The adapter file imports `createAgentAdapter` from `@netlify/axis` and calls it (does NOT define a class)",
      weight: 0.2,
    },
    { check: 'The `streamConfig` uses `mode: "aggregate"` (not `"lines"`)', weight: 0.2 },
    { check: "The adapter module exports the result as the default export", weight: 0.1 },
    {
      check: "`axis.config.json` has a top-level `adapters` field mapping `echo` to `./adapters/echo-adapter.ts`",
      weight: 0.2,
    },
    { check: "`agents` array in `axis.config.json` includes `echo`", weight: 0.1 },
    {
      check:
        "The adapter spawns `adapters/echo.sh` (e.g. via `bash` or directly) and uses the resulting stdout as the response",
      weight: 0.1,
    },
  ],
}) satisfies ScenarioInput;
