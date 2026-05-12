import { describe, it, expect } from "vitest";
import {
  getLandedTierIndex,
  getSpeedTierKind,
  getSpeedTiers,
  tierLabel,
} from "../../../src/report-ui/src/scripts/speed-tiers.js";

describe("getSpeedTierKind", () => {
  it("prefers service when present", () => {
    expect(getSpeedTierKind(["service", "environment"])).toBe("service");
  });

  it("falls back to environment when service is absent", () => {
    expect(getSpeedTierKind(["environment"])).toBe("environment");
  });

  it("defaults to agent when neither env nor service apply", () => {
    expect(getSpeedTierKind(["agent"])).toBe("agent");
    expect(getSpeedTierKind([])).toBe("agent");
  });
});

describe("getLandedTierIndex", () => {
  it("returns the perfect tier for missing duration", () => {
    expect(getLandedTierIndex(null, "environment")).toBe(0);
    expect(getLandedTierIndex(0, "service")).toBe(0);
  });

  it("matches the environment thresholds", () => {
    expect(getLandedTierIndex(400, "environment")).toBe(0); // ≤0.5s
    expect(getLandedTierIndex(1500, "environment")).toBe(1); // ≤2s
    expect(getLandedTierIndex(4000, "environment")).toBe(2); // ≤5s
    expect(getLandedTierIndex(8000, "environment")).toBe(3); // ≤10s
    expect(getLandedTierIndex(20000, "environment")).toBe(4); // > 10s
  });

  it("matches the service thresholds", () => {
    expect(getLandedTierIndex(2000, "service")).toBe(0);
    expect(getLandedTierIndex(5000, "service")).toBe(1);
    expect(getLandedTierIndex(10000, "service")).toBe(2);
    expect(getLandedTierIndex(25000, "service")).toBe(3);
    expect(getLandedTierIndex(40000, "service")).toBe(4);
  });

  it("matches the agent thresholds", () => {
    expect(getLandedTierIndex(2000, "agent")).toBe(0);
    expect(getLandedTierIndex(5000, "agent")).toBe(1);
    expect(getLandedTierIndex(15000, "agent")).toBe(2);
    expect(getLandedTierIndex(30000, "agent")).toBe(3);
    expect(getLandedTierIndex(60000, "agent")).toBe(4);
  });
});

describe("tierLabel", () => {
  it("formats bounded tiers", () => {
    const tiers = getSpeedTiers("environment");
    expect(tierLabel(tiers[0], undefined)).toBe("≤ 500ms");
    expect(tierLabel(tiers[1], tiers[0])).toBe("≤ 2s");
  });

  it("formats the open-ended tail", () => {
    const tiers = getSpeedTiers("environment");
    expect(tierLabel(tiers[tiers.length - 1], tiers[tiers.length - 2])).toBe("> 10s");
  });
});
