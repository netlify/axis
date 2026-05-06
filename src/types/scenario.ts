import type { McpServerConfig, ScenarioLimitsConfig } from "./config.js";

export interface Scenario {
  /**
   * Stable identifier. For on-disk JSON scenarios the loader derives it from the file path
   * (relative to the scenarios root, sans extension). For inline scenarios declared in
   * `axis.config.{js,ts,json}`, authors must provide it themselves.
   */
  key: string;
  name: string;
  /** When true, the scenario is excluded from runs. */
  skip?: boolean;
  setup?: LifecycleAction[];
  prompt: string;
  rubric: string | RubricCriterion[];
  teardown?: LifecycleAction[];
  /** When set, only these agents run this scenario (overrides the global agents list). */
  agents?: string[];
  /** Skills specific to this scenario, merged with top-level and per-agent skills. */
  skills?: string[];
  /** MCP servers specific to this scenario, merged with top-level servers. */
  mcp_servers?: Record<string, McpServerConfig>;
  /** Per-scenario time/token limits. Overrides settings.limits.scenario defaults. */
  limits?: ScenarioLimitsConfig;
  /**
   * When defined, the scenario becomes a template. Only variants run;
   * the base scenario does not execute on its own. Each variant inherits
   * all fields from the parent and can override any of them.
   */
  variants?: ScenarioVariant[];
}

export interface ScenarioVariant {
  /** Variant identifier. Appended to the scenario key as `{scenarioKey}@{name}`. Must match /^[a-zA-Z0-9_-]+$/. */
  name: string;
  skip?: boolean;
  setup?: LifecycleAction[];
  prompt?: string;
  rubric?: string | RubricCriterion[];
  teardown?: LifecycleAction[];
  agents?: string[];
  skills?: string[];
  mcp_servers?: Record<string, McpServerConfig>;
  /** Per-variant time/token limits. Overrides parent scenario and default limits. */
  limits?: ScenarioLimitsConfig;
}

/**
 * User-facing shape for inline scenarios declared in `axis.config.{js,ts,json}`.
 * Identical to {@link Scenario} but explicit about the contract: `key` is required
 * (the loader does not derive it from a file path for inline entries).
 */
export type ScenarioInput = Scenario;

export interface LifecycleAction {
  action: "run_script";
  command: string;
}

export interface RubricCriterion {
  check: string;
  weight?: number;
}
