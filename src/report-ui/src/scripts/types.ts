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
}

export interface RunSummary {
  total: number;
  completed: number;
  failed: number;
}

export interface ScoredSummary extends RunSummary {
  averageAxisScore: number;
}

export interface ResultEntry {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  durationMs: number;
  exitCode: number;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  score?: ScoreResult;
  error?: string;
  file: string;
  prompt?: string;
  rubric?: string | RubricCriterion[];
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

export interface LifecycleAction {
  action: string;
  command: string;
}

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface RubricCriterion {
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
