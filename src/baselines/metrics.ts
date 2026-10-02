/**
 * The single definition of what a baseline comparison measures.
 *
 * One table rather than several, because every metric has to be readable from
 * three places: an individual run (to build a distribution), a stored baseline
 * entry, and the current report. Splitting those across modules meant adding a
 * metric in one place and forgetting another, which produced a metric that was
 * compared but never tested, or tested but never shown.
 */

import type { BaselineEntry, MetricDirection, MetricKey, SampleStats } from "../types/baseline.js";
import type { ReportResultEntry, ReportRunEntry } from "../types/report.js";
import { stdev } from "../scoring/aggregate.js";

/** Total tokens a run consumed, across input, output, and cache reads. */
function totalTokens(
  usage: { input?: number; output?: number; cacheReadInput?: number } | undefined,
): number | undefined {
  if (!usage) return undefined;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheReadInput ?? 0);
}

export interface MetricDefinition {
  key: MetricKey;
  /** Display name, e.g. "AXIS Result". */
  label: string;
  direction: MetricDirection;
  /**
   * True when the metric has no fixed scale. Scores run 0-100, so a flat
   * one-point tolerance means something; a one-millisecond or one-token
   * tolerance would flag every run, so those fall back to a relative one.
   */
  unbounded?: boolean;
  /** This metric's value in a single run. */
  fromRun: (run: ReportRunEntry) => number | undefined;
  /** The representative value a baseline persisted. */
  fromBaseline: (entry: BaselineEntry) => number;
  /** The representative value in the current report. */
  fromResult: (result: ReportResultEntry) => number | undefined;
}

/**
 * Every metric compared, with the direction that counts as better.
 *
 * Duration and tokens are why direction has to be explicit: for the four score
 * dimensions a positive delta is an improvement, but spending more time or more
 * tokens to reach the same result is not.
 */
export const METRICS: MetricDefinition[] = [
  {
    key: "axisScore",
    label: "AXIS Result",
    direction: "higher-is-better",
    fromRun: (run) => run.axisScore,
    fromBaseline: (entry) => entry.axisScore,
    fromResult: (result) => result.score?.axisScore,
  },
  {
    key: "goalAchievement",
    label: "Goal Achievement",
    direction: "higher-is-better",
    fromRun: (run) => run.dimensionScores?.goalAchievement,
    fromBaseline: (entry) => entry.goalAchievement,
    fromResult: (result) => result.score?.goalAchievement.score,
  },
  {
    key: "environment",
    label: "Environment",
    direction: "higher-is-better",
    fromRun: (run) => run.dimensionScores?.environment,
    fromBaseline: (entry) => entry.environment,
    fromResult: (result) => result.score?.environment.score,
  },
  {
    key: "service",
    label: "Service",
    direction: "higher-is-better",
    fromRun: (run) => run.dimensionScores?.service,
    fromBaseline: (entry) => entry.service,
    fromResult: (result) => result.score?.service.score,
  },
  {
    key: "agent",
    label: "Agent",
    direction: "higher-is-better",
    fromRun: (run) => run.dimensionScores?.agent,
    fromBaseline: (entry) => entry.agent,
    fromResult: (result) => result.score?.agent.score,
  },
  {
    key: "durationMs",
    label: "Duration",
    direction: "lower-is-better",
    unbounded: true,
    fromRun: (run) => run.durationMs,
    fromBaseline: (entry) => entry.durationMs,
    fromResult: (result) => result.durationMs,
  },
  {
    key: "tokens",
    label: "Tokens",
    direction: "lower-is-better",
    unbounded: true,
    fromRun: (run) => totalTokens(run.tokenUsage),
    fromBaseline: (entry) => entry.tokens,
    fromResult: (result) => totalTokens(result.tokenUsage),
  },
];

/**
 * Per-metric mean, spread, and count across a pair's successful runs.
 *
 * Failed and withheld runs are excluded, matching how `spread` is computed: a
 * crash contributes a zero that would drag every mean down and inflate every
 * variance, describing the suite's flakiness rather than the agent's quality.
 *
 * Returns undefined for a pair with fewer than two usable runs, which has no
 * distribution to record and so cannot take part in a significance test.
 */
export function collectMetricStats(result: ReportResultEntry): Partial<Record<MetricKey, SampleStats>> | undefined {
  const runs = result.runs?.filter((run) => !run.failed && !run.withheld);
  if (!runs || runs.length < 2) return undefined;

  const stats: Partial<Record<MetricKey, SampleStats>> = {};
  for (const metric of METRICS) {
    const values = runs.map(metric.fromRun).filter((value): value is number => value !== undefined);
    if (values.length < 2) continue;
    stats[metric.key] = {
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      stdev: stdev(values),
      n: values.length,
    };
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}
