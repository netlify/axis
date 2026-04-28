import type { Baseline, BaselineDiff, BaselineDiffEntry } from "../types/baseline.js";
import type { ReportManifest } from "../types/report.js";

/** Noise tolerance: deltas within this range are treated as unchanged. */
const NOISE_THRESHOLD = 1;

/**
 * Compare a report against a baseline.
 * Only scenarios×agents present in BOTH baseline and report are compared.
 * Scenarios in report but not baseline are counted as "new" (informational).
 */
export function diffBaseline(baseline: Baseline, report: ReportManifest): BaselineDiff {
  const entries: BaselineDiffEntry[] = [];
  const newScenarioKeys = new Set<string>();

  for (const result of report.results) {
    // Skip unscored or failed results
    if (!result.score || result.error) continue;

    const baselineScenario = baseline.results[result.scenarioKey];
    if (!baselineScenario) {
      newScenarioKeys.add(result.scenarioKey);
      continue;
    }

    const baselineEntry = baselineScenario[result.agentName];
    if (!baselineEntry) {
      // Agent not in baseline for this scenario — treat as new
      newScenarioKeys.add(result.scenarioKey);
      continue;
    }

    const delta = result.score.axisScore - baselineEntry.axisScore;

    entries.push({
      scenarioKey: result.scenarioKey,
      agentName: result.agentName,
      baseline: baselineEntry.axisScore,
      current: result.score.axisScore,
      delta,
      categories: {
        goalAchievement: {
          baseline: baselineEntry.goalAchievement,
          current: result.score.goalAchievement.score,
          delta: result.score.goalAchievement.score - baselineEntry.goalAchievement,
        },
        environment: {
          baseline: baselineEntry.environment,
          current: result.score.environment.score,
          delta: result.score.environment.score - baselineEntry.environment,
        },
        service: {
          baseline: baselineEntry.service,
          current: result.score.service.score,
          delta: result.score.service.score - baselineEntry.service,
        },
        agent: {
          baseline: baselineEntry.agent,
          current: result.score.agent.score,
          delta: result.score.agent.score - baselineEntry.agent,
        },
      },
    });
  }

  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const entry of entries) {
    if (Math.abs(entry.delta) <= NOISE_THRESHOLD) {
      unchanged++;
    } else if (entry.delta > 0) {
      improved++;
    } else {
      regressed++;
    }
  }

  return {
    baselineName: baseline.name,
    reportId: report.reportId,
    entries,
    summary: {
      improved,
      regressed,
      unchanged,
      newScenarios: newScenarioKeys.size,
    },
  };
}
