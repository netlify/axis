export interface AxisConfig {
  /** Human-readable project name. Shown in report headers. */
  name?: string;
  scenarios: string;
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
