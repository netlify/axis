/* Self-contained type definitions for report rendering.
   Mirrors the main package types but avoids cross-project imports. */

export interface ReportData {
  version: string;
  reportId: string;
  /** Human-readable project name from config. */
  name?: string;
  timestamp: string;
  durationMs: number;
  summary: ScoredSummary | RunSummary;
  results: ResultEntry[];
  /** Files in the scenarios tree that could not be loaded for this run. */
  loadFailures?: ScenarioLoadFailure[];
}

/** A file that was meant to load as a scenario but could not. */
export interface ScenarioLoadFailure {
  path: string;
  reason: string;
}

export interface RunSummary {
  total: number;
  completed: number;
  failed: number;
  /** Scenarios deliberately opted out via `skip: true`. */
  skipped?: number;
  /** Files in the scenarios tree that could not be loaded. */
  loadFailed?: number;
}

export interface ScoredSummary extends RunSummary {
  averageAxisScore: number;
}

/** One run of a repeated scenario/agent pair. */
export interface RunEntry {
  runIndex: number;
  durationMs: number;
  exitCode: number;
  failed?: boolean;
  /** True when the score was withheld because judging failed, not the agent. */
  withheld?: boolean;
  axisScore?: number;
  /** The run's four dimension scores. Omitted when unscored or withheld. */
  dimensionScores?: DimensionScores;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  error?: string;
  /** Report-relative path to this run's full result file. */
  file: string;
  /** This run's complete score, so the breakdown can switch between runs. Omitted when unscored or withheld. */
  score?: ScoreResult;
  /** True for the run whose numbers headline the pair. */
  representative?: boolean;
}

/** Descriptive statistics for one metric across a pair's successful runs. */
export interface SpreadStats {
  median: number;
  min: number;
  max: number;
  mean: number;
  stdev: number;
}

/** A run's four dimension scores, 0-100 each. */
export interface DimensionScores {
  goalAchievement: number;
  environment: number;
  service: number;
  agent: number;
}

/** Spread across the repeated runs of one pair. */
export interface ScoreSpread {
  n: number;
  axisScore: SpreadStats;
  representativeRunIndex: number;
}

/** How many of a pair's runs produced a usable score. */
export interface RunReliability {
  succeeded: number;
  total: number;
  withheld: number;
}

/**
 * One scenario/agent pair. When the pair ran several times, the top-level
 * score, duration, and token fields describe the representative run, while
 * `runs`, `spread`, and `reliability` describe the whole set.
 */
export interface ResultEntry {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  durationMs: number;
  exitCode: number;
  failed?: boolean;
  /** Total runs configured for this pair. Omitted when it ran once. */
  runCount?: number;
  /** Every run, ordered by index. Omitted when the pair ran once. */
  runs?: RunEntry[];
  /** Score spread across successful runs. Omitted when the pair ran once or none scored. */
  spread?: ScoreSpread;
  /** Reliability fraction source. Omitted when the pair ran once. */
  reliability?: RunReliability;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  score?: ScoreResult;
  error?: string;
  file: string;
  prompt?: string;
  judge?: string | JudgeCriterion[];
  /** @deprecated Legacy field; read for back-compat with reports written before the rename. */
  rubric?: string | JudgeCriterion[];
  agentConfig?: Record<string, unknown>;
  resolvedConfig?: ResolvedRunConfig;
  artifacts?: ArtifactEntry[];
  setupOutput?: string;
  teardownOutput?: string;
}

export interface ArtifactEntry {
  /** Path relative to the per-run artifacts directory. Uses forward slashes. */
  path: string;
  size: number;
  mimeType: string;
  /** File contents, base64-encoded. */
  content: string;
}

export interface ResolvedRunConfig {
  limits?: { time_minutes?: number; tokens?: number };
  skills?: string[];
  setup?: LifecycleAction[];
  teardown?: LifecycleAction[];
  mcpServers?: Record<string, McpServerConfig>;
}

export type LifecycleAction =
  | { action: "run_script"; command: string }
  | { action: "copy"; match: string; destination: string };

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface JudgeCriterion {
  check: string;
  weight?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheReadInput?: number;
}

export interface ScoreResult {
  axisScore: number;
  goalAchievement: GoalAchievementScore;
  environment: CategoryScore;
  service: CategoryScore;
  agent: CategoryScore;
  weights: ScoringWeights;
  sparseIndex?: SparseIndex;
  /** Agent configuration that produced this score. */
  judging?: { agent: string; model?: string; command?: string; flags?: Record<string, unknown> };
}

export interface ScoringWeights {
  goal_achievement: number;
  environment: number;
  service: number;
  agent: number;
}

export interface GoalAchievementScore {
  score: number;
  criteria: CriterionGrade[];
}

export interface CriterionGrade {
  check: string;
  weight: number;
  score: number; // 0-10
  rationale: string;
}

export interface CategoryScore {
  score: number;
  interactionCount: number;
  auditedCount: number;
  dimensions: {
    success: number;
    speed: number;
    weight: number;
    relevance: number;
    necessity: number;
  };
  audits: InteractionAudit[];
  necessity: NecessityJudgment;
}

export interface InteractionAudit {
  id: number;
  categories: string[];
  success: number;
  speed: number;
  weight: number;
  contextRelevance: number;
  rationale: string;
}

export interface NecessityJudgment {
  category: string;
  score: number;
  unnecessaryIds: number[];
  rationale: string;
}

export interface SparseIndex {
  lines: string[];
  interactions: Interaction[];
  stats: {
    totalInteractions: number;
    byCategory: Record<string, number>;
    totalErrors: number;
    totalDurationMs: number;
    wallClockMs: number;
    /** Time from agent process spawn to first traced interaction. */
    startupMs?: number;
    /** Time from last traced interaction to agent process exit. */
    shutdownMs?: number;
  };
}

export interface Interaction {
  id: number;
  entryIndices: number[];
  categories: string[];
  sparseLine: string;
  toolName: string | null;
  hasError: boolean;
  durationMs: number | null;
  startMs: number | null;
  contextBytes: number;
  content?: string;
}

export function isScoredSummary(summary: RunSummary | ScoredSummary): summary is ScoredSummary {
  return "averageAxisScore" in summary;
}
