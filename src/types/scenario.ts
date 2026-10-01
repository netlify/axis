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
  judge: string | JudgeCriterion[];
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
   * How many times to run this scenario against each agent. Overrides
   * `settings.runs`. Defaults to 1. Raise it for scenarios whose results
   * swing between runs; see {@link SettingsConfig.runs} for the cost.
   */
  runs?: number;
  /**
   * Glob patterns (relative to the workspace) of files to capture into the report
   * after teardown. Merged with top-level `artifacts` from {@link AxisConfig}.
   */
  artifacts?: string[];
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
  judge?: string | JudgeCriterion[];
  teardown?: LifecycleAction[];
  agents?: string[];
  skills?: string[];
  mcp_servers?: Record<string, McpServerConfig>;
  /** Per-variant time/token limits. Overrides parent scenario and default limits. */
  limits?: ScenarioLimitsConfig;
  /** How many times to run this variant against each agent. Overrides the parent scenario's `runs`. */
  runs?: number;
  /** Glob patterns of files to capture as artifacts. Replaces parent scenario's artifacts when set. */
  artifacts?: string[];
}

/**
 * User-facing authoring shape for scenarios. `key` is optional because the
 * loader derives it from the file path when the scenario lives as a standalone
 * file in the scenarios directory.
 *
 * When declared inline in the `scenarios` array of `axis.config.{js,ts,json}`,
 * `key` becomes required — there is no path to derive it from. That stricter
 * constraint is expressed at the `AxisConfig.scenarios` field type, not here.
 */
export type ScenarioInput = Omit<Scenario, "key"> & { key?: string };

export type LifecycleAction = RunScriptAction | CopyAction;

export interface RunScriptAction {
  action: "run_script";
  command: string;
}

/**
 * Copy files into `destination` (relative to the agent workspace).
 *
 * `match` is either a glob resolved relative to the config directory, or a git
 * URL (`https://github.com/org/repo`, `git@github.com:org/repo.git`, with an
 * optional `#branch|tag|commit` fragment). Git sources are cloned once into
 * `.axis/repos/` and reused by every scenario, variant, and agent in the run.
 *
 * For globs, each matched file's path relative to the longest non-glob prefix
 * of `match` is preserved under `destination`. For git sources, the repository
 * working tree (or the subdirectory named by a pasted `/tree/<ref>/<path>` web
 * URL) is copied to `destination`.
 */
export interface CopyAction {
  action: "copy";
  match: string;
  destination: string;
  /**
   * Git sources only: branch, tag, or commit to check out. Overrides a `#ref`
   * fragment in `match`. Pin it to keep results comparable across runs.
   */
  ref?: string;
  /**
   * Git sources only: whether to copy the `.git` directory into the workspace.
   * Defaults to true, so agents can run `git status`/`git diff` the way they
   * would in a real checkout. Set false for a plain file tree.
   */
  include_git?: boolean;
}

export interface JudgeCriterion {
  check: string;
  weight?: number;
}

/** @deprecated Use {@link JudgeCriterion} instead. */
export type RubricCriterion = JudgeCriterion;
