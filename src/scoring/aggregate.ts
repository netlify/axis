/**
 * Aggregation across the repeated runs of one scenario/agent pair.
 *
 * When a pair runs more than once, the report still needs a single headline
 * number. Averaging the composites would produce a score no run ever earned,
 * with no transcript to explain it. Instead a *representative* run is chosen:
 * the real run whose composite sits nearest the median of the pair's
 * composites. Everything a reader drills into afterwards (the transcript, the
 * interaction audits, the sparse index) belongs to that one run, so the
 * headline is always explainable.
 *
 * Because run counts are required to be odd, the median of the composites is
 * itself one of the composites, so the representative's score *is* the median
 * rather than merely being near it. That gives two properties worth having:
 * the headline equals the median of the runs listed directly beneath it in the
 * report, and the live CLI can compute the same pick from `axisScore` alone
 * (see `selectNearestMedian`), so the terminal and the report never disagree.
 *
 * An earlier version selected on distance to the per-dimension medians in
 * four-dimensional space, following Lighthouse CI's `computeRepresentativeRuns`.
 * That was dropped. Lighthouse needs it because its performance score is a
 * nonlinear blend of curve-mapped metrics that genuinely can hide very
 * different profiles behind one number, and it does not surface those metrics
 * at the top level. AXIS composites a plain weighted sum and prints all four
 * dimensions in the row, so the profile is already visible; dimension-space
 * selection bought a run that was typical of the agent's *behaviour* at the
 * cost of a headline that did not match the numbers beside it.
 *
 * Medians rather than means throughout, matching the log-normal calibration
 * already used in `category-score.ts`: these distributions are skewed, so a
 * single outlier run should not drag the number everyone reads.
 */

import { isFailedRun } from "../types/output.js";
import type { RunReliability, ScoredRunResult, ScoreSpread, SpreadStats } from "../types/scoring.js";

/** Identity of a scenario/agent pair, independent of which run produced it. */
export interface PairIdentity {
  scenarioKey: string;
  agentName: string;
}

/** Anything sortable into a pair's run sequence. */
interface RunOrdered extends PairIdentity {
  runIndex?: number;
}

/** Stable map key for a pair. `\x00` cannot appear in a scenario key or agent name. */
export function pairKey(ref: PairIdentity): string {
  return `${ref.scenarioKey}\x00${ref.agentName}`;
}

/**
 * Group per-run results into pairs, preserving first-seen pair order and
 * sorting each pair's runs by `runIndex`. Runs without an index sort first and
 * keep their relative order, which is the single-run case.
 */
export function groupRunsByPair<T extends RunOrdered>(results: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const result of results) {
    const key = pairKey(result);
    const existing = groups.get(key);
    if (existing) existing.push(result);
    else groups.set(key, [result]);
  }
  for (const runs of groups.values()) {
    runs.sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
  }
  return groups;
}

// --- Statistics ---

/**
 * Median of a list. Even-length lists average the two middle values, so the
 * result is a target to measure distance against rather than a value some run
 * is guaranteed to have scored.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sample standard deviation (n-1 denominator). Zero for fewer than two values. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Descriptive statistics for one metric across a pair's successful runs. */
export function computeSpreadStats(values: number[]): SpreadStats {
  if (values.length === 0) {
    return { median: 0, min: 0, max: 0, mean: 0, stdev: 0 };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    median: round2(median(values)),
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round2(mean),
    stdev: round2(stdev(values)),
  };
}

/** Two decimals is enough for a score band and keeps manifests diffable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// --- Run classification ---

/**
 * Split a pair's runs by what their score actually means.
 *
 * The distinction that matters: a run the agent failed is a genuine
 * measurement of the agent and counts against reliability, while a run whose
 * score was *withheld* (the judge died or returned something unparseable) is a
 * measurement failure and must not count against the agent at all. Both arrive
 * here carrying `axisScore: 0` and an error on `metadata`, so they are told
 * apart by the explicit `score.withheld` flag rather than by inspecting error
 * strings.
 */
export function partitionRuns<T extends ScoredRunResult>(runs: T[]): { scored: T[]; failed: T[]; withheld: T[] } {
  const scored: T[] = [];
  const failed: T[] = [];
  const withheld: T[] = [];
  for (const run of runs) {
    if (run.score?.withheld) withheld.push(run);
    else if (isFailedRun(run.output)) failed.push(run);
    else scored.push(run);
  }
  return { scored, failed, withheld };
}

/**
 * Pick the item whose score sits nearest the median of all the scores, with
 * ties broken toward the lowest run index so the choice is deterministic and
 * re-running aggregation on the same data never moves the headline.
 *
 * Generic over the item type because two callers need the identical rule from
 * different shapes: report aggregation runs it over `ScoredRunResult`, and the
 * live CLI runs it over `JobState`, which carries only a composite. Sharing
 * the function is what guarantees the terminal and the report pick the same
 * run rather than two statistics that usually agree.
 *
 * With an odd number of items the median is one of the scores, so the winner's
 * score equals it exactly. With an even number (a pair where some runs failed)
 * the median falls between two items and the lower-indexed of the two central
 * items wins, which is still a real item.
 */
export function selectNearestMedian<T>(
  items: T[],
  scoreOf: (item: T) => number,
  runIndexOf: (item: T) => number,
): T | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];

  const target = median(items.map(scoreOf));
  const ordered = [...items].sort((a, b) => runIndexOf(a) - runIndexOf(b));

  let best = ordered[0];
  let bestDistance = Infinity;
  for (const item of ordered) {
    const distance = Math.abs(scoreOf(item) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

/**
 * Pick the run that represents the pair: the successful run whose composite is
 * nearest the median composite.
 *
 * Only successful runs are candidates, so a crash cannot become the headline
 * and cannot drag the median. Returns undefined when none succeeded, which is
 * the pair-level failure case.
 */
export function selectRepresentative<T extends ScoredRunResult>(runs: T[]): T | undefined {
  const { scored } = partitionRuns(runs);
  return selectNearestMedian(
    scored,
    (run) => run.score.axisScore,
    (run) => run.runIndex ?? 0,
  );
}

/**
 * Composite and per-dimension spread over a pair's successful runs. Failed and
 * withheld runs are excluded, so the band describes the variance of the agent
 * when it works rather than mixing in zeros. Returns undefined when nothing
 * scored.
 */
export function computeSpread(runs: ScoredRunResult[]): ScoreSpread | undefined {
  const { scored } = partitionRuns(runs);
  if (scored.length === 0) return undefined;

  const representative = selectRepresentative(scored);
  return {
    n: scored.length,
    axisScore: computeSpreadStats(scored.map((r) => r.score.axisScore)),
    representativeRunIndex: representative?.runIndex ?? 1,
  };
}

/**
 * How dependable the pair was. `total` counts only the runs that could be
 * measured, so a judge outage shrinks the denominator instead of looking like
 * an agent crash.
 */
export function computeReliability(runs: ScoredRunResult[]): RunReliability {
  const { scored, withheld } = partitionRuns(runs);
  return {
    succeeded: scored.length,
    total: runs.length - withheld.length,
    withheld: withheld.length,
  };
}

/** Everything the report needs about one pair's repeated runs. */
export interface PairAggregate<T extends ScoredRunResult = ScoredRunResult> {
  /** Every run, ordered by `runIndex`. */
  runs: T[];
  /** The run that headlines the pair. Undefined when no run produced a score. */
  representative?: T;
  /** Spread across successful runs. Undefined when none succeeded. */
  spread?: ScoreSpread;
  reliability: RunReliability;
}

/** Aggregate one pair's runs in a single pass. */
export function aggregatePair<T extends ScoredRunResult>(runs: T[]): PairAggregate<T> {
  const ordered = [...runs].sort((a, b) => (a.runIndex ?? 0) - (b.runIndex ?? 0));
  return {
    runs: ordered,
    representative: selectRepresentative(ordered),
    spread: computeSpread(ordered),
    reliability: computeReliability(ordered),
  };
}

/**
 * Aggregate every pair in a flat list of per-run results, keyed by
 * {@link pairKey} and in first-seen pair order.
 */
export function aggregateByPair<T extends ScoredRunResult>(results: T[]): Map<string, PairAggregate<T>> {
  const aggregates = new Map<string, PairAggregate<T>>();
  for (const [key, runs] of groupRunsByPair(results)) {
    aggregates.set(key, aggregatePair(runs));
  }
  return aggregates;
}
