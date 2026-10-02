import type {
  Baseline,
  BaselineComparison,
  BaselineComparisonEntry,
  BaselineEntry,
  MetricComparison,
  MetricDirection,
  MovementVerdict,
} from "../types/baseline.js";
import type { ReportManifest, ReportResultEntry } from "../types/report.js";
import { collectMetricStats, METRICS } from "./metrics.js";
import { welchTTest } from "./significance.js";
import type { SampleStats } from "../types/baseline.js";

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
 * Turn a signed delta into a verdict, accounting for which way is better.
 * A delta inside the tolerance is `unchanged` whichever way it fell.
 */
function verdictFor(delta: number, direction: MetricDirection, tolerance: number): MovementVerdict {
  if (Math.abs(delta) <= tolerance) return "unchanged";
  const better = direction === "higher-is-better" ? delta > 0 : delta < 0;
  return better ? "improved" : "regressed";
}

/**
 * Tolerance for a non-composite metric.
 *
 * Score dimensions share the composite's 0-100 scale, so the same flat floor
 * applies. Duration and tokens do not: a 1 ms or 1 token floor is meaningless,
 * so without a measured spread they fall back to a relative tolerance rather
 * than an absolute one that would flag every run.
 */
function bandForMetric(unbounded: boolean, baselineValue: number, stats?: SampleStats): number {
  const floor = unbounded ? Math.abs(baselineValue) * UNBOUNDED_METRIC_TOLERANCE : NOISE_THRESHOLD;
  if (stats && stats.n > 1) return Math.max(floor, NOISE_SIGMAS * stats.stdev);
  return floor;
}

/** Relative tolerance applied to unbounded metrics with no measured spread. */
const UNBOUNDED_METRIC_TOLERANCE = 0.1;

/**
 * Build the per-metric view: for each metric, the representative delta judged
 * against a tolerance, plus a Welch's t-test over the two distributions when
 * both sides ran more than once.
 */
function buildMetricComparisons(baselineEntry: BaselineEntry, result: ReportResultEntry): MetricComparison[] {
  const currentStats = collectMetricStats(result);
  const comparisons: MetricComparison[] = [];

  for (const metric of METRICS) {
    const current = metric.fromResult(result);
    if (current === undefined) continue;

    const baseline = metric.fromBaseline(baselineEntry);
    const delta = current - baseline;
    const baselineSample = baselineEntry.stats?.[metric.key];
    const currentSample = currentStats?.[metric.key];
    const band = bandForMetric(metric.unbounded ?? false, baseline, baselineSample);

    const comparison: MetricComparison = {
      metric: metric.key,
      label: metric.label,
      direction: metric.direction,
      baseline,
      current,
      delta,
      band,
      bandVerdict: verdictFor(delta, metric.direction, band),
    };

    if (baselineSample && currentSample) {
      const test = welchTTest(baselineSample, currentSample);
      if (test) {
        comparison.significance = {
          baseline: baselineSample,
          current: currentSample,
          delta: test.delta,
          ...(test.t !== undefined ? { t: test.t } : {}),
          df: test.df,
          p: test.p,
          ...(test.effectSize !== undefined ? { effectSize: test.effectSize } : {}),
          ...(test.magnitude !== undefined ? { magnitude: test.magnitude } : {}),
          significant: test.significant,
          // A test that cannot separate the samples reports `unchanged` no
          // matter which way the means fell, so a coin-flip difference is
          // never dressed up as a direction.
          verdict: test.significant ? verdictFor(test.delta, metric.direction, 0) : "unchanged",
        };
      }
    }

    comparisons.push(comparison);
  }

  return comparisons;
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
      metrics: buildMetricComparisons(baselineEntry, result),
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

  // Tallied by statistical significance in parallel, over the composite only.
  // Separate counters rather than a replacement: the exit code reads the
  // flat-band tally, so adding the test cannot change which runs fail CI.
  let sigImproved = 0;
  let sigRegressed = 0;
  let sigUnchanged = 0;
  let tested = 0;

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

    const composite = entry.metrics.find((m) => m.metric === "axisScore")?.significance;
    if (composite) {
      tested++;
      if (composite.verdict === "improved") sigImproved++;
      else if (composite.verdict === "regressed") sigRegressed++;
      else sigUnchanged++;
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
      ...(tested > 0
        ? { significant: { improved: sigImproved, regressed: sigRegressed, unchanged: sigUnchanged } }
        : {}),
    },
  };
}
