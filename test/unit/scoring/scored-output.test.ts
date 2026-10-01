import { describe, it, expect } from "vitest";
import { buildScoredOutput } from "../../../src/scoring/index.js";
import type { RunOutput } from "../../../src/types/output.js";
import type { ScoredRunResult, ScoringWeights } from "../../../src/types/scoring.js";

const WEIGHTS: ScoringWeights = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

function makeScoredRun(opts: {
  scenarioKey: string;
  axis: number;
  runIndex?: number;
  runCount?: number;
  failed?: boolean;
  withheld?: boolean;
}): ScoredRunResult {
  const broken = (opts.failed ?? false) || (opts.withheld ?? false);
  const now = new Date().toISOString();
  const category = (score: number) => ({
    score,
    interactionCount: 1,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment" as const, score: 1, unnecessaryIds: [], rationale: "" },
  });

  return {
    scenarioKey: opts.scenarioKey,
    scenarioName: opts.scenarioKey,
    agentName: "a1",
    ...(opts.runIndex !== undefined ? { runIndex: opts.runIndex } : {}),
    ...(opts.runCount !== undefined ? { runCount: opts.runCount } : {}),
    prompt: "p",
    judge: "j",
    agentConfig: { agent: "mock" },
    output: {
      transcript: [{ type: "assistant", timestamp: now, content: { text: "x" } }],
      result: "ok",
      metadata: {
        startTime: now,
        endTime: now,
        durationMs: 10,
        exitCode: broken ? 1 : 0,
        ...(broken ? { error: "boom" } : {}),
      },
    },
    score: {
      axisScore: opts.axis,
      goalAchievement: { score: opts.axis, criteria: [] },
      environment: category(opts.axis),
      service: category(opts.axis),
      agent: category(opts.axis),
      weights: WEIGHTS,
      ...(opts.withheld ? { withheld: true } : {}),
    },
  } as ScoredRunResult;
}

function makeRunOutput(pairs: number, runsTotal?: number): RunOutput {
  return {
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    durationMs: 100,
    results: [],
    summary: {
      total: pairs,
      completed: pairs,
      failed: 0,
      ...(runsTotal !== undefined ? { runsTotal, runsFailed: 0 } : {}),
    },
  };
}

describe("buildScoredOutput", () => {
  it("averages one representative per pair rather than every run", () => {
    // Pair `a` runs three times and scores high; pair `b` runs once and scores
    // low. Averaging all four runs would give 80; averaging per pair gives 55.
    const results = [
      makeScoredRun({ scenarioKey: "a", axis: 90, runIndex: 1, runCount: 3 }),
      makeScoredRun({ scenarioKey: "a", axis: 90, runIndex: 2, runCount: 3 }),
      makeScoredRun({ scenarioKey: "a", axis: 90, runIndex: 3, runCount: 3 }),
      makeScoredRun({ scenarioKey: "b", axis: 20 }),
    ];

    const output = buildScoredOutput(makeRunOutput(2, 4), results);

    expect(output.summary.averageAxisScore).toBe(55);
  });

  it("is unchanged for a suite where every pair ran once", () => {
    const results = [makeScoredRun({ scenarioKey: "a", axis: 90 }), makeScoredRun({ scenarioKey: "b", axis: 70 })];

    const output = buildScoredOutput(makeRunOutput(2), results);

    expect(output.summary.averageAxisScore).toBe(80);
    expect(output.summary.runsTotal).toBeUndefined();
    expect(output.summary.runsFailed).toBeUndefined();
  });

  it("counts a pair as completed when any of its runs scored", () => {
    const results = [
      makeScoredRun({ scenarioKey: "a", axis: 0, runIndex: 1, runCount: 2, failed: true }),
      makeScoredRun({ scenarioKey: "a", axis: 84, runIndex: 2, runCount: 2 }),
    ];

    const output = buildScoredOutput(makeRunOutput(1, 2), results);

    expect(output.summary.completed).toBe(1);
    expect(output.summary.failed).toBe(0);
    expect(output.summary.runsFailed).toBe(1);
    // The surviving run is the representative, so it sets the average.
    expect(output.summary.averageAxisScore).toBe(84);
  });

  it("fails a pair only when no run scored", () => {
    const results = [
      makeScoredRun({ scenarioKey: "a", axis: 0, runIndex: 1, runCount: 2, failed: true }),
      makeScoredRun({ scenarioKey: "a", axis: 0, runIndex: 2, runCount: 2, failed: true }),
    ];

    const output = buildScoredOutput(makeRunOutput(1, 2), results);

    expect(output.summary.completed).toBe(0);
    expect(output.summary.failed).toBe(1);
    expect(output.summary.averageAxisScore).toBe(0);
  });

  it("excludes withheld runs from the average", () => {
    const results = [
      makeScoredRun({ scenarioKey: "a", axis: 88, runIndex: 1, runCount: 2 }),
      makeScoredRun({ scenarioKey: "a", axis: 0, runIndex: 2, runCount: 2, withheld: true }),
    ];

    const output = buildScoredOutput(makeRunOutput(1, 2), results);

    expect(output.summary.averageAxisScore).toBe(88);
    expect(output.summary.completed).toBe(1);
  });
});
