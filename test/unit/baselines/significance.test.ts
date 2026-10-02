import { describe, it, expect } from "vitest";
import {
  classifyEffect,
  DEFAULT_ALPHA,
  logGamma,
  regularizedIncompleteBeta,
  twoSidedPValue,
  welchTTest,
  type SampleStats,
} from "../../../src/baselines/significance.js";

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};
const sample = (xs: number[]): SampleStats => ({ mean: mean(xs), stdev: sd(xs), n: xs.length });

describe("logGamma", () => {
  it("matches exact values at integers and half-integers", () => {
    // gamma(5) = 4! = 24, gamma(1) = 1, gamma(1/2) = sqrt(pi)
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 9);
    expect(logGamma(1)).toBeCloseTo(0, 9);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 9);
  });

  it("uses reflection below 0.5", () => {
    // gamma(0.25) * gamma(0.75) = pi / sin(pi/4)
    expect(logGamma(0.25) + logGamma(0.75)).toBeCloseTo(Math.log(Math.PI / Math.sin(Math.PI / 4)), 9);
  });
});

describe("regularizedIncompleteBeta", () => {
  it("is the identity when a = b = 1", () => {
    for (const x of [0.1, 0.3, 0.5, 0.9]) {
      expect(regularizedIncompleteBeta(x, 1, 1)).toBeCloseTo(x, 9);
    }
  });

  it("saturates outside the unit interval", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    expect(regularizedIncompleteBeta(-1, 2, 3)).toBe(0);
  });

  it("satisfies the symmetry relation I_x(a,b) = 1 - I_(1-x)(b,a)", () => {
    // Exercises both branches of the continued-fraction pivot.
    for (const [x, a, b] of [
      [0.2, 2, 5],
      [0.8, 2, 5],
      [0.5, 7, 3],
    ] as const) {
      expect(regularizedIncompleteBeta(x, a, b)).toBeCloseTo(1 - regularizedIncompleteBeta(1 - x, b, a), 9);
    }
  });
});

describe("twoSidedPValue", () => {
  // The real check on the whole numerical stack: published two-sided critical
  // t values must come back out at p = 0.05, across a wide span of df.
  it.each([
    [12.706, 1],
    [4.303, 2],
    [3.182, 3],
    [2.776, 4],
    [2.306, 8],
    [2.12, 16],
    [2.042, 30],
  ])("maps the published critical value t=%s at df=%s to p≈0.05", (t, df) => {
    expect(twoSidedPValue(t, df)).toBeCloseTo(0.05, 3);
  });

  it("approaches the normal critical value as df grows", () => {
    expect(twoSidedPValue(1.96, 1e7)).toBeCloseTo(0.05, 3);
  });

  it("is 1 at t = 0 and symmetric in the sign of t", () => {
    expect(twoSidedPValue(0, 5)).toBeCloseTo(1, 9);
    expect(twoSidedPValue(2.5, 7)).toBeCloseTo(twoSidedPValue(-2.5, 7), 12);
  });

  it("returns 0 for an infinite statistic and 1 for non-positive df", () => {
    expect(twoSidedPValue(Infinity, 4)).toBe(0);
    expect(twoSidedPValue(2, 0)).toBe(1);
  });

  it("decreases monotonically as t grows", () => {
    const ps = [0.5, 1, 2, 3, 4].map((t) => twoSidedPValue(t, 6));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeLessThan(ps[i - 1]);
  });
});

describe("classifyEffect", () => {
  it("buckets by Cohen's conventions, on magnitude not sign", () => {
    expect(classifyEffect(0.1)).toBe("negligible");
    expect(classifyEffect(0.2)).toBe("small");
    expect(classifyEffect(0.5)).toBe("moderate");
    expect(classifyEffect(0.8)).toBe("large");
    expect(classifyEffect(-2.4)).toBe("large");
  });
});

describe("welchTTest", () => {
  it("declines to test when either side ran fewer than twice", () => {
    const one = { mean: 80, stdev: 0, n: 1 };
    expect(welchTTest(one, sample([70, 73, 76]))).toBeUndefined();
    expect(welchTTest(sample([70, 73, 76]), one)).toBeUndefined();
  });

  it("detects a clear drop across three runs a side", () => {
    const result = welchTTest(sample([81, 87, 92]), sample([70, 73, 76]))!;

    expect(result.delta).toBeCloseTo(-13.67, 1);
    expect(result.t).toBeCloseTo(-3.774, 2);
    expect(result.p).toBeLessThan(DEFAULT_ALPHA);
    expect(result.significant).toBe(true);
    expect(result.magnitude).toBe("large");
  });

  it("calls a small move across noisy runs insignificant", () => {
    const result = welchTTest(sample([70, 80, 90]), sample([72, 82, 92]))!;

    expect(result.significant).toBe(false);
    expect(result.p).toBeGreaterThan(DEFAULT_ALPHA);
  });

  it("gets more sensitive as the samples grow", () => {
    // The same mean shift and the same spread, sampled more heavily, must
    // eventually clear the bar. This is the whole reason for preferring a test
    // over the fixed band, which never tightens.
    const spread = [-2, 0, 2];
    const base = (n: number, centre: number) => {
      const xs = Array.from({ length: n }, (_, i) => centre + spread[i % spread.length]);
      return sample(xs);
    };
    const small = welchTTest(base(3, 80), base(3, 82.5))!;
    const large = welchTTest(base(15, 80), base(15, 82.5))!;

    expect(small.significant).toBe(false);
    expect(large.significant).toBe(true);
    expect(large.p).toBeLessThan(small.p);
  });

  it("does not assume equal variances", () => {
    // One tight sample against one scattered one. Welch's degrees of freedom
    // fall well below the pooled n1+n2-2 = 10 a Student's test would use.
    const result = welchTTest(sample([80, 80, 80, 81, 79]), sample([60, 100, 70, 95, 75]))!;

    expect(result.df).toBeLessThan(10);
    expect(result.df).toBeGreaterThan(1);
  });

  it("respects a custom alpha", () => {
    const tight = welchTTest(sample([80, 81, 82]), sample([76, 77, 78]))!;
    expect(tight.significant).toBe(true);
    expect(welchTTest(sample([80, 81, 82]), sample([76, 77, 78]), 0.0001)!.significant).toBe(false);
  });

  describe("samples with no spread at all", () => {
    // Common for a trivial scenario where every run scores 100.
    it("reports no difference as certainly unchanged", () => {
      const result = welchTTest({ mean: 100, stdev: 0, n: 3 }, { mean: 100, stdev: 0, n: 3 })!;

      expect(result.delta).toBe(0);
      expect(result.p).toBe(1);
      expect(result.significant).toBe(false);
      expect(result.magnitude).toBe("negligible");
    });

    it("reports any difference as certain, without inventing a t or an effect size", () => {
      const result = welchTTest({ mean: 100, stdev: 0, n: 3 }, { mean: 90, stdev: 0, n: 3 })!;

      expect(result.delta).toBe(-10);
      expect(result.p).toBe(0);
      expect(result.significant).toBe(true);
      // Both are infinite here, and an infinite d would label a 0.1 point gap
      // "large". Omitted instead.
      expect(result.t).toBeUndefined();
      expect(result.effectSize).toBeUndefined();
      expect(result.magnitude).toBeUndefined();
    });

    it("stays representable in JSON, which has no Infinity", () => {
      const result = welchTTest({ mean: 100, stdev: 0, n: 3 }, { mean: 90, stdev: 0, n: 3 });
      const roundTripped = JSON.parse(JSON.stringify(result));

      expect(JSON.stringify(result)).not.toContain("null");
      expect(roundTripped).toEqual(result);
    });
  });

  it("never returns a non-finite number in the ordinary case", () => {
    const result = welchTTest(sample([81, 87, 92]), sample([70, 73, 76]))!;
    for (const value of [result.delta, result.t, result.df, result.p, result.effectSize]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
