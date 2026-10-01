import type { TokenUsage } from "./agent.js";
import type { AgentConfig } from "./config.js";
import type { DimensionScores, RunReliability, ScoreResult, ScoreSpread } from "./scoring.js";
import type { ArtifactEntry, ResolvedRunConfig, RunSummary, ScenarioLoadFailure } from "./output.js";
import type { ScoredSummary } from "./scoring.js";
import type { JudgeCriterion } from "./scenario.js";

/** Lightweight report manifest — no transcripts, just summary data. */
export interface ReportManifest {
  version: string;
  reportId: string;
  /** Human-readable project name from config. */
  name?: string;
  /** Profile applied to this run, when one was selected with `--profile`. */
  profile?: string;
  timestamp: string;
  durationMs: number;
  summary: ScoredSummary | RunSummary;
  results: ReportResultEntry[];
  /**
   * Files in the scenarios tree that could not be loaded for this run. Kept in
   * the manifest so a report can't look complete while silently covering fewer
   * scenarios than the suite defines.
   */
  loadFailures?: ScenarioLoadFailure[];
}

/**
 * One run of a repeated pair, as recorded in the manifest.
 *
 * Present only when the pair ran more than once. The pair entry's own fields
 * describe the representative run; these describe all of them, so a reader can
 * see the distribution and total spend without opening each result file.
 */
export interface ReportRunEntry {
  /** 1-based index within the pair. */
  runIndex: number;
  durationMs: number;
  exitCode: number;
  /** True when this run failed and was excluded from the pair's aggregate. */
  failed?: boolean;
  /** True when this run's score was withheld because judging failed, not the agent. */
  withheld?: boolean;
  /** Composite for this run. Omitted when unscored or withheld. */
  axisScore?: number;
  /**
   * The run's four dimension scores. Omitted when unscored or withheld.
   *
   * Recorded per run rather than as a set of medians on `spread` so a reader
   * can see which dimension is actually moving. A pair whose composite barely
   * shifts can still be hiding a goal-achievement score that swings 30 points
   * against an agent score that compensates.
   */
  dimensionScores?: DimensionScores;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  error?: string;
  /** Relative path to this run's full result file within the report directory. */
  file: string;
  /**
   * This run's complete score, so the HTML report can switch its breakdown
   * between runs without fetching anything. Omitted when unscored or withheld.
   *
   * The representative run's copy duplicates the pair's top-level `score`.
   * That is deliberate: omitting it on exactly one run would make
   * `runs[i].score` unpredictably absent for anything reading the manifest,
   * and the overhead is one score in N.
   */
  score?: ScoreResult;
  /** True for the one run whose numbers headline the pair. */
  representative?: boolean;
}

/**
 * Summary of a single scenario×agent pair (no transcript).
 *
 * When the pair ran once, every field means exactly what it did before
 * multi-run support existed. When it ran several times, the top-level
 * `score`, `durationMs`, `exitCode`, `tokenUsage`, and `file` all describe the
 * *representative* run, so they stay mutually consistent and drilling into
 * `file` explains the headline score. `runs`, `spread`, and `reliability`
 * describe the set as a whole.
 */
export interface ReportResultEntry {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  durationMs: number;
  exitCode: number;
  /** Failure classification computed before the manifest is flattened. */
  failed?: boolean;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  score?: ScoreResult;
  /** Human-readable error description when the agent fails. */
  error?: string;
  /** Relative path to the full result file within the report directory. */
  file: string;
  /** Total runs configured for this pair. Omitted when the pair ran once. */
  runCount?: number;
  /** Every run of this pair, ordered by `runIndex`. Omitted when the pair ran once. */
  runs?: ReportRunEntry[];
  /** Score spread across the pair's successful runs. Omitted when the pair ran once or none scored. */
  spread?: ScoreSpread;
  /** How many of the pair's runs produced a usable score. Omitted when the pair ran once. */
  reliability?: RunReliability;
  /** The prompt given to the agent. */
  prompt?: string;
  /** Judge criteria used for scoring. */
  judge?: string | JudgeCriterion[];
  /** Agent configuration. */
  agentConfig?: AgentConfig;
  /** Materialized scenario configuration (limits, skills, lifecycle, MCP) actually used for this run. */
  resolvedConfig?: ResolvedRunConfig;
  /** Files captured from the workspace after teardown. Empty/omitted when no artifacts were captured. */
  artifacts?: ArtifactEntry[];
  /** Markdown notes the scenario's setup scripts wrote to `$AXIS_OUTPUT`. */
  setupOutput?: string;
  /** Markdown notes the scenario's teardown scripts wrote to `$AXIS_OUTPUT`. */
  teardownOutput?: string;
}
