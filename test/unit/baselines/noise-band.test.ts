import { describe, it, expect } from "vitest";
import { compareBaseline, noiseBand } from "../../../src/baselines/compare.js";
import { setBaseline } from "../../../src/baselines/store.js";
import type { Baseline, BaselineEntry } from "../../../src/types/baseline.js";
import type { ReportManifest, ReportResultEntry } from "../../../src/types/report.js";
import type { ScoreResult } from "../../../src/types/scoring.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    axisScore: 85,
    goalAchievement: 85,
    environment: 85,
    service: 85,
    agent: 85,
    durationMs: 1000,
    tokens: 100,
    fromReportId: "r1",
    timestamp: "2025-04-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeBaseline(entry: BaselineEntry): Baseline {
  return {
    name: "default",
    createdAt: "2025-04-13T00:00:00.000Z",
    updatedAt: "2025-04-13T00:00:00.000Z",
    results: { s1: { a1: entry } },
  };
}

function makeReport(result: Partial<ReportResultEntry> & { score: ScoreResult }): ReportManifest {
  return {
    version: "0.1.0",
    reportId: "r2",
    timestamp: "2025-04-14T00:00:00.000Z",
    durationMs: 1000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: result.score.axisScore },
    results: [
      {
        scenarioKey: "s1",
        scenarioName: "S1",
        agentName: "a1",
        durationMs: 1000,
        exitCode: 0,
        file: "scenarios/s1/a1.json",
        ...result,
      },
    ],
  };
}

describe("noiseBand", () => {
  it("falls back to the flat floor when the baseline measured no spread", () => {
    expect(noiseBand(makeEntry())).toBe(1);
  });

  it("widens to two sigma of the measured spread", () => {
    expect(noiseBand(makeEntry({ stdev: 4 }))).toBe(8);
  });

  it("never drops below the floor for a very tight spread", () => {
    expect(noiseBand(makeEntry({ stdev: 0.1 }))).toBe(1);
  });
});

describe("compareBaseline with a measured band", () => {
  it("treats a drop inside the measured noise as unchanged", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85, stdev: 5, runs: 3 }));
    const report = makeReport({ score: makeScore(78) });

    const diff = compareBaseline(baseline, report);

    // -7 is inside the +/-10 band this baseline measured for itself.
    expect(diff.entries[0].delta).toBe(-7);
    expect(diff.entries[0].band).toBe(10);
    expect(diff.summary.unchanged).toBe(1);
    expect(diff.summary.regressed).toBe(0);
  });

  it("still flags a drop that clears the measured noise", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85, stdev: 2, runs: 3 }));
    const report = makeReport({ score: makeScore(70) });

    const diff = compareBaseline(baseline, report);

    expect(diff.entries[0].band).toBe(4);
    expect(diff.summary.regressed).toBe(1);
  });

  it("keeps the old single-point behaviour for a baseline without spread", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85 }));

    expect(compareBaseline(baseline, makeReport({ score: makeScore(84) })).summary.unchanged).toBe(1);
    expect(compareBaseline(baseline, makeReport({ score: makeScore(80) })).summary.regressed).toBe(1);
  });

  it("counts a reliability drop as a regression even when the score holds", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85, stdev: 1, runs: 3, reliability: 1 }));
    const report = makeReport({
      score: makeScore(85),
      runCount: 3,
      reliability: { succeeded: 2, total: 3, withheld: 0 },
    });

    const diff = compareBaseline(baseline, report);

    expect(diff.entries[0].delta).toBe(0);
    expect(diff.entries[0].reliability).toEqual({ baseline: 1, current: 2 / 3, delta: 2 / 3 - 1 });
    expect(diff.summary.regressed).toBe(1);
  });

  it("does not flag a reliability improvement as a regression", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85, runs: 3, reliability: 2 / 3 }));
    const report = makeReport({
      score: makeScore(85),
      runCount: 3,
      reliability: { succeeded: 3, total: 3, withheld: 0 },
    });

    const diff = compareBaseline(baseline, report);

    expect(diff.summary.regressed).toBe(0);
    expect(diff.summary.unchanged).toBe(1);
  });

  it("ignores withheld runs when computing current reliability", () => {
    const baseline = makeBaseline(makeEntry({ axisScore: 85, runs: 3, reliability: 1 }));
    const report = makeReport({
      score: makeScore(85),
      runCount: 3,
      // Two measurable runs, both succeeded; the third was a judge outage.
      reliability: { succeeded: 2, total: 2, withheld: 1 },
    });

    const diff = compareBaseline(baseline, report);

    expect(diff.entries[0].reliability?.current).toBe(1);
    expect(diff.summary.regressed).toBe(0);
  });
});

describe("setBaseline records the measured spread", () => {
  let configDir: string;

  it("stores runs, stdev, and reliability from a repeated pair", () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-baseline-spread-"));
    try {
      const report = makeReport({
        score: makeScore(85),
        runCount: 3,
        reliability: { succeeded: 3, total: 3, withheld: 0 },
        spread: {
          n: 3,
          axisScore: { median: 85, min: 80, max: 90, mean: 85, stdev: 5 },
          representativeRunIndex: 2,
        },
      });

      const baseline = setBaseline(configDir, report, "default");
      const entry = baseline.results.s1.a1;

      expect(entry.runs).toBe(3);
      expect(entry.stdev).toBe(5);
      expect(entry.reliability).toBe(1);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("omits the spread fields for a single-run pair", () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-baseline-spread-"));
    try {
      const baseline = setBaseline(configDir, makeReport({ score: makeScore(85) }), "default");
      const entry = baseline.results.s1.a1;

      expect(entry.runs).toBeUndefined();
      expect(entry.stdev).toBeUndefined();
      expect(entry.reliability).toBeUndefined();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
