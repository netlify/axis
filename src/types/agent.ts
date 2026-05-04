import type { Scenario } from "./scenario.js";
import type { AgentConfig, McpServerConfig, ResolvedSkill } from "./config.js";
import type { Logger } from "./output.js";
import type { TranscriptAnalysis } from "../transcript/types.js";

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentInput): Promise<AgentOutput>;
  /**
   * Returns adapter-specific environment overrides for workspace isolation.
   * Called by the runner and merged into the job env after universal isolation
   * (HOME, env filtering) is applied.
   */
  isolationEnv?(workspace: string): Record<string, string>;
  /**
   * Returns environment variable names required for the adapter to function
   * (e.g. API keys). The runner validates these are present before launching
   * any jobs and fails early with a clear error message.
   */
  requiredEnv?(): string[];
  /**
   * Resolves and validates the CLI binary for this adapter.
   * Called once during runner pre-flight before any jobs run.
   * If the CLI is not globally installed, falls back to npx.
   */
  ensureInstalled?(logger: Logger): Promise<void>;
}

export interface AgentInput {
  prompt: string;
  config: AgentConfig;
  scenario: Scenario;
  workingDirectory: string;
  /** Filtered environment variables for the agent process. If omitted, inherits parent env. */
  env?: Record<string, string>;
  /** Register a cleanup function to be called on process signal (SIGINT/SIGTERM). */
  registerCleanup?: (fn: () => void) => void;
  /** When true, adapters capture raw stdout lines in AgentOutput.rawOutput. */
  captureRawOutput?: boolean;
  /** MCP servers to configure for this agent run (from top-level config). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Resolved skills to install for this agent run. */
  resolvedSkills?: ResolvedSkill[];
  /**
   * Invoked by the adapter with a conservative, monotonically-increasing
   * estimate of tokens consumed so far. Used to drive the live UI counter.
   * Estimates are derived from streamed assistant text, intentionally kept
   * below the true count so the UI never has to reverse.
   */
  onTokenProgress?: (estimatedTokens: number) => void;
  /** Override the adapter's default timeout (in ms). Set by the runner from resolved scenario limits. */
  timeoutMs?: number;
  /** Abort signal. When fired, the adapter kills the child process with SIGTERM → SIGKILL. */
  signal?: AbortSignal;
}

export interface AgentOutput {
  transcript: TranscriptEntry[];
  result: string | null;
  metadata: AgentMetadata;
  /** Raw stdout lines from the agent process (populated when captureRawOutput is set). */
  rawOutput?: string[];
  /** Per-entry extracted signals and aggregate analysis. Populated during scoring. */
  transcriptAnalysis?: TranscriptAnalysis;
}

export interface AgentMetadata {
  startTime: string;
  endTime: string;
  durationMs: number;
  tokenUsage?: TokenUsage;
  totalCostUsd?: number;
  exitCode: number;
  sessionId?: string;
  /** Human-readable error description when the agent fails. */
  error?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheReadInput?: number;
}

export interface TranscriptEntry {
  type: "assistant" | "user" | "tool_use" | "tool_result" | "system" | "error";
  timestamp: string;
  content: Record<string, unknown>;
}
