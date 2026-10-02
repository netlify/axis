import { describe, it, expect } from "vitest";
import { compareBaseline } from "../../../src/baselines/compare.js";
import { collectMetricStats } from "../../../src/baselines/metrics.js";
import type { Baseline, BaselineEntry, MetricKey, SampleStats } from "../../../src/types/baseline.js";
import type { ReportManifest, ReportResultEntry, ReportRunEntry } from "../../../src/types/report.js";
import type { ScoreResult } from "../../../src/types/scoring.js";

const WEIGHTS = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

function makeScore(axis: number, dims: Partial<Record<"g" | "e" | "s" | "a", number>> = {}): ScoreResult {
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
    goalAchievement: { score: dims.g ?? axis, criteria: [] },
    environment: category(dims.e ?? axis),
    service: category(dims.s ?? axis),
    agent: category(dims.a ?? axis),
    weights: WEIGHTS,
  };
}

const stats = (mean: number, stdev: number, n = 3): SampleStats => ({ mean, stdev, n });

/** Baseline entry with per-metric distributions, as a repeated pair produces. */
function makeBaselineEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    axisScore: 80,
    goalAchievement: 80,
    environment: 80,
    service: 80,
    agent: 80,
    durationMs: 100_000,
    tokens: 200_000,
    runs: 3,
    stdev: 2,
    reliability: 1,
    stats: {
      axisScore: stats(80, 2),
      goalAchievement: stats(80, 2),
      environment: stats(80, 2),
      service: stats(80, 2),
      agent: stats(80, 2),
      durationMs: stats(100_000, 3000),
      tokens: stats(200_000, 5000),
    },
    fromReportId: "r1",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBaseline(entry: BaselineEntry): Baseline {
  return { name: "default", createdAt: "", updatedAt: "", results: { s1: { a1: entry } } };
}

function makeRun(runIndex: number, axis: number, durationMs: number, tokens: number): ReportRunEntry {
  return {
    runIndex,
    durationMs,
    exitCode: 0,
    axisScore: axis,
    dimensionScores: { goalAchievement: axis, environment: axis, service: axis, agent: axis },
    tokenUsage: { input: tokens, output: 0 },
    file: `run-${runIndex}`,
  };
}

function makeReport(result: Partial<ReportResultEntry> & { score?: ScoreResult }): ReportManifest {
  return {
    version: "1",
    reportId: "r2",
    timestamp: "2026-01-02T00:00:00.000Z",
    durationMs: 1,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: result.score?.axisScore ?? 0 },
    results: [
      {
        scenarioKey: "s1",
        scenarioName: "S1",
        agentName: "a1",
        durationMs: 100_000,
        exitCode: 0,
        file: "f",
        tokenUsage: { input: 200_000, output: 0 },
        ...result,
      },
    ],
  };
}

/** The metrics list for the single compared pair. */
function metricsOf(baseline: Baseline, report: ReportManifest) {
  const diff = compareBaseline(baseline, report);
  return new Map(diff.entries[0].metrics.map((m) => [m.metric, m]));
}

describe("collectMetricStats", () => {
  it("summarizes every metric across a pair's runs", () => {
    const result = makeReport({
      score: makeScore(80),
      runCount: 3,
      runs: [makeRun(1, 78, 90_000, 190_000), makeRun(2, 80, 100_000, 200_000), makeRun(3, 82, 110_000, 210_000)],
    }).results[0];

    const collected = collectMetricStats(result)!;

    expect(collected.axisScore).toEqual({ mean: 80, stdev: 2, n: 3 });
    expect(collected.durationMs?.mean).toBe(100_000);
    expect(collected.tokens?.mean).toBe(200_000);
    expect(collected.goalAchievement?.n).toBe(3);
  });

  it("returns nothing for a pair that ran once, which has no distribution", () => {
    expect(collectMetricStats(makeReport({ score: makeScore(80) }).results[0])).toBeUndefined();
  });

  it("excludes failed and withheld runs rather than averaging in their zeros", () => {
    const result = makeReport({
      score: makeScore(80),
      runCount: 4,
      runs: [
        makeRun(1, 80, 100_000, 200_000),
        makeRun(2, 82, 100_000, 200_000),
        { runIndex: 3, durationMs: 1, exitCode: 1, failed: true, file: "c" },
        { runIndex: 4, durationMs: 1, exitCode: 1, failed: true, withheld: true, file: "d" },
      ],
    }).results[0];

    const collected = collectMetricStats(result)!;

    expect(collected.axisScore?.n).toBe(2);
    expect(collected.axisScore?.mean).toBe(81);
  });

  it("returns nothing when only one run survived", () => {
    const result = makeReport({
      score: makeScore(80),
      runCount: 3,
      runs: [
        makeRun(1, 80, 100_000, 200_000),
        { runIndex: 2, durationMs: 1, exitCode: 1, failed: true, file: "b" },
        { runIndex: 3, durationMs: 1, exitCode: 1, failed: true, file: "c" },
      ],
    }).results[0];

    expect(collectMetricStats(result)).toBeUndefined();
  });
});

describe("per-metric comparison", () => {
  it("reports every metric, including duration and tokens", () => {
    const metrics = metricsOf(makeBaseline(makeBaselineEntry()), makeReport({ score: makeScore(80) }));

    const expected: MetricKey[] = [
      "axisScore",
      "goalAchievement",
      "environment",
      "service",
      "agent",
      "durationMs",
      "tokens",
    ];
    for (const key of expected) expect(metrics.has(key)).toBe(true);
  });

  it("keeps the simple band verdict even when no distribution exists", () => {
    // Single-run baseline and single-run report: nothing to test, but the
    // original delta-against-a-band view still has to work.
    const metrics = metricsOf(
      makeBaseline(makeBaselineEntry({ runs: undefined, stdev: undefined, stats: undefined })),
      makeReport({ score: makeScore(60) }),
    );

    const axis = metrics.get("axisScore")!;
    expect(axis.delta).toBe(-20);
    expect(axis.bandVerdict).toBe("regressed");
    expect(axis.significance).toBeUndefined();
  });

  it("omits the test when only one side has a distribution", () => {
    const metrics = metricsOf(
      makeBaseline(makeBaselineEntry()),
      makeReport({ score: makeScore(80) }), // no runs[] -> no current stats
    );

    expect(metrics.get("axisScore")!.significance).toBeUndefined();
  });

  it("adds the test when both sides have one", () => {
    const metrics = metricsOf(
      makeBaseline(makeBaselineEntry()),
      makeReport({
        score: makeScore(70),
        runCount: 3,
        runs: [makeRun(1, 68, 100_000, 200_000), makeRun(2, 70, 100_000, 200_000), makeRun(3, 72, 100_000, 200_000)],
      }),
    );

    const axis = metrics.get("axisScore")!.significance!;
    expect(axis.baseline.n).toBe(3);
    expect(axis.current.n).toBe(3);
    expect(axis.significant).toBe(true);
    expect(axis.verdict).toBe("regressed");
    expect(axis.p).toBeLessThan(0.05);
  });
});

describe("metric polarity", () => {
  const faster = makeReport({
    score: makeScore(80),
    durationMs: 60_000,
    tokenUsage: { input: 120_000, output: 0 },
    runCount: 3,
    runs: [makeRun(1, 80, 58_000, 118_000), makeRun(2, 80, 60_000, 120_000), makeRun(3, 80, 62_000, 122_000)],
  });

  it("treats a drop in duration as an improvement", () => {
    const duration = metricsOf(makeBaseline(makeBaselineEntry()), faster).get("durationMs")!;

    expect(duration.direction).toBe("lower-is-better");
    expect(duration.delta).toBeLessThan(0);
    expect(duration.bandVerdict).toBe("improved");
    expect(duration.significance!.verdict).toBe("improved");
  });

  it("treats a drop in tokens as an improvement", () => {
    const tokens = metricsOf(makeBaseline(makeBaselineEntry()), faster).get("tokens")!;

    expect(tokens.delta).toBeLessThan(0);
    expect(tokens.bandVerdict).toBe("improved");
    expect(tokens.significance!.verdict).toBe("improved");
  });

  it("treats the same drop in a score dimension as a regression", () => {
    const slower = makeReport({
      score: makeScore(70),
      runCount: 3,
      runs: [makeRun(1, 70, 100_000, 200_000), makeRun(2, 70, 100_000, 200_000), makeRun(3, 70, 100_000, 200_000)],
    });
    const goal = metricsOf(makeBaseline(makeBaselineEntry()), slower).get("goalAchievement")!;

    expect(goal.direction).toBe("higher-is-better");
    expect(goal.delta).toBeLessThan(0);
    expect(goal.bandVerdict).toBe("regressed");
  });

  it("calls an insignificant move unchanged whichever way it fell", () => {
    const noise = makeReport({
      score: makeScore(80),
      runCount: 3,
      runs: [makeRun(1, 78, 99_000, 199_000), makeRun(2, 80, 100_000, 200_000), makeRun(3, 82, 101_000, 201_000)],
    });
    const axis = metricsOf(makeBaseline(makeBaselineEntry()), noise).get("axisScore")!.significance!;

    expect(axis.significant).toBe(false);
    expect(axis.verdict).toBe("unchanged");
  });
});

describe("tolerances", () => {
  it("uses a relative floor for duration and tokens, not the one-point score floor", () => {
    // A 1 ms or 1 token tolerance would flag every run as changed.
    const metrics = metricsOf(
      makeBaseline(makeBaselineEntry({ stats: undefined, runs: undefined, stdev: undefined })),
      makeReport({ score: makeScore(80) }),
    );

    expect(metrics.get("axisScore")!.band).toBe(1);
    expect(metrics.get("durationMs")!.band).toBe(10_000);
    expect(metrics.get("tokens")!.band).toBe(20_000);
  });

  it("widens a metric's band to two sigma of its own measured spread", () => {
    const metrics = metricsOf(
      makeBaseline(makeBaselineEntry({ stats: { axisScore: stats(80, 6) } })),
      makeReport({ score: makeScore(80) }),
    );

    expect(metrics.get("axisScore")!.band).toBe(12);
  });
});

describe("the two verdicts are reported independently", () => {
  it("can disagree, since the band and the test are different questions", () => {
    // Delta of 3.5 against a measured sigma of 2: outside the 2-sigma band, but
    // at three runs a side the test needs about 2.27 sigma of separation in
    // means and the means here differ by less once spread is accounted for.
    const diff = compareBaseline(
      makeBaseline(makeBaselineEntry({ axisScore: 80, stats: { axisScore: stats(80, 2) } })),
      makeReport({
        score: makeScore(75),
        runCount: 3,
        runs: [makeRun(1, 68, 100_000, 200_000), makeRun(2, 75, 100_000, 200_000), makeRun(3, 88, 100_000, 200_000)],
      }),
    );

    const axis = diff.entries[0].metrics.find((m) => m.metric === "axisScore")!;
    // The representative moved well past the band...
    expect(axis.bandVerdict).toBe("regressed");
    // ...but the current runs are scattered enough that the test cannot
    // separate the two samples. Both verdicts are kept rather than one winning.
    expect(axis.significance!.significant).toBe(false);
    expect(axis.significance!.verdict).toBe("unchanged");
  });

  it("tallies significance alongside the band without changing the band tally", () => {
    const diff = compareBaseline(
      makeBaseline(makeBaselineEntry()),
      makeReport({
        score: makeScore(70),
        runCount: 3,
        runs: [makeRun(1, 68, 100_000, 200_000), makeRun(2, 70, 100_000, 200_000), makeRun(3, 72, 100_000, 200_000)],
      }),
    );

    expect(diff.summary.regressed).toBe(1);
    expect(diff.summary.significant).toEqual({ improved: 0, regressed: 1, unchanged: 0 });
  });

  it("omits the significance tally when nothing could be tested", () => {
    const diff = compareBaseline(
      makeBaseline(makeBaselineEntry({ stats: undefined })),
      makeReport({ score: makeScore(70) }),
    );

    expect(diff.summary.significant).toBeUndefined();
    // The original tally is unaffected, so the exit code is unchanged.
    expect(diff.summary.regressed).toBe(1);
  });
});
