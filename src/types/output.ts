import type { AgentOutput } from "./agent.js";
import type { AgentConfig, McpServerConfig, ScenarioLimitsConfig } from "./config.js";
import type { JudgeCriterion, LifecycleAction } from "./scenario.js";
import type { ScoredRunResult } from "./scoring.js";

/** Materialized scenario configuration for a single run — limits, skills, lifecycle, and MCP, with defaults already applied. */
export interface ResolvedRunConfig {
  limits?: ScenarioLimitsConfig;
  skills?: string[];
  setup?: LifecycleAction[];
  teardown?: LifecycleAction[];
  mcpServers?: Record<string, McpServerConfig>;
  /** Effective artifact glob patterns applied to this run (merged from config + scenario). */
  artifacts?: string[];
}

/** A file captured from a scenario workspace after teardown. */
export interface ArtifactEntry {
  /** Path relative to the per-run artifacts directory (and to the workspace root). Uses forward slashes. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Best-effort MIME type derived from the file extension. */
  mimeType: string;
  /** File contents, base64-encoded. Embedded in the report manifest so previews and downloads work even when the HTML report is opened from disk (file://). */
  content: string;
}

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
  judge: string | JudgeCriterion[];
  agentConfig: AgentConfig;
  output: AgentOutput;
  /** Path to the agent's workspace directory (available during scoring, before cleanup). */
  workingDirectory?: string;
  /** Materialized scenario settings (limits, skills, lifecycle, MCP) actually applied to this run. */
  resolvedConfig?: ResolvedRunConfig;
  /** Files captured from the workspace after teardown, when artifact patterns are configured. */
  artifacts?: ArtifactEntry[];
  /** Markdown notes the scenario's setup scripts wrote to `$AXIS_OUTPUT`. */
  setupOutput?: string;
  /** Markdown notes the scenario's teardown scripts wrote to `$AXIS_OUTPUT`. */
  teardownOutput?: string;
}

export interface RunResult extends BaseRunResult {}

export interface RunSummary {
  total: number;
  completed: number;
  failed: number;
  skipped?: number;
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
  onJobUpdate?(jobs: JobState[], meta?: { skipped?: number }): void;
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
