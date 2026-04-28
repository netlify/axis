export interface Scenario {
  /** Stable identifier derived from file path relative to scenarios root, sans .json */
  key: string;
  name: string;
  setup?: LifecycleAction[];
  prompt: string;
  rubric: string | RubricCriterion[];
  teardown?: LifecycleAction[];
  /** When set, only these agents run this scenario (overrides the global agents list). */
  agents?: string[];
  /** Skills specific to this scenario, merged with top-level and per-agent skills. */
  skills?: string[];
}

export interface LifecycleAction {
  action: "run_script";
  command: string;
}

export interface RubricCriterion {
  check: string;
  weight?: number;
}
