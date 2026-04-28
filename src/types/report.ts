import type { TokenUsage } from "./agent.js";
import type { AgentConfig } from "./config.js";
import type { ScoreResult } from "./scoring.js";
import type { RunSummary } from "./output.js";
import type { ScoredSummary } from "./scoring.js";
import type { RubricCriterion } from "./scenario.js";

/** Lightweight report manifest — no transcripts, just summary data. */
export interface ReportManifest {
  version: string;
  reportId: string;
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
  /** Rubric used for scoring. */
  rubric?: string | RubricCriterion[];
  /** Agent configuration. */
  agentConfig?: AgentConfig;
}
