import type { AgentOutput } from "./agent.js";
import type { AgentConfig } from "./config.js";
import type { RubricCriterion } from "./scenario.js";
import type { ScoredRunResult } from "./scoring.js";

export interface RunOutput {
  version: string;
  timestamp: string;
  durationMs: number;
  results: RunResult[];
  summary: RunSummary;
}

/** Shared fields for all run results (scored and unscored). */
export interface BaseRunResult {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  prompt: string;
  rubric: string | RubricCriterion[];
  agentConfig: AgentConfig;
  output: AgentOutput;
  /** Path to the agent's workspace directory (available during scoring, before cleanup). */
  workingDirectory?: string;
}

export interface RunResult extends BaseRunResult {}

export interface RunSummary {
  total: number;
  completed: number;
  failed: number;
}

export type JobStatus = "pending" | "setup" | "running" | "teardown" | "done" | "failed" | "scoring";

export interface JobState {
  scenarioKey: string;
  agentName: string;
  status: JobStatus;
  durationMs?: number;
  axisScore?: number;
  /**
   * Live running token estimate for the agent (monotonically non-decreasing).
   * Sourced from streamed assistant text during execution and snapped to the
   * real `metadata.tokenUsage` total at completion. Intentionally conservative
   * so the UI can animate count-up without ever having to reverse.
   */
  liveTokens?: number;
  /**
   * True once `liveTokens` has been replaced with the authoritative total
   * from `metadata.tokenUsage` (input + output + cacheReadInput). The UI
   * uses this to drop the `~` approximation prefix once the animation
   * catches up to the real value.
   */
  tokensFinal?: boolean;
  /**
   * Wall-clock ms-epoch when the agent transitioned to `running`. Used by the
   * live UI to tick an elapsed-duration counter before the job finishes (once
   * finished, `durationMs` takes over as the authoritative value).
   */
  runStartedAt?: number;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
  /** Detailed per-step logging. Only called when verbose mode is enabled. */
  verbose?(message: string): void;
  /** Called when a job's status changes. Used for live-updating displays. */
  onJobUpdate?(jobs: JobState[]): void;
}

export const silentLogger: Logger = {
  info() {},
  error() {},
};

/** Type guard: checks if a run result has been scored. */
export function isScoredResult(result: BaseRunResult): result is ScoredRunResult {
  return "score" in result && result.score != null;
}

/** Format an unknown error value into a message string. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
