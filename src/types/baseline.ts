/**
 * Snapshot of a single scenario×agent score for baseline comparison.
 *
 * For a pair that was run several times, the scores are the representative
 * run's and `stdev` records how far the runs actually spread. That observed
 * noise is what widens the regression band during comparison, so a suite that
 * measures its own variance stops reporting noise as a regression.
 */
export interface BaselineEntry {
  axisScore: number;
  goalAchievement: number;
  environment: number;
  service: number;
  agent: number;
  durationMs: number;
  tokens: number;
  /** Runs behind this entry. Omitted when the pair ran once. */
  runs?: number;
  /** Sample standard deviation of the composite across those runs. Omitted when fewer than two scored. */
  stdev?: number;
  /** Fraction of runs that produced a score, 0-1. Omitted when the pair ran once. */
  reliability?: number;
  fromReportId: string;
  timestamp: string;
}

/** Scenario key → agent name → baseline entry. */
export type BaselineResults = Record<string, Record<string, BaselineEntry>>;

/** A named baseline — accumulated collection of score snapshots. */
export interface Baseline {
  name: string;
  createdAt: string;
  updatedAt: string;
  results: BaselineResults;
}

/** A single row in a baseline comparison. */
export interface BaselineComparisonEntry {
  scenarioKey: string;
  agentName: string;
  baseline: number;
  current: number;
  delta: number;
  /**
   * Tolerance applied to this row: a delta within it counts as unchanged.
   * Widened beyond the flat floor when the baseline measured its own
   * run-to-run spread, so noisy scenarios need a bigger move to count.
   */
  band: number;
  /** Reliability change, when either side ran more than once. */
  reliability?: { baseline: number; current: number; delta: number };
  categories: {
    goalAchievement: { baseline: number; current: number; delta: number };
    environment: { baseline: number; current: number; delta: number };
    service: { baseline: number; current: number; delta: number };
    agent: { baseline: number; current: number; delta: number };
  };
}

/** Result of comparing a report against a baseline. */
export interface BaselineComparison {
  baselineName: string;
  reportId: string;
  entries: BaselineComparisonEntry[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    /** Scenarios in the report that don't exist in the baseline. */
    newScenarios: number;
  };
}
