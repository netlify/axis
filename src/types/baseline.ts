/** Mean, spread, and size of one sample of runs. */
export interface SampleStats {
  mean: number;
  /** Sample standard deviation (n-1 denominator). */
  stdev: number;
  /** Number of observations. */
  n: number;
}

/** How much of a change counts as worth reading, by Cohen's conventions. */
export type EffectMagnitude = "negligible" | "small" | "moderate" | "large";

/** Every metric a baseline comparison can report on. */
export type MetricKey = "axisScore" | "goalAchievement" | "environment" | "service" | "agent" | "durationMs" | "tokens";

/**
 * Which way is better for a metric.
 *
 * The four score dimensions all run 0-100 with higher being better, but
 * duration and token spend are the opposite, so a raw delta's sign cannot be
 * read as good or bad without knowing this.
 */
export type MetricDirection = "higher-is-better" | "lower-is-better";

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
  /**
   * Per-metric distribution across the pair's successful runs, which is what a
   * two-sample significance test needs.
   *
   * Separate from the scalar fields above because those carry the
   * *representative* run's value (so the number on screen always has a
   * transcript behind it) while a t-test compares means. Keeping both means the
   * displayed figure and the tested figure are each honest about what they are.
   *
   * Omitted when the pair ran once, where there is no distribution.
   */
  stats?: Partial<Record<MetricKey, SampleStats>>;
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

/**
 * One metric's movement, reported two ways so a reader can pick.
 *
 * The flat-band verdict is the original behaviour: did the representative
 * value move further than the baseline's own spread. The significance block
 * adds a Welch's t-test over both sides' distributions, which consumes the
 * current run's variance too and tightens as run counts grow. Neither replaces
 * the other, and they can legitimately disagree at small sample sizes.
 */
export interface MetricComparison {
  metric: MetricKey;
  /** Display name, e.g. "AXIS Result". */
  label: string;
  direction: MetricDirection;
  /** The representative values, which is what the tables show. */
  baseline: number;
  current: number;
  /** `current - baseline`, raw and unsigned by direction. */
  delta: number;
  /** Tolerance the flat-band verdict used. */
  band: number;
  /** Direction-aware verdict from the flat band alone. */
  bandVerdict: MovementVerdict;
  /**
   * Welch's t-test over the two distributions. Absent when either side ran
   * fewer than twice, since a single run has no spread to test.
   */
  significance?: MetricSignificance;
}

/** Whether a movement is good, bad, or indistinguishable from noise. */
export type MovementVerdict = "improved" | "regressed" | "unchanged";

/** The statistical view of one metric's movement. */
export interface MetricSignificance {
  baseline: SampleStats;
  current: SampleStats;
  /** Difference of means, which is not the same as the representative delta. */
  delta: number;
  /** Omitted when both samples have zero spread; see `welchTTest`. */
  t?: number;
  df: number;
  p: number;
  /** Cohen's d. Omitted alongside `magnitude` when both samples are perfectly tight. */
  effectSize?: number;
  magnitude?: EffectMagnitude;
  significant: boolean;
  /**
   * Direction-aware verdict. `unchanged` whenever the test could not separate
   * the two samples, regardless of which way the means happened to fall.
   */
  verdict: MovementVerdict;
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
  /**
   * Every metric, each carrying both verdicts. A superset of `categories`
   * below, which is kept so existing consumers of the simple view keep working.
   */
  metrics: MetricComparison[];
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
    /**
     * The same tally by statistical significance rather than by the flat band,
     * counting composite movement only.
     *
     * Reported alongside rather than instead of: the exit code still follows
     * the flat band, so turning the test on cannot silently change which runs
     * fail CI. Omitted when no pair had two runs on both sides.
     */
    significant?: { improved: number; regressed: number; unchanged: number };
  };
}
