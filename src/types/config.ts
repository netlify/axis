import type { ScenarioInput } from "./scenario.js";

export interface AxisConfig {
  /** Human-readable project name. Shown in report headers. */
  name?: string;
  /**
   * Where scenarios come from. Supports three forms:
   * - A path string — directory walked for `*.json`/`*.{js,ts,...}` scenario files.
   * - An array of strings — each entry is a directory or single scenario file path.
   * - An array mixing path strings and inline {@link ScenarioInput} objects, useful
   *   when authoring `axis.config.{js,ts}` and generating scenarios programmatically.
   *
   * When omitted, the loader defaults to `"./scenarios"` (relative to the config file).
   */
  scenarios?: string | (string | ScenarioInput)[];
  agents: (string | AgentConfig)[];
  settings?: SettingsConfig;
  /** Custom adapter modules. Keys are adapter names, values are paths (relative to config) to JS/TS modules that export an AgentAdapter. */
  adapters?: Record<string, string>;
  /** Environment variables to pass through to agent processes. System vars (PATH, HOME, etc.) are always included. */
  env?: string[];
  /** MCP servers available to all agents during execution. */
  mcp_servers?: Record<string, McpServerConfig>;
  /** Skills available to all agents. Merged with per-agent skills. Each entry is a local path, GitHub shorthand (owner/repo), or GitHub URL. */
  skills?: string[];
}

/** A skill resolved from its source reference to an on-disk directory. */
export interface ResolvedSkill {
  /** Skill name (derived from directory name). */
  name: string;
  /** Absolute path to the skill directory containing SKILL.md. */
  path: string;
}

export interface AgentConfig {
  adapter: string;
  /** Executable command for custom adapters (e.g. "codex", "aider", "./my-agent.sh"). */
  command?: string;
  scenarios?: string[];
  skills?: string[];
  model?: string;
  /** Adapter-specific CLI flags. Keys are flag names (without --), values are flag values (true for boolean flags). */
  flags?: Record<string, string | boolean>;
}

export interface SettingsConfig {
  scoring_weights?: ScoringWeights;
  /** Maximum number of parallel jobs. Defaults to unlimited (all jobs run simultaneously). */
  concurrency?: number;
  /** Time and token spend limits for the run and individual scenarios. */
  limits?: LimitsConfig;
}

/** Overall run limits and default per-scenario limits. */
export interface LimitsConfig {
  /** When hit, ALL remaining and in-progress jobs are aborted. */
  run?: ScenarioLimitsConfig;
  /** Default limits applied to each individual job. Per-scenario limits override these. */
  scenario?: ScenarioLimitsConfig;
}

/** Limits for an individual scenario/job. Reused across settings and scenario configs. */
export interface ScenarioLimitsConfig {
  /** Maximum execution time in minutes. Accepts fractional values. */
  time_minutes?: number;
  /** Maximum total tokens (input + output + cache). Must be a positive integer. */
  tokens?: number;
}

export interface ScoringWeights {
  goal_achievement: number;
  environment: number;
  service: number;
  agent: number;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpStdioServer {
  /** Spawn a local process. */
  type: "stdio";
  /** Command to run. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
}

export interface McpHttpServer {
  /** Connect to a remote MCP server over HTTP. */
  type: "http";
  /** URL of the MCP server endpoint. */
  url: string;
  /** HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
}
