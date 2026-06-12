import type { ScenarioInput, ScenarioVariant } from "../../src/types/scenario.js";

const DEFAULT_SKILLS = ["./skills/configure-axis"];

export interface SharedVariantsOptions {
  /**
   * Skill source strings attached to the `with-skills` variant. Defaults to
   * `["./skills/configure-axis"]`. Paths resolve relative to the config dir
   * (see `src/skills/resolver.ts`).
   */
  skills?: string[];
}

/**
 * Wrap a scenario with the standard two-variant convention used across this
 * repo's dogfood scenarios:
 *
 *   - `no-context`: baseline, no skills attached
 *   - `with-skills`: attaches the configure-axis skill (or `options.skills`)
 *
 * Any variants already on the scenario are appended after these two.
 */
export function withSharedVariants(scenario: ScenarioInput, options?: SharedVariantsOptions): ScenarioInput {
  const variants: ScenarioVariant[] = [
    { name: "no-context" },
    { name: "with-skills", skills: options?.skills ?? DEFAULT_SKILLS },
    ...(scenario.variants ?? []),
  ];
  return { ...scenario, variants };
}
