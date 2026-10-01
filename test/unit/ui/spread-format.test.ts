import { describe, it, expect } from "vitest";
import { formatSpreadLine, renderReportDetail } from "../../../src/ui/format.js";
import type { ReportManifest, ReportResultEntry } from "../../../src/types/report.js";
import type { ScoreResult, ScoreSpread } from "../../../src/types/scoring.js";

function makeSpread(overrides: Partial<ScoreSpread> = {}): ScoreSpread {
  return {
    n: 3,
    axisScore: { median: 86, min: 79, max: 91, mean: 85.3, stdev: 5.1 },
    representativeRunIndex: 2,
    ...overrides,
  };
}

function makeScore(axis: number): ScoreResult {
  const category = (score: number) => ({
    score,
    interactionCount: 1,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment" as const, score: 1, unnecessaryIds: [], rationale: "" },
  });
  return {
    axisScore: axis,
    goalAchievement: { score: axis, criteria: [] },
    environment: category(axis),
    service: category(axis),
    agent: category(axis),
    weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
  };
}

function makeManifest(entry: Partial<ReportResultEntry>): ReportManifest {
  return {
    version: "0.1.0",
    reportId: "2025-04-13-183042",
    timestamp: "2025-04-13T18:30:42.000Z",
    durationMs: 9000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 86 },
    results: [
      {
        scenarioKey: "cms/create-post",
        scenarioName: "Create post",
        agentName: "claude-code",
        durationMs: 2000,
        exitCode: 0,
        file: "scenarios/cms/create-post/claude-code/run-2/result.json",
        ...entry,
      },
    ],
  };
}

describe("formatSpreadLine", () => {
  it("returns null for a pair that ran once", () => {
    expect(formatSpreadLine({})).toBeNull();
    expect(formatSpreadLine({ runCount: 1 })).toBeNull();
  });

  it("summarizes runs, representative, median, range, and sigma", () => {
    const line = formatSpreadLine({
      runCount: 3,
      spread: makeSpread(),
      reliability: { succeeded: 3, total: 3, withheld: 0 },
    });

    expect(line).toBe("3 runs · representative #2 · median 86 · range 79-91 · σ 5.1");
  });

  it("omits the range and sigma when only one run scored", () => {
    const line = formatSpreadLine({
      runCount: 3,
      spread: makeSpread({ n: 1, axisScore: { median: 86, min: 86, max: 86, mean: 86, stdev: 0 } }),
      reliability: { succeeded: 1, total: 3, withheld: 0 },
    });

    expect(line).toContain("1/3 scored");
    expect(line).toContain("median 86");
    expect(line).not.toContain("range");
    expect(line).not.toContain("σ");
  });

  it("names withheld runs separately from failures", () => {
    const line = formatSpreadLine({
      runCount: 3,
      spread: makeSpread({ n: 2 }),
      reliability: { succeeded: 2, total: 2, withheld: 1 },
    });

    expect(line).toContain("2/2 scored (1 withheld)");
  });

  it("says so when nothing scored", () => {
    const line = formatSpreadLine({
      runCount: 3,
      reliability: { succeeded: 0, total: 3, withheld: 0 },
    });

    expect(line).toContain("0/3 scored");
    expect(line).toContain("no run scored");
  });

  it("does not claim a scoring failure on an unscored report", () => {
    // `--no-score`: every run finished, there was simply never a score.
    const line = formatSpreadLine({
      runCount: 3,
      reliability: { succeeded: 3, total: 3, withheld: 0 },
    });

    expect(line).toBe("3 runs");
    expect(line).not.toContain("no run scored");
  });

  it("does not report a scored count when every run scored", () => {
    const line = formatSpreadLine({
      runCount: 3,
      spread: makeSpread({ n: 3 }),
      reliability: { succeeded: 3, total: 3, withheld: 0 },
    });

    expect(line).not.toContain("scored");
  });
});

describe("renderReportDetail with repeated pairs", () => {
  it("prints the spread and a per-run breakdown under the row", () => {
    const report = makeManifest({
      score: makeScore(86),
      runCount: 3,
      spread: makeSpread(),
      reliability: { succeeded: 3, total: 3, withheld: 0 },
      runs: [
        { runIndex: 1, durationMs: 1000, exitCode: 0, axisScore: 79, file: "a" },
        { runIndex: 2, durationMs: 2000, exitCode: 0, axisScore: 86, file: "b", representative: true },
        { runIndex: 3, durationMs: 3000, exitCode: 0, axisScore: 91, file: "c" },
      ],
    });

    const out = renderReportDetail(report);

    expect(out).toContain("3 runs · representative #2 · median 86 · range 79-91 · σ 5.1");
    expect(out).toContain("runs: #1 79, #2 86*, #3 91");
    expect(out).toContain("(* representative)");
  });

  it("marks failed and withheld runs in the breakdown", () => {
    const report = makeManifest({
      score: makeScore(86),
      runCount: 3,
      spread: makeSpread({ n: 1 }),
      reliability: { succeeded: 1, total: 2, withheld: 1 },
      runs: [
        { runIndex: 1, durationMs: 1000, exitCode: 0, axisScore: 86, file: "a", representative: true },
        { runIndex: 2, durationMs: 1000, exitCode: 1, failed: true, error: "crash", file: "b" },
        { runIndex: 3, durationMs: 1000, exitCode: 1, failed: true, withheld: true, file: "c" },
      ],
    });

    const out = renderReportDetail(report);

    expect(out).toContain("#2 failed");
    expect(out).toContain("#3 withheld");
  });

  it("leaves a single-run report untouched", () => {
    const out = renderReportDetail(makeManifest({ score: makeScore(86) }));

    expect(out).not.toContain("runs:");
    expect(out).not.toContain("representative");
  });
});
