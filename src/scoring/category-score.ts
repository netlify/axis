import type {
  InteractionCategory,
  Interaction,
  InteractionAudit,
  NecessityJudgment,
  CategoryScore,
} from "../types/scoring.js";

// --- Dimension weights per category ---

/**
 * How each audit dimension contributes to a category's raw score.
 *
 * Environment and service evaluate EXECUTION QUALITY only (success + speed).
 * The agent's choice of what to invoke, with what parameters, and whether
 * it was necessary is evaluated under the agent dimension.
 */
export const CATEGORY_DIMENSION_WEIGHTS: Record<InteractionCategory, Record<string, number>> = {
  environment: {
    success: 0.7, // did the tool execute correctly?
    speed: 0.3, // was the tool responsive?
    weight: 0, // agent's decision — evaluated under agent
    relevance: 0, // agent's decision — evaluated under agent
    necessity: 0, // agent's decision — evaluated under agent
  },
  service: {
    success: 0.7, // did the API call succeed?
    speed: 0.3, // was the service responsive?
    weight: 0, // agent's decision — evaluated under agent
    relevance: 0, // agent's decision — evaluated under agent
    necessity: 0, // agent's decision — evaluated under agent
  },
  agent: {
    success: 0.1, // was reasoning productive?
    speed: 0.1, // thinking speed
    weight: 0.2, // were invocations right-sized?
    relevance: 0.2, // was retrieved info used effectively?
    necessity: 0.4, // were ALL interactions necessary? (spans all categories)
  },
};

// --- Log-normal calibration ---

/** Calibration parameters for the log-normal CDF mapping. */
export interface CalibrationParams {
  /** The raw score (0-1) that maps to 50/100. */
  median: number;
  /** Controls the spread — lower = steeper curve. */
  sigma: number;
}

/** Default calibration. median = raw score that maps to 50/100. */
export const DEFAULT_CALIBRATION: Record<InteractionCategory, CalibrationParams> = {
  environment: { median: 0.5, sigma: 0.4 },
  service: { median: 0.5, sigma: 0.4 },
  agent: { median: 0.5, sigma: 0.4 },
};

// --- Default scores for interactions the LLM missed ---
// If nothing was evaluated, assume perfect — only real issues lower the score.

export const DEFAULT_AUDIT_SCORES = {
  success: 1.0,
  speed: 1.0,
  weight: 1.0,
  contextRelevance: 1.0,
} as const;

// --- Math utilities ---

/**
 * Approximation of the standard normal CDF using Abramowitz & Stegun.
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Map a raw 0-1 score through a log-normal CDF to produce 0-100.
 *
 * The log-normal mapping ensures:
 * - Improving from bad (20) to mediocre (50) is "easier" (smaller raw improvement needed)
 * - Improving from good (80) to great (95) requires significant raw improvement
 * - The mapping is S-shaped, rewarding getting out of the "bad" zone
 */
export function logNormalScore(rawScore: number, median: number, sigma: number): number {
  if (rawScore <= 0) return 0;
  if (rawScore >= 1) return 100;

  const z = (Math.log(rawScore) - Math.log(median)) / sigma;
  const cdf = normalCDF(z);

  return Math.round(cdf * 100);
}

// --- Aggregation ---

/**
 * Severity-weighted average: bad scores pull harder than good scores push.
 *
 * Each value's effective weight is `(1 - value)² + 1`. Perfect scores (1.0)
 * get weight 1, while worse scores get progressively heavier, making outlier
 * problems hard to hide behind many good results.
 *
 * @param values - Scores in the 0-1 range
 */
export function severityWeightedAverage(values: number[]): number {
  if (values.length === 0) return 1.0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const v of values) {
    const w = (1 - v) ** 2 + 1;
    weightedSum += v * w;
    totalWeight += w;
  }

  return weightedSum / totalWeight;
}

/**
 * Aggregate a single audit dimension across interactions in a category,
 * weighted by each interaction's contextBytes.
 */
export function aggregateDimension(
  audits: InteractionAudit[],
  interactions: Interaction[],
  dimension: "success" | "speed" | "weight" | "contextRelevance",
): number {
  if (audits.length === 0) return DEFAULT_AUDIT_SCORES[dimension];

  // Speed uses severity-weighted average — bad latency should pull harder
  if (dimension === "speed") {
    return severityWeightedAverage(audits.map((a) => a.speed));
  }

  const interactionMap = new Map(interactions.map((i) => [i.id, i]));

  let totalWeight = 0;
  let weightedSum = 0;

  for (const audit of audits) {
    const interaction = interactionMap.get(audit.id);
    const w = Math.max(1, interaction?.contextBytes ?? 1);
    weightedSum += audit[dimension] * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : DEFAULT_AUDIT_SCORES[dimension];
}

/**
 * Compute the full category score from audits, necessity judgment, and interactions.
 * Applies dimension weights and log-normal mapping.
 */
export function computeCategoryScore(
  category: InteractionCategory,
  audits: InteractionAudit[],
  necessity: NecessityJudgment,
  interactions: Interaction[],
  calibration?: CalibrationParams,
): CategoryScore {
  // The agent dimension owns every decision the agent made, so its interaction
  // pool is the full transcript. Env/service only cover their own tagged tools.
  const categoryInteractions =
    category === "agent" ? interactions : interactions.filter((i) => i.categories.includes(category));
  const categoryAudits = audits.filter((a) => a.categories.includes(category));
  const auditedCount = categoryAudits.filter((a) => a.rationale !== "default").length;

  const weights = CATEGORY_DIMENSION_WEIGHTS[category];
  const cal = calibration ?? DEFAULT_CALIBRATION[category];

  // Aggregate each dimension
  const successRaw = aggregateDimension(categoryAudits, categoryInteractions, "success");
  const speedRaw = aggregateDimension(categoryAudits, categoryInteractions, "speed");
  const weightRaw = aggregateDimension(categoryAudits, categoryInteractions, "weight");
  const relevanceRaw = aggregateDimension(categoryAudits, categoryInteractions, "contextRelevance");
  const necessityRaw = necessity.score;

  // Weighted composite raw score (0-1)
  const rawScore =
    successRaw * weights.success +
    speedRaw * weights.speed +
    weightRaw * weights.weight +
    relevanceRaw * weights.relevance +
    necessityRaw * weights.necessity;

  // Map through log-normal CDF
  const score = logNormalScore(rawScore, cal.median, cal.sigma);

  return {
    score,
    interactionCount: categoryInteractions.length,
    auditedCount,
    dimensions: {
      success: Math.round(successRaw * 100),
      speed: Math.round(speedRaw * 100),
      weight: Math.round(weightRaw * 100),
      relevance: Math.round(relevanceRaw * 100),
      necessity: Math.round(necessityRaw * 100),
    },
    audits: categoryAudits,
    necessity,
  };
}
