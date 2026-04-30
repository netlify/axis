import { describe, it, expect } from "vitest";
import {
  normalCDF,
  logNormalScore,
  severityWeightedAverage,
  aggregateDimension,
  computeCategoryScore,
  DEFAULT_AUDIT_SCORES,
  DEFAULT_CALIBRATION,
  CATEGORY_DIMENSION_WEIGHTS,
} from "../../../src/scoring/category-score.js";
import type {
  InteractionAudit,
  NecessityJudgment,
  Interaction,
  InteractionCategory,
} from "../../../src/types/scoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInteraction(overrides: Partial<Interaction> & { id: number }): Interaction {
  return {
    entryIndices: [0],
    categories: ["environment"],
    sparseLine: "",
    toolName: null,
    hasError: false,
    durationMs: null,
    startMs: null,
    contextBytes: 100,
    ...overrides,
  };
}

function makeAudit(
  overrides: Partial<InteractionAudit> & { id: number; categories: InteractionCategory[] },
): InteractionAudit {
  return {
    success: 0.8,
    speed: 0.8,
    weight: 0.8,
    contextRelevance: 0.8,
    rationale: "test",
    ...overrides,
  };
}

function makeNecessity(category: InteractionCategory, score: number): NecessityJudgment {
  return {
    category,
    score,
    unnecessaryIds: [],
    rationale: "test necessity",
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DEFAULT_AUDIT_SCORES", () => {
  it("has expected default values", () => {
    expect(DEFAULT_AUDIT_SCORES.success).toBe(1.0);
    expect(DEFAULT_AUDIT_SCORES.speed).toBe(1.0);
    expect(DEFAULT_AUDIT_SCORES.weight).toBe(1.0);
    expect(DEFAULT_AUDIT_SCORES.contextRelevance).toBe(1.0);
  });
});

describe("DEFAULT_CALIBRATION", () => {
  it("has entries for all three categories", () => {
    expect(DEFAULT_CALIBRATION).toHaveProperty("environment");
    expect(DEFAULT_CALIBRATION).toHaveProperty("service");
    expect(DEFAULT_CALIBRATION).toHaveProperty("agent");
  });

  it("each category has median and sigma", () => {
    for (const category of ["environment", "service", "agent"] as InteractionCategory[]) {
      const cal = DEFAULT_CALIBRATION[category];
      expect(cal.median).toBeGreaterThan(0);
      expect(cal.median).toBeLessThanOrEqual(1);
      expect(cal.sigma).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// severityWeightedAverage
// ---------------------------------------------------------------------------

describe("severityWeightedAverage", () => {
  it("returns 1.0 for empty array", () => {
    expect(severityWeightedAverage([])).toBe(1.0);
  });

  it("returns the value itself for a single element", () => {
    expect(severityWeightedAverage([0.7])).toBeCloseTo(0.7, 10);
  });

  it("returns 1.0 when all values are perfect", () => {
    expect(severityWeightedAverage([1.0, 1.0, 1.0])).toBe(1.0);
  });

  it("pulls below simple average when there are bad scores", () => {
    const values = [1.0, 1.0, 0.4];
    const simpleAvg = (1.0 + 1.0 + 0.4) / 3;
    const result = severityWeightedAverage(values);
    expect(result).toBeLessThan(simpleAvg);
  });

  it("equals simple average when all values are the same", () => {
    expect(severityWeightedAverage([0.6, 0.6, 0.6])).toBeCloseTo(0.6, 10);
  });

  it("computes correctly for mixed scores", () => {
    // [1.0, 1.0, 0.8, 0.4, 0.9]
    // weights: 1.0, 1.0, 1.04, 1.36, 1.01 = 5.41
    // weighted sum: 1.0 + 1.0 + 0.832 + 0.544 + 0.909 = 4.285
    // result: 4.285 / 5.41 ≈ 0.7920
    expect(severityWeightedAverage([1.0, 1.0, 0.8, 0.4, 0.9])).toBeCloseTo(0.792, 2);
  });

  it("one bad outlier among many good scores still pulls noticeably", () => {
    // 20 perfect scores and 1 terrible one
    const values = [...Array(20).fill(1.0), 0.4];
    const simpleAvg = values.reduce((a, b) => a + b, 0) / values.length; // ~0.971
    const result = severityWeightedAverage(values);
    // Should be noticeably below simple average
    expect(result).toBeLessThan(simpleAvg);
    // But not catastrophically low — 20 good scores still matter
    expect(result).toBeGreaterThan(0.9);
  });
});

describe("CATEGORY_DIMENSION_WEIGHTS", () => {
  it("has entries for all three categories", () => {
    expect(CATEGORY_DIMENSION_WEIGHTS).toHaveProperty("environment");
    expect(CATEGORY_DIMENSION_WEIGHTS).toHaveProperty("service");
    expect(CATEGORY_DIMENSION_WEIGHTS).toHaveProperty("agent");
  });

  it("each category weights sum to 1.0", () => {
    for (const category of ["environment", "service", "agent"] as InteractionCategory[]) {
      const weights = CATEGORY_DIMENSION_WEIGHTS[category];
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it("each category has all five dimensions", () => {
    for (const category of ["environment", "service", "agent"] as InteractionCategory[]) {
      const weights = CATEGORY_DIMENSION_WEIGHTS[category];
      expect(weights).toHaveProperty("success");
      expect(weights).toHaveProperty("speed");
      expect(weights).toHaveProperty("weight");
      expect(weights).toHaveProperty("relevance");
      expect(weights).toHaveProperty("necessity");
    }
  });
});

// ---------------------------------------------------------------------------
// normalCDF
// ---------------------------------------------------------------------------

describe("normalCDF", () => {
  it("returns approximately 0.5 at x=0", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
  });

  it("approaches 0 for very negative x", () => {
    expect(normalCDF(-10)).toBeCloseTo(0, 5);
    expect(normalCDF(-6)).toBeLessThan(0.001);
  });

  it("approaches 1 for very positive x", () => {
    expect(normalCDF(10)).toBeCloseTo(1, 5);
    expect(normalCDF(6)).toBeGreaterThan(0.999);
  });

  it("is monotonically increasing", () => {
    const xs = [-3, -2, -1, 0, 1, 2, 3];
    for (let i = 1; i < xs.length; i++) {
      expect(normalCDF(xs[i])).toBeGreaterThan(normalCDF(xs[i - 1]));
    }
  });

  it("is symmetric: CDF(x) + CDF(-x) ≈ 1", () => {
    for (const x of [0.5, 1, 1.5, 2, 3]) {
      expect(normalCDF(x) + normalCDF(-x)).toBeCloseTo(1.0, 5);
    }
  });

  it("matches known standard normal CDF values", () => {
    // z = 1 -> CDF ≈ 0.8413
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
    // z = -1 -> CDF ≈ 0.1587
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
    // z = 2 -> CDF ≈ 0.9772
    expect(normalCDF(2)).toBeCloseTo(0.9772, 3);
  });
});

// ---------------------------------------------------------------------------
// logNormalScore
// ---------------------------------------------------------------------------

describe("logNormalScore", () => {
  it("returns 0 when rawScore is 0", () => {
    expect(logNormalScore(0, 0.7, 0.5)).toBe(0);
  });

  it("returns 0 when rawScore is negative", () => {
    expect(logNormalScore(-0.5, 0.7, 0.5)).toBe(0);
  });

  it("returns 100 when rawScore is 1", () => {
    expect(logNormalScore(1, 0.7, 0.5)).toBe(100);
  });

  it("returns 100 when rawScore is greater than 1", () => {
    expect(logNormalScore(1.5, 0.7, 0.5)).toBe(100);
  });

  it("returns 50 when rawScore equals the median", () => {
    expect(logNormalScore(0.7, 0.7, 0.5)).toBe(50);
  });

  it("returns 50 at median for all categories", () => {
    for (const category of ["environment", "service", "agent"] as InteractionCategory[]) {
      const { median, sigma } = DEFAULT_CALIBRATION[category];
      expect(logNormalScore(median, median, sigma)).toBe(50);
    }
  });

  it("scores below median produce scores below 50", () => {
    expect(logNormalScore(0.3, 0.7, 0.5)).toBeLessThan(50);
  });

  it("scores above median produce scores above 50", () => {
    expect(logNormalScore(0.9, 0.7, 0.5)).toBeGreaterThan(50);
  });

  it("is monotonically increasing for valid input range", () => {
    const raws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    for (let i = 1; i < raws.length; i++) {
      expect(logNormalScore(raws[i], 0.7, 0.5)).toBeGreaterThanOrEqual(logNormalScore(raws[i - 1], 0.7, 0.5));
    }
  });

  it("returns an integer (due to Math.round)", () => {
    const score = logNormalScore(0.55, 0.7, 0.5);
    expect(Number.isInteger(score)).toBe(true);
  });

  it("lower sigma produces steeper curve (more spread at extremes)", () => {
    // With a steeper curve, the midpoint is the same, but extreme values differ more
    const lowSigma = logNormalScore(0.3, 0.7, 0.3);
    const highSigma = logNormalScore(0.3, 0.7, 0.8);
    // Low sigma penalizes being below median more harshly
    expect(lowSigma).toBeLessThan(highSigma);
  });

  it("handles very small rawScore gracefully", () => {
    const score = logNormalScore(0.001, 0.7, 0.5);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// aggregateDimension
// ---------------------------------------------------------------------------

describe("aggregateDimension", () => {
  it("returns default score for empty audits", () => {
    expect(aggregateDimension([], [], "success")).toBe(DEFAULT_AUDIT_SCORES.success);
    expect(aggregateDimension([], [], "speed")).toBe(DEFAULT_AUDIT_SCORES.speed);
    expect(aggregateDimension([], [], "weight")).toBe(DEFAULT_AUDIT_SCORES.weight);
    expect(aggregateDimension([], [], "contextRelevance")).toBe(DEFAULT_AUDIT_SCORES.contextRelevance);
  });

  it("returns exact value for a single audit", () => {
    const audits: InteractionAudit[] = [makeAudit({ id: 1, categories: ["environment"], success: 0.6 })];
    const interactions: Interaction[] = [makeInteraction({ id: 1, contextBytes: 100 })];

    expect(aggregateDimension(audits, interactions, "success")).toBe(0.6);
  });

  it("speed uses severity-weighted average regardless of contextBytes", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], speed: 0.4 }),
      makeAudit({ id: 2, categories: ["environment"], speed: 0.8 }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, contextBytes: 100 }),
      makeInteraction({ id: 2, contextBytes: 100 }),
    ];

    // Severity-weighted: bad 0.4 pulls harder than simple average of 0.6
    expect(aggregateDimension(audits, interactions, "speed")).toBeCloseTo(0.5733, 3);
  });

  it("weights by contextBytes — interaction with more bytes gets more influence", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], weight: 1.0 }),
      makeAudit({ id: 2, categories: ["environment"], weight: 0.0 }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, contextBytes: 900 }),
      makeInteraction({ id: 2, contextBytes: 100 }),
    ];

    // Weighted: (1.0 * 900 + 0.0 * 100) / (900 + 100) = 0.9
    expect(aggregateDimension(audits, interactions, "weight")).toBeCloseTo(0.9, 10);
  });

  it("uses minimum weight of 1 when contextBytes is 0", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], success: 0.5 }),
      makeAudit({ id: 2, categories: ["environment"], success: 1.0 }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, contextBytes: 0 }),
      makeInteraction({ id: 2, contextBytes: 0 }),
    ];

    // Both get w=1, so simple average: (0.5 + 1.0) / 2 = 0.75
    expect(aggregateDimension(audits, interactions, "success")).toBeCloseTo(0.75, 10);
  });

  it("falls back to w=1 when interaction is not found in the map", () => {
    const audits: InteractionAudit[] = [makeAudit({ id: 99, categories: ["environment"], contextRelevance: 0.6 })];
    // No matching interaction for id=99
    const interactions: Interaction[] = [];

    expect(aggregateDimension(audits, interactions, "contextRelevance")).toBe(0.6);
  });

  it("handles mixed found and unfound interactions", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], speed: 0.8 }),
      makeAudit({ id: 2, categories: ["environment"], speed: 0.4 }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, contextBytes: 200 }),
      // id: 2 not present — doesn't matter for speed (severity-weighted, ignores bytes)
    ];

    // Speed uses severity-weighted average: bad scores pull harder
    // w1 = (1-0.8)^2 + 1 = 1.04, w2 = (1-0.4)^2 + 1 = 1.36
    // (0.8*1.04 + 0.4*1.36) / (1.04+1.36) ≈ 0.5733
    expect(aggregateDimension(audits, interactions, "speed")).toBeCloseTo(0.5733, 3);
  });

  it("aggregates all four dimensions correctly", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], success: 0.9, speed: 0.7, weight: 0.5, contextRelevance: 0.3 }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, contextBytes: 50 })];

    expect(aggregateDimension(audits, interactions, "success")).toBeCloseTo(0.9, 10);
    expect(aggregateDimension(audits, interactions, "speed")).toBeCloseTo(0.7, 10);
    expect(aggregateDimension(audits, interactions, "weight")).toBeCloseTo(0.5, 10);
    expect(aggregateDimension(audits, interactions, "contextRelevance")).toBeCloseTo(0.3, 10);
  });
});

// ---------------------------------------------------------------------------
// computeCategoryScore
// ---------------------------------------------------------------------------

describe("computeCategoryScore", () => {
  it("returns default dimensions and score for empty audits/interactions", () => {
    const necessity = makeNecessity("environment", 0.8);
    const result = computeCategoryScore("environment", [], necessity, []);

    expect(result.interactionCount).toBe(0);
    expect(result.auditedCount).toBe(0);
    // Dimensions should reflect defaults + necessity
    expect(result.dimensions.success).toBe(Math.round(DEFAULT_AUDIT_SCORES.success * 100));
    expect(result.dimensions.speed).toBe(Math.round(DEFAULT_AUDIT_SCORES.speed * 100));
    expect(result.dimensions.weight).toBe(Math.round(DEFAULT_AUDIT_SCORES.weight * 100));
    expect(result.dimensions.relevance).toBe(Math.round(DEFAULT_AUDIT_SCORES.contextRelevance * 100));
    expect(result.dimensions.necessity).toBe(Math.round(necessity.score * 100));
    // Score should be a valid 0-100 value
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("filters interactions and audits by category", () => {
    const envAudit = makeAudit({ id: 1, categories: ["environment"], rationale: "evaluated" });
    const svcAudit = makeAudit({ id: 2, categories: ["service"], rationale: "evaluated" });

    const envInteraction = makeInteraction({ id: 1, categories: ["environment"] });
    const svcInteraction = makeInteraction({ id: 2, categories: ["service"] });

    const necessity = makeNecessity("environment", 0.8);
    const result = computeCategoryScore("environment", [envAudit, svcAudit], necessity, [
      envInteraction,
      svcInteraction,
    ]);

    expect(result.interactionCount).toBe(1);
    // Only the env audit with non-default rationale counts
    expect(result.auditedCount).toBe(1);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].id).toBe(1);
  });

  it("counts only non-default rationale audits as audited", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], rationale: "default" }),
      makeAudit({ id: 2, categories: ["environment"], rationale: "Investigated thoroughly" }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, categories: ["environment"] }),
      makeInteraction({ id: 2, categories: ["environment"] }),
    ];

    const result = computeCategoryScore("environment", audits, makeNecessity("environment", 0.8), interactions);
    expect(result.auditedCount).toBe(1);
  });

  it("produces score of 50 when rawScore matches median", () => {
    // To get rawScore == median, we need the weighted sum of dimensions to equal the median.
    // For environment: median = 0.5
    // Weights: success=0.7, speed=0.3, weight=0, relevance=0, necessity=0
    // If success=0.5 and speed=0.5, rawScore = 0.5*0.7 + 0.5*0.3 = 0.5
    const audits: InteractionAudit[] = [
      makeAudit({
        id: 1,
        categories: ["environment"],
        success: 0.5,
        speed: 0.5,
        weight: 0.5,
        contextRelevance: 0.5,
      }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, categories: ["environment"] })];
    const necessity = makeNecessity("environment", 0.5);

    const result = computeCategoryScore("environment", audits, necessity, interactions);
    expect(result.score).toBe(50);
  });

  it("uses custom calibration when provided", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["environment"], success: 0.5, speed: 0.5, weight: 0.5, contextRelevance: 0.5 }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, categories: ["environment"] })];
    const necessity = makeNecessity("environment", 0.5);

    // Custom calibration with median=0.5 so that rawScore=0.5 maps to 50
    const customCal = { median: 0.5, sigma: 0.5 };
    const result = computeCategoryScore("environment", audits, necessity, interactions, customCal);
    expect(result.score).toBe(50);
  });

  it("returns necessity in the result", () => {
    const necessity = makeNecessity("service", 0.6);
    const result = computeCategoryScore("service", [], necessity, []);
    expect(result.necessity).toBe(necessity);
  });

  it("produces consistent scores with known audits", () => {
    const audits: InteractionAudit[] = [
      makeAudit({ id: 1, categories: ["service"], success: 1.0, speed: 0.9, weight: 0.7, contextRelevance: 0.8 }),
      makeAudit({ id: 2, categories: ["service"], success: 0.8, speed: 0.6, weight: 0.5, contextRelevance: 0.6 }),
    ];
    const interactions: Interaction[] = [
      makeInteraction({ id: 1, categories: ["service"], contextBytes: 100 }),
      makeInteraction({ id: 2, categories: ["service"], contextBytes: 100 }),
    ];
    const necessity = makeNecessity("service", 0.7);

    const result = computeCategoryScore("service", audits, necessity, interactions);

    // Verify deterministic — call again and get same result
    const result2 = computeCategoryScore("service", audits, necessity, interactions);
    expect(result.score).toBe(result2.score);
    expect(result.dimensions).toEqual(result2.dimensions);

    // Score should be valid
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(result.score)).toBe(true);
  });

  it("all scores zero with necessity zero yields rawScore near 0 and logNormalScore 0", () => {
    const audits: InteractionAudit[] = [
      makeAudit({
        id: 1,
        categories: ["agent"],
        success: 0,
        speed: 0,
        weight: 0,
        contextRelevance: 0,
      }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, categories: ["agent"] })];
    const necessity = makeNecessity("agent", 0);

    const result = computeCategoryScore("agent", audits, necessity, interactions);
    // rawScore = 0, logNormalScore(0, *, *) = 0
    expect(result.score).toBe(0);
  });

  it("perfect scores yield high result", () => {
    const audits: InteractionAudit[] = [
      makeAudit({
        id: 1,
        categories: ["environment"],
        success: 1.0,
        speed: 1.0,
        weight: 1.0,
        contextRelevance: 1.0,
      }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, categories: ["environment"] })];
    const necessity = makeNecessity("environment", 1.0);

    const result = computeCategoryScore("environment", audits, necessity, interactions);
    // rawScore = 1.0, logNormalScore(1, *, *) = 100
    expect(result.score).toBe(100);
  });

  it("dimensions are rounded to integers (0-100)", () => {
    const audits: InteractionAudit[] = [
      makeAudit({
        id: 1,
        categories: ["agent"],
        success: 0.333,
        speed: 0.666,
        weight: 0.123,
        contextRelevance: 0.456,
      }),
    ];
    const interactions: Interaction[] = [makeInteraction({ id: 1, categories: ["agent"] })];
    const necessity = makeNecessity("agent", 0.789);

    const result = computeCategoryScore("agent", audits, necessity, interactions);

    expect(Number.isInteger(result.dimensions.success)).toBe(true);
    expect(Number.isInteger(result.dimensions.speed)).toBe(true);
    expect(Number.isInteger(result.dimensions.weight)).toBe(true);
    expect(Number.isInteger(result.dimensions.relevance)).toBe(true);
    expect(Number.isInteger(result.dimensions.necessity)).toBe(true);
  });

  it("works correctly for all three categories", () => {
    for (const category of ["environment", "service", "agent"] as InteractionCategory[]) {
      const audits: InteractionAudit[] = [
        makeAudit({ id: 1, categories: [category], success: 0.8, speed: 0.7, weight: 0.6, contextRelevance: 0.5 }),
      ];
      const interactions: Interaction[] = [makeInteraction({ id: 1, categories: [category] })];
      const necessity = makeNecessity(category, 0.7);

      const result = computeCategoryScore(category, audits, necessity, interactions);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.interactionCount).toBe(1);
    }
  });
});
