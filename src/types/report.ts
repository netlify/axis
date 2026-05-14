import type { TokenUsage } from "./agent.js";
import type { AgentConfig } from "./config.js";
import type { ScoreResult } from "./scoring.js";
import type { ArtifactEntry, ResolvedRunConfig, RunSummary } from "./output.js";
import type { ScoredSummary } from "./scoring.js";
import type { JudgeCriterion } from "./scenario.js";

/** Lightweight report manifest — no transcripts, just summary data. */
export interface ReportManifest {
  version: string;
  reportId: string;
  /** Human-readable project name from config. */
  name?: string;
  timestamp: string;
  durationMs: number;
  summary: ScoredSummary | RunSummary;
  results: ReportResultEntry[];
}

/** Summary of a single scenario×agent result (no transcript). */
export interface ReportResultEntry {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  durationMs: number;
  exitCode: number;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  score?: ScoreResult;
  /** Human-readable error description when the agent fails. */
  error?: string;
  /** Relative path to the full result file within the report directory. */
  file: string;
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
