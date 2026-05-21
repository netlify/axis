import type { Scenario } from "./scenario.js";
import type { AgentConfig, McpServerConfig, ResolvedSkill } from "./config.js";
import type { Logger } from "./output.js";
import type { TranscriptAnalysis } from "../transcript/types.js";

/**
 * Paths the runner provides to an adapter for isolation. The agent's working
 * directory (`workspace`) is kept separate from its HOME (`home`) so that
 * adapter config dirs (`.codex`, `.claude`, `.gemini`, `.qwen`), MCP config
 * files, and user-scoped skill trees never appear when the agent scans its cwd.
 */
export interface IsolationPaths {
  /** Agent's `cwd` — should only contain scenario-provided files. */
  workspace: string;
  /** Agent's HOME — adapter `*_HOME` env vars point under here. */
  home: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentInput): Promise<AgentOutput>;
  /**
   * Returns adapter-specific environment overrides for workspace isolation.
   * Called by the runner and merged into the job env after universal isolation
   * (HOME, env filtering) is applied. Adapters should point `*_HOME`-style env
   * vars under `paths.home` so config dirs never appear in `paths.workspace`.
   */
  isolationEnv?(paths: IsolationPaths): Record<string, string>;
  /**
   * Returns environment variable names required for the adapter to function
   * (e.g. API keys). The runner validates these are present before launching
   * any jobs and fails early with a clear error message.
   */
  requiredEnv?(): string[];
  /**
   * Returns true if the CLI has a usable local login on this machine (e.g.
   * `claude login` / `codex login`). When `requiredEnv` is missing, the
   * runner calls this and skips the env-var error if it resolves true,
   * allowing local users to run without setting an API key. If
   * `requiredEnv` is satisfied, this is not called — explicit credentials
   * always win.
   */
  hasLocalSession?(): boolean | Promise<boolean>;
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
  /** Agent's `cwd` — pristine, contains only scenario-provided files. */
  workingDirectory: string;
  /** Agent's HOME directory — adapter config dirs (`.codex`, `.claude`, …) live here, never in `workingDirectory`. */
  homeDirectory: string;
  /** Filtered environment variables for the agent process. If omitted, inherits parent env. */
  env?: Record<string, string>;
  /** Register a cleanup function to be called on process signal (SIGINT/SIGTERM). */
  registerCleanup?: (fn: () => void) => void;
  /** When true, adapters capture raw stdout lines in AgentOutput.rawOutput. */
  captureRawOutput?: boolean;
  /**
   * Invoked for each raw stdout line/chunk as the agent streams output.
   * Adapters call this in parallel with pushing to `rawOutput`, so the runner
   * can tail-write a debug file while the agent is still running.
   */
  onRawLine?: (line: string) => void;
  /**
   * Invoked for each stderr chunk as the agent streams it. Adapters call this
   * in parallel with the (capped) in-memory stderr buffer, so the runner can
   * tail-write a debug stderr log while the agent is still running.
   */
  onStderr?: (chunk: string) => void;
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
  /** When true, adapters may surface extra protocol/SDK diagnostics to stderr. */
  debug?: boolean;
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
