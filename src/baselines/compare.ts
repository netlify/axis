import type { Baseline, BaselineComparison, BaselineComparisonEntry, BaselineEntry } from "../types/baseline.js";
import type { ReportManifest } from "../types/report.js";

/**
 * Floor for the noise tolerance: deltas within it are unchanged even when the
 * baseline recorded no spread of its own (a single-run baseline, which cannot
 * know its own variance).
 */
const NOISE_THRESHOLD = 1;

/**
 * Multiple of the baseline's observed standard deviation to tolerate. Two
 * sigma covers roughly 95% of the run-to-run variation the baseline actually
 * measured, so a move has to clear ordinary noise to count as a regression.
 */
const NOISE_SIGMAS = 2;

/**
 * Tolerance for one row: the flat floor, widened by whatever spread the
 * baseline measured across its own runs.
 *
 * This is the payoff of running scenarios more than once. A single-run
 * baseline can only fall back to the constant, which is why a flaky scenario
 * reports a regression every other run. A baseline built from repeats knows
 * its own sigma and sizes the band from data.
 */
export function noiseBand(entry: BaselineEntry): number {
  return Math.max(NOISE_THRESHOLD, NOISE_SIGMAS * (entry.stdev ?? 0));
}

/**
 * Compare a report against a baseline.
 * Only scenarios×agents present in BOTH baseline and report are compared.
 * Scenarios in report but not baseline are counted as "new" (informational).
 *
 * A row regresses when its score falls further than {@link noiseBand}, or when
 * the pair became less reliable (it used to finish and now sometimes doesn't).
 * Reliability is tracked separately from the score on purpose: an agent that
 * scores 90 on the two runs out of three where it doesn't crash has not held
 * steady, and averaging that into the composite would hide it.
 */
export function compareBaseline(baseline: Baseline, report: ReportManifest): BaselineComparison {
  const entries: BaselineComparisonEntry[] = [];
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

    // Only meaningful when at least one side ran more than once; a single run
    // is either 1 or 0 and would read as a 100% swing.
    const currentReliability =
      result.reliability && result.reliability.total > 0
        ? result.reliability.succeeded / result.reliability.total
        : undefined;
    const baselineReliability = baselineEntry.reliability;
    const reliability =
      currentReliability !== undefined || baselineReliability !== undefined
        ? {
            baseline: baselineReliability ?? 1,
            current: currentReliability ?? 1,
            delta: (currentReliability ?? 1) - (baselineReliability ?? 1),
          }
        : undefined;

    entries.push({
      scenarioKey: result.scenarioKey,
      agentName: result.agentName,
      baseline: baselineEntry.axisScore,
      current: result.score.axisScore,
      delta,
      band: noiseBand(baselineEntry),
      ...(reliability ? { reliability } : {}),
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

  /** Tolerance for reliability drift, so float noise isn't a regression. */
  const RELIABILITY_EPSILON = 0.01;

  for (const entry of entries) {
    // A pair that became flakier is a regression even when the runs that did
    // finish scored as well as ever.
    if (entry.reliability && entry.reliability.delta < -RELIABILITY_EPSILON) {
      regressed++;
    } else if (Math.abs(entry.delta) <= entry.band) {
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
