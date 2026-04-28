import { describe, it, expect, vi } from "vitest";
import { createTokenEstimator } from "../../../../src/adapters/utils/token-estimator.js";

describe("createTokenEstimator", () => {
  it("estimates tokens as ceil(chars / 5)", () => {
    const e = createTokenEstimator();
    e.addText("x".repeat(25));
    expect(e.current()).toBe(5);

    e.addText("x".repeat(3));
    // 28 chars → ceil(28 / 5) = 6
    expect(e.current()).toBe(6);
  });

  it("only calls onProgress when estimate grows by at least 5 tokens", () => {
    const onProgress = vi.fn();
    const e = createTokenEstimator(onProgress);

    // 20 chars → 4 tokens (below 5 threshold)
    e.addText("x".repeat(20));
    expect(onProgress).not.toHaveBeenCalled();

    // 5 more chars → 5 tokens total (delta 5, at threshold) → fires
    e.addText("x".repeat(5));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(5);

    // 4 more chars → 6 tokens (delta 1 from last emit) → no fire
    e.addText("x".repeat(4));
    expect(onProgress).toHaveBeenCalledTimes(1);

    // Enough more to cross the next threshold (10 total)
    e.addText("x".repeat(30));
    // 20+5+4+30 = 59 → ceil(59/5) = 12, delta 7 from 5 → fires
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(12);
  });

  it("emissions are monotonically non-decreasing", () => {
    const values: number[] = [];
    const e = createTokenEstimator((n) => values.push(n));

    for (let i = 0; i < 20; i++) {
      e.addText("x".repeat(7));
    }

    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it("ignores empty strings", () => {
    const onProgress = vi.fn();
    const e = createTokenEstimator(onProgress);
    e.addText("");
    expect(e.current()).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("works without an onProgress callback", () => {
    const e = createTokenEstimator();
    e.addText("hello world");
    expect(e.current()).toBe(Math.ceil(11 / 5));
  });

  it("is conservative: estimate stays below the common ~chars/4 ratio", () => {
    const text = "x".repeat(1000);
    const e = createTokenEstimator();
    e.addText(text);
    const estimate = e.current();
    const typicalActual = Math.ceil(1000 / 4);
    expect(estimate).toBeLessThan(typicalActual);
  });
});
