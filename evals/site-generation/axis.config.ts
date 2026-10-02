import type { AxisConfig } from "../../src/types/index.js";
import { loadSpecs } from "./lib/compile.js";

/**
 * Reference-free, LLM-as-a-judge evals for site generation (Agent Runners).
 * Scenarios are authored as JSON in `specs/` and compiled by `lib/compile.ts`.
 * Everything here rides on existing AXIS hooks (inline scenarios, teardown,
 * artifacts, afterAll), so the AXIS flow itself is unchanged. See README.md.
 *
 *   npx axis run -c evals/site-generation/axis.config.ts
 *
 * Pairwise comparisons across agents come from the agents list: add a second
 * entry with a different model (Model A vs Model B) or adapter flags (Config A
 * vs Config B). Pairwise visual judging lives in `pairwise.config.ts`.
 */
export default {
  name: "Site generation",
  scenarios: loadSpecs(),
  agents: ["claude-code", "codex"],
  judging: {
    agents: [{ agent: "claude-code", model: "claude-opus-5-5" }],
  },
  artifacts: ["site/**", "site-checks.json"],
  settings: {
    limits: {
      scenario: { time_minutes: 15 },
    },
  },
  // Writes metrics.json / metrics.md into the report dir once the report is finalized.
  afterAll: [{ action: "run_script", command: 'npx jiti lib/metrics.ts "$AXIS_REPORT_DIR" --write' }],
} satisfies AxisConfig;
