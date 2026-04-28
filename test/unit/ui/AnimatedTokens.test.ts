import { describe, it, expect } from "vitest";
import { nextDisplayed } from "../../../src/ui/AnimatedTokens.js";

describe("nextDisplayed", () => {
  it("returns current when already at target", () => {
    expect(nextDisplayed(100, 100)).toBe(100);
  });

  it("returns current when ahead of target (never decreases)", () => {
    expect(nextDisplayed(200, 100)).toBe(200);
  });

  it("never overshoots the target", () => {
    // Step for (target - current = 3) is ceil(3 * 0.12) = 1, bounded by target.
    expect(nextDisplayed(99, 100)).toBe(100);
    expect(nextDisplayed(95, 100)).toBe(96);
  });

  it("increases by at least 1 when behind", () => {
    // remaining = 4, ceil(4 * 0.12) = 1 → step 1
    expect(nextDisplayed(0, 4)).toBe(1);
    // remaining = 1
    expect(nextDisplayed(0, 1)).toBe(1);
  });

  it("closes a fraction of the gap for large gaps (ease-out)", () => {
    const current = 0;
    const target = 10_000;
    const next = nextDisplayed(current, target);
    // 0.12 * 10_000 = 1200, ceil to 1200
    expect(next).toBe(1200);
    expect(next).toBeLessThan(target);
  });

  it("converges to target in a bounded number of ticks", () => {
    let current = 0;
    const target = 10_000;
    let ticks = 0;
    while (current < target && ticks < 200) {
      current = nextDisplayed(current, target);
      ticks++;
    }
    expect(current).toBe(target);
    // Ease-out with 0.12 factor converges relatively quickly.
    expect(ticks).toBeLessThan(100);
  });

  it("is strictly monotonically increasing while below target", () => {
    let current = 0;
    const target = 500;
    const seen: number[] = [current];
    while (current < target) {
      current = nextDisplayed(current, target);
      seen.push(current);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
    expect(seen[seen.length - 1]).toBe(target);
  });
});
