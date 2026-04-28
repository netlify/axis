import type { ScoringWeights } from "../types/config.js";

/** Validate that scoring weights are positive and sum to approximately 1.0. */
export function validateWeights(weights: ScoringWeights): void {
  const { goal_achievement, environment, service, agent } = weights;

  if (goal_achievement < 0 || environment < 0 || service < 0 || agent < 0) {
    throw new Error("Scoring weights must be non-negative");
  }

  const sum = goal_achievement + environment + service + agent;
  if (sum === 0) {
    throw new Error("Scoring weights must not all be zero");
  }

  if (Math.abs(sum - 1.0) > 0.01) {
    throw new Error(
      `Scoring weights must sum to 1.0 (got ${sum.toFixed(3)}). ` +
        `Received: goal_achievement=${goal_achievement}, environment=${environment}, service=${service}, agent=${agent}`,
    );
  }
}

export function computeComposite(
  goalAchievementScore: number,
  environmentScore: number,
  serviceScore: number,
  agentScore: number,
  weights: ScoringWeights,
): number {
  validateWeights(weights);

  const weighted =
    goalAchievementScore * weights.goal_achievement +
    environmentScore * weights.environment +
    serviceScore * weights.service +
    agentScore * weights.agent;

  return Math.round(weighted);
}
