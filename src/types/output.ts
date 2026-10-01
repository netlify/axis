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
  /** Files in the scenarios tree that could not be loaded. Omitted when every file loaded. */
  loadFailures?: ScenarioLoadFailure[];
}

/**
 * A file in the scenarios tree that could not be loaded as a scenario.
 *
 * Distinct from a `skip: true` scenario: that is a deliberate opt-out, while
 * this is a file that was meant to be a scenario (or is too broken to tell)
 * and would otherwise silently shrink the run without anyone noticing.
 */
export interface ScenarioLoadFailure {
  /** Absolute path to the file that failed to load. */
  path: string;
  /** Why it could not be loaded. */
  reason: string;
}

/** Shared fields for all run results (scored and unscored). */
export interface BaseRunResult {
  scenarioKey: string;
  scenarioName: string;
  agentName: string;
  /**
   * 1-based index of this run within its scenario/agent pair. Omitted when the
   * pair ran once, which keeps single-run results byte-identical to reports
   * written before multi-run support.
   */
  runIndex?: number;
  /** Total runs configured for this pair. Omitted when it is 1. */
  runCount?: number;
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

/**
 * Run totals.
 *
 * `total`, `completed`, and `failed` count scenario/agent **pairs**, not
 * individual runs, so a suite's headline numbers don't change shape when
 * `runs` is raised. A pair counts as completed when at least one of its runs
 * produced a score; a pair with no scored run is failed. Flakiness inside a
 * pair shows up in the report's per-pair `reliability`, not here.
 *
 * `runsTotal` and `runsFailed` count the individual executions, and are
 * omitted when every pair ran once (where they would duplicate `total` and
 * `failed`).
 */
export interface RunSummary {
  total: number;
  completed: number;
  failed: number;
  /** Individual agent executions attempted. Omitted when every pair ran once. */
  runsTotal?: number;
  /** Individual agent executions that failed. Omitted when every pair ran once. */
  runsFailed?: number;
  /** Scenarios deliberately opted out via `skip: true`. */
  skipped?: number;
  /** Files in the scenarios tree that could not be loaded. */
  loadFailed?: number;
}

export type JobStatus = "pending" | "setup" | "starting" | "running" | "teardown" | "done" | "failed" | "scoring";

export interface JobState {
  scenarioKey: string;
  agentName: string;
  /** 1-based run index within the scenario/agent pair. Omitted when the pair runs once. */
  runIndex?: number;
  /** Total runs configured for this pair. Omitted when it is 1. */
  runCount?: number;
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
   * Wall-clock ms-epoch when the agent transitioned out of `pending` into
   * `starting`/`running`. Used by the live UI to tick an elapsed-duration
   * counter before the job finishes (once finished, `durationMs` takes over
   * as the authoritative value).
   */
  runStartedAt?: number;
  /**
   * True while the scenario's teardown scripts (and artifact capture) are
   * running. Set after `status` has already moved to `done`/`failed` so the
   * score remains visible — this is a separate flag rather than a status so
   * the row doesn't visually regress.
   */
  inTeardown?: boolean;
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

/**
 * Exit status for a completed run.
 *
 * Non-zero when jobs failed, when a scenario file failed to load, or when the
 * run discovered nothing at all. The last two matter because neither shows up
 * in the pass/fail counts: a suite that quietly stopped loading a scenario
 * still produces a clean-looking average over the scenarios that remain.
 */
export function runExitStatus(output: { summary: RunSummary; loadFailures?: ScenarioLoadFailure[] }): {
  code: number;
  reason?: string;
} {
  const reasons: string[] = [];
  const loadFailed = output.loadFailures?.length ?? 0;

  if (loadFailed > 0) {
    const plural = loadFailed === 1 ? "" : "s";
    reasons.push(
      `${loadFailed} scenario file${plural} failed to load, so this run did not cover the whole suite. ` +
        `Fix the file${plural}, or move ${loadFailed === 1 ? "it" : "them"} into a "fixtures" directory if not scenarios.`,
    );
  }
  if (output.summary.total === 0) {
    reasons.push("No scenarios ran. Check the scenarios path and any --scenario / --agent filters.");
  }

  const failing = loadFailed > 0 || output.summary.total === 0 || output.summary.failed > 0;
  return { code: failing ? 1 : 0, ...(reasons.length > 0 ? { reason: reasons.join(" ") } : {}) };
}

/** Type guard: checks if a run result has been scored. */
export function isScoredResult(result: BaseRunResult): result is ScoredRunResult {
  return "score" in result && result.score != null;
}

/** Format an unknown error value into a message string. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True when a run produced neither a transcript nor a final result: the
 * "empty-work signature". The agent process may have exited cleanly (a silent
 * no-op), but there is nothing to grade. Requiring BOTH an empty transcript
 * and an empty result keeps legitimate result-only runs (e.g. ACP agents that
 * return a final answer with no tool use) from being flagged.
 */
export function hasEmptyOutput(output: AgentOutput): boolean {
  const hasResult = output.result !== null && output.result.trim() !== "";
  return output.transcript.length === 0 && !hasResult;
}

/**
 * Determine whether an agent run should be treated as failed for scoring and
 * reporting purposes.
 *
 * A run with a {@link AgentOutput.result} is considered successful unless it
 * also carries an error — this covers ACP-based agents (opencode, gemini
 * --acp, …) that are SIGTERM'd after completing successfully: the process
 * exits via signal so `exitCode` is non-zero, but the run produced a result
 * and should be scored normally.
 *
 * Runs without a result are failed when either `exitCode` is non-zero or an
 * explicit `error` is present (timeouts, crashes, mid-run kills, …).
 *
 * A run that produced no output at all (empty transcript AND no result) is
 * always failed, even on a clean exit; grading "nothing" would otherwise
 * yield a fake ~57 composite indistinguishable from a mediocre run.
 */
export function isFailedRun(output: AgentOutput): boolean {
  const { exitCode, error } = output.metadata;
  if (error) return true;
  if (hasEmptyOutput(output)) return true;
  if (output.result !== null) return false;
  return exitCode !== 0;
}
