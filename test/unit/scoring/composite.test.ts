import { describe, it, expect } from "vitest";
import { computeComposite, validateWeights } from "../../../src/scoring/composite.js";

describe("computeComposite", () => {
  const defaultWeights = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

  it("computes weighted average with default weights", () => {
    // (100*0.4) + (80*0.2) + (60*0.2) + (90*0.2) = 40 + 16 + 12 + 18 = 86
    expect(computeComposite(100, 80, 60, 90, defaultWeights)).toBe(86);
  });

  it("returns 100 when all scores are 100", () => {
    expect(computeComposite(100, 100, 100, 100, defaultWeights)).toBe(100);
  });

  it("returns 0 when all scores are 0", () => {
    expect(computeComposite(0, 0, 0, 0, defaultWeights)).toBe(0);
  });

  it("handles custom weights", () => {
    const weights = { goal_achievement: 1.0, environment: 0, service: 0, agent: 0 };
    expect(computeComposite(75, 100, 100, 100, weights)).toBe(75);
  });

  it("rounds to nearest integer", () => {
    // (90*0.4) + (70*0.2) + (50*0.2) + (80*0.2) = 36 + 14 + 10 + 16 = 76
    expect(computeComposite(90, 70, 50, 80, defaultWeights)).toBe(76);
  });

  it("rejects negative weights", () => {
    expect(() =>
      computeComposite(100, 100, 100, 100, { goal_achievement: -0.4, environment: 0.6, service: 0.4, agent: 0.4 }),
    ).toThrow("non-negative");
  });

  it("rejects weights that do not sum to 1.0", () => {
    expect(() =>
      computeComposite(100, 100, 100, 100, { goal_achievement: 0.5, environment: 0.5, service: 0.5, agent: 0.5 }),
    ).toThrow("sum to 1.0");
  });

  it("rejects all-zero weights", () => {
    expect(() =>
      computeComposite(100, 100, 100, 100, { goal_achievement: 0, environment: 0, service: 0, agent: 0 }),
    ).toThrow("must not all be zero");
  });
});

describe("validateWeights", () => {
  it("accepts valid weights", () => {
    expect(() => validateWeights({ goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 })).not.toThrow();
  });

  it("accepts weights within tolerance", () => {
    // 0.7 + 0.1 + 0.1 + 0.1 = 1.0 (but floating point might be 0.9999...)
    expect(() => validateWeights({ goal_achievement: 0.7, environment: 0.1, service: 0.1, agent: 0.1 })).not.toThrow();
  });
});
