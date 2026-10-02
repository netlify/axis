import type { AxisConfig } from "../../src/types/index.js";
import { buildPairwiseScenarios, parseTreatment } from "./lib/pairwise.js";

/**
 * Pairwise visual judging between two treatments from finished site-generation
 * reports. The judge model is the agent here; AXIS scoring is skipped.
 *
 *   PAIRWISE_A=latest:claude-code PAIRWISE_B=latest:codex \
 *     npx axis run -c evals/site-generation/pairwise.config.ts --no-score
 *
 * A and B can come from the same report (Model A vs Model B) or from two
 * reports (Config A vs Config B). Win rates land in the pairwise report's
 * `pairwise.md`; re-print with `npx jiti evals/site-generation/lib/pairwise.ts`.
 */
export default () => {
  const a = parseTreatment(process.env.PAIRWISE_A, "PAIRWISE_A");
  const b = parseTreatment(process.env.PAIRWISE_B, "PAIRWISE_B");
  return {
    name: `Pairwise: A=${a.agent} (${a.report}) vs B=${b.agent} (${b.report})`,
    scenarios: buildPairwiseScenarios(a, b),
    agents: [{ agent: "claude-code", model: process.env.PAIRWISE_JUDGE_MODEL ?? "claude-opus-5-5" }],
    settings: { limits: { scenario: { time_minutes: 10 } } },
    afterAll: [{ action: "run_script", command: 'npx jiti lib/pairwise.ts "$AXIS_REPORT_DIR" --write' }],
  } satisfies AxisConfig;
};
