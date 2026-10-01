import { describe, it, expect } from "vitest";
import {
  aggregateByPair,
  aggregatePair,
  computeReliability,
  computeSpread,
  computeSpreadStats,
  groupRunsByPair,
  median,
  pairKey,
  partitionRuns,
  selectNearestMedian,
  selectRepresentative,
  stdev,
} from "../../../src/scoring/aggregate.js";
import type { ScoredRunResult, ScoringWeights } from "../../../src/types/scoring.js";
import type { AgentOutput } from "../../../src/types/agent.js";

const WEIGHTS: ScoringWeights = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

interface RunSpec {
  runIndex: number;
  goal?: number;
  env?: number;
  svc?: number;
  agent?: number;
  axis?: number;
  /** Agent-side failure: sets an error on metadata. */
  failed?: boolean;
  /** Judge-side failure: sets `score.withheld`. */
  withheld?: boolean;
  scenarioKey?: string;
  agentName?: string;
}

function makeOutput(failed: boolean): AgentOutput {
  const now = new Date().toISOString();
  return {
    transcript: [{ type: "assistant", timestamp: now, content: { text: "work" } }],
    result: "done",
    metadata: {
      startTime: now,
      endTime: now,
      durationMs: 1000,
      exitCode: failed ? 1 : 0,
      ...(failed ? { error: "agent exploded" } : {}),
    },
  } as AgentOutput;
}

function makeRun(spec: RunSpec): ScoredRunResult {
  const goal = spec.goal ?? 80;
  const env = spec.env ?? 80;
  const svc = spec.svc ?? 80;
  const agent = spec.agent ?? 80;
  const failed = spec.failed ?? false;
  const withheld = spec.withheld ?? false;

  const category = (score: number) => ({
    score,
    interactionCount: 1,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment" as const, score: 1, unnecessaryIds: [], rationale: "" },
  });

  return {
    scenarioKey: spec.scenarioKey ?? "s1",
    scenarioName: "S1",
    agentName: spec.agentName ?? "a1",
    runIndex: spec.runIndex,
    runCount: 3,
    prompt: "p",
    judge: "j",
    agentConfig: { agent: "mock" },
    // A withheld run carries an error too (scoring stamps one), which is
    // exactly why the flag has to be what distinguishes the two cases.
    output: makeOutput(failed || withheld),
    score: {
      axisScore: spec.axis ?? Math.round(goal * 0.4 + env * 0.2 + svc * 0.2 + agent * 0.2),
      goalAchievement: { score: goal, criteria: [] },
      environment: category(env),
      service: category(svc),
      agent: category(agent),
      weights: WEIGHTS,
      ...(withheld ? { withheld: true } : {}),
    },
  } as ScoredRunResult;
}

describe("median", () => {
  it("returns the middle value for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("stdev", () => {
  it("is zero for fewer than two values", () => {
    expect(stdev([])).toBe(0);
    expect(stdev([42])).toBe(0);
  });

  it("uses the sample (n-1) denominator", () => {
    // mean 2, deviations -1/0/1, sum of squares 2, /(3-1) = 1, sqrt = 1
    expect(stdev([1, 2, 3])).toBe(1);
  });
});

describe("computeSpreadStats", () => {
  it("summarizes a set of scores", () => {
    const stats = computeSpreadStats([84, 87, 90]);
    expect(stats.median).toBe(87);
    expect(stats.min).toBe(84);
    expect(stats.max).toBe(90);
    expect(stats.mean).toBe(87);
    expect(stats.stdev).toBe(3);
  });

  it("returns zeros for an empty set", () => {
    expect(computeSpreadStats([])).toEqual({ median: 0, min: 0, max: 0, mean: 0, stdev: 0 });
  });
});

describe("partitionRuns", () => {
  it("separates scored, agent-failed, and judge-withheld runs", () => {
    const runs = [
      makeRun({ runIndex: 1 }),
      makeRun({ runIndex: 2, failed: true }),
      makeRun({ runIndex: 3, withheld: true }),
    ];

    const { scored, failed, withheld } = partitionRuns(runs);

    expect(scored.map((r) => r.runIndex)).toEqual([1]);
    expect(failed.map((r) => r.runIndex)).toEqual([2]);
    expect(withheld.map((r) => r.runIndex)).toEqual([3]);
  });

  it("classifies a withheld run as withheld even though it also carries an error", () => {
    const withheldRun = makeRun({ runIndex: 1, withheld: true });
    // Guard the premise: scoring marks withheld runs as failed runs too.
    expect(withheldRun.output.metadata.error).toBeDefined();

    const { failed, withheld } = partitionRuns([withheldRun]);
    expect(failed).toHaveLength(0);
    expect(withheld).toHaveLength(1);
  });
});

describe("selectNearestMedian", () => {
  const item = (runIndex: number, score: number) => ({ runIndex, score });
  const pick = (items: Array<{ runIndex: number; score: number }>) =>
    selectNearestMedian(
      items,
      (i) => i.score,
      (i) => i.runIndex,
    );

  it("returns undefined for an empty list", () => {
    expect(pick([])).toBeUndefined();
  });

  it("returns the only item", () => {
    expect(pick([item(4, 61)])?.runIndex).toBe(4);
  });

  it("returns the exact median for an odd count", () => {
    // The median of an odd list is one of the scores, so the winner's score
    // equals it rather than merely being near it.
    expect(pick([item(1, 81), item(2, 92), item(3, 87)])?.score).toBe(87);
  });

  it("returns a real item for an even count, favouring the lower middle", () => {
    // Median of [80, 90] is 85, which nothing scored; both middles are 5 away,
    // so the tie-break picks the lower index.
    const chosen = pick([item(1, 80), item(2, 90)]);
    expect(chosen?.runIndex).toBe(1);
    expect(chosen?.score).toBe(80);
  });

  it("breaks ties toward the lowest run index regardless of input order", () => {
    expect(pick([item(3, 80), item(1, 80), item(2, 80)])?.runIndex).toBe(1);
  });

  it("is unaffected by how far the outliers sit", () => {
    // Median is robust: moving the extremes does not move the pick.
    expect(pick([item(1, 10), item(2, 87), item(3, 99)])?.score).toBe(87);
    expect(pick([item(1, 0), item(2, 87), item(3, 100)])?.score).toBe(87);
  });
});

describe("selectRepresentative", () => {
  it("returns undefined when no run scored", () => {
    const runs = [makeRun({ runIndex: 1, failed: true }), makeRun({ runIndex: 2, withheld: true })];
    expect(selectRepresentative(runs)).toBeUndefined();
  });

  it("returns the only scored run", () => {
    const runs = [makeRun({ runIndex: 1, failed: true }), makeRun({ runIndex: 2, goal: 70 })];
    expect(selectRepresentative(runs)?.runIndex).toBe(2);
  });

  it("picks the run holding the median composite", () => {
    const runs = [
      makeRun({ runIndex: 1, axis: 81 }),
      makeRun({ runIndex: 2, axis: 92 }),
      makeRun({ runIndex: 3, axis: 87 }),
    ];
    const chosen = selectRepresentative(runs);
    expect(chosen?.runIndex).toBe(3);
    // The headline therefore equals the median of the runs listed beneath it.
    expect(chosen?.score.axisScore).toBe(87);
  });

  it("ignores failed runs when computing the median", () => {
    // Were the zeroed failed run counted, the median would drop to 80 and the
    // pick would move off the run that is actually typical of the successes.
    const runs = [
      makeRun({ runIndex: 1, axis: 70 }),
      makeRun({ runIndex: 2, axis: 80 }),
      makeRun({ runIndex: 3, axis: 90 }),
      makeRun({ runIndex: 4, failed: true, axis: 0 }),
    ];
    expect(selectRepresentative(runs)?.runIndex).toBe(2);
  });

  it("ignores withheld runs when computing the median", () => {
    const runs = [
      makeRun({ runIndex: 1, axis: 70 }),
      makeRun({ runIndex: 2, axis: 80 }),
      makeRun({ runIndex: 3, axis: 90 }),
      makeRun({ runIndex: 4, withheld: true, axis: 0 }),
    ];
    expect(selectRepresentative(runs)?.runIndex).toBe(2);
  });

  it("follows the composite even when dimension profiles differ wildly", () => {
    // All three composites are 80. Selection no longer inspects the dimension
    // profile: the composite is what gets reported, and each run's dimensions
    // are published individually so a skewed profile stays visible.
    const runs = [
      makeRun({ runIndex: 1, goal: 100, env: 50, svc: 50, agent: 50, axis: 80 }),
      makeRun({ runIndex: 2, goal: 80, env: 80, svc: 80, agent: 80, axis: 80 }),
      makeRun({ runIndex: 3, goal: 60, env: 110, svc: 110, agent: 110, axis: 80 }),
    ];
    expect(selectRepresentative(runs)?.runIndex).toBe(1);
  });

  it("does not need scoring weights", () => {
    // The rule reads one number per run, so there is nothing to weight.
    const runs = [makeRun({ runIndex: 1, axis: 70 }), makeRun({ runIndex: 2, axis: 80 })];
    expect(selectRepresentative(runs)?.runIndex).toBe(1);
  });
});

describe("computeSpread", () => {
  it("summarizes only the successful runs", () => {
    const runs = [
      makeRun({ runIndex: 1, axis: 84 }),
      makeRun({ runIndex: 2, axis: 87 }),
      makeRun({ runIndex: 3, failed: true }),
    ];

    const spread = computeSpread(runs);

    expect(spread?.n).toBe(2);
    expect(spread?.axisScore.min).toBe(84);
    expect(spread?.axisScore.max).toBe(87);
  });

  it("names the representative run", () => {
    const runs = [
      makeRun({ runIndex: 1, axis: 60 }),
      makeRun({ runIndex: 2, axis: 80 }),
      makeRun({ runIndex: 3, axis: 100 }),
    ];
    expect(computeSpread(runs)?.representativeRunIndex).toBe(2);
  });

  it("agrees with the representative it names", () => {
    const runs = [
      makeRun({ runIndex: 1, axis: 91 }),
      makeRun({ runIndex: 2, axis: 73 }),
      makeRun({ runIndex: 3, axis: 82 }),
    ];
    const spread = computeSpread(runs)!;
    const representative = selectRepresentative(runs)!;

    expect(spread.representativeRunIndex).toBe(representative.runIndex);
    // For an odd sample the representative's score IS the median, so the two
    // numbers a reader sees side by side cannot disagree.
    expect(representative.score.axisScore).toBe(spread.axisScore.median);
  });

  it("returns undefined when no run scored", () => {
    expect(computeSpread([makeRun({ runIndex: 1, failed: true })])).toBeUndefined();
  });
});

describe("computeReliability", () => {
  it("counts every run when all are measurable", () => {
    const runs = [makeRun({ runIndex: 1 }), makeRun({ runIndex: 2, failed: true }), makeRun({ runIndex: 3 })];
    expect(computeReliability(runs)).toEqual({ succeeded: 2, total: 3, withheld: 0 });
  });

  it("removes withheld runs from the denominator rather than charging them to the agent", () => {
    const runs = [makeRun({ runIndex: 1 }), makeRun({ runIndex: 2 }), makeRun({ runIndex: 3, withheld: true })];
    // 2 of 2 measurable runs succeeded: the judge outage is reported, not blamed.
    expect(computeReliability(runs)).toEqual({ succeeded: 2, total: 2, withheld: 1 });
  });

  it("reports a fully withheld pair as unmeasured", () => {
    const runs = [makeRun({ runIndex: 1, withheld: true }), makeRun({ runIndex: 2, withheld: true })];
    expect(computeReliability(runs)).toEqual({ succeeded: 0, total: 0, withheld: 2 });
  });
});

describe("groupRunsByPair", () => {
  it("groups by scenario and agent, preserving first-seen pair order", () => {
    const runs = [
      makeRun({ runIndex: 1, scenarioKey: "b" }),
      makeRun({ runIndex: 1, scenarioKey: "a" }),
      makeRun({ runIndex: 2, scenarioKey: "b" }),
    ];

    const groups = [...groupRunsByPair(runs).keys()];
    expect(groups).toEqual([
      pairKey({ scenarioKey: "b", agentName: "a1" }),
      pairKey({ scenarioKey: "a", agentName: "a1" }),
    ]);
  });

  it("sorts each pair's runs by run index", () => {
    const runs = [makeRun({ runIndex: 3 }), makeRun({ runIndex: 1 }), makeRun({ runIndex: 2 })];
    const group = groupRunsByPair(runs).get(pairKey({ scenarioKey: "s1", agentName: "a1" }))!;
    expect(group.map((r) => r.runIndex)).toEqual([1, 2, 3]);
  });

  it("keeps different agents on the same scenario apart", () => {
    const runs = [makeRun({ runIndex: 1, agentName: "a1" }), makeRun({ runIndex: 1, agentName: "a2" })];
    expect(groupRunsByPair(runs).size).toBe(2);
  });
});

describe("aggregatePair", () => {
  it("returns runs in index order alongside the aggregate", () => {
    const runs = [
      makeRun({ runIndex: 2, goal: 80, env: 80, svc: 80, agent: 80 }),
      makeRun({ runIndex: 1, goal: 60, env: 60, svc: 60, agent: 60 }),
      makeRun({ runIndex: 3, goal: 100, env: 100, svc: 100, agent: 100 }),
    ];

    const aggregate = aggregatePair(runs);

    expect(aggregate.runs.map((r) => r.runIndex)).toEqual([1, 2, 3]);
    expect(aggregate.representative?.runIndex).toBe(2);
    expect(aggregate.spread?.n).toBe(3);
    expect(aggregate.reliability).toEqual({ succeeded: 3, total: 3, withheld: 0 });
  });

  it("leaves the representative undefined when every run failed", () => {
    const runs = [makeRun({ runIndex: 1, failed: true }), makeRun({ runIndex: 2, failed: true })];
    const aggregate = aggregatePair(runs);
    expect(aggregate.representative).toBeUndefined();
    expect(aggregate.spread).toBeUndefined();
    expect(aggregate.reliability.succeeded).toBe(0);
  });
});

describe("aggregateByPair", () => {
  it("aggregates each pair independently", () => {
    const runs = [
      makeRun({ runIndex: 1, scenarioKey: "s1", axis: 70 }),
      makeRun({ runIndex: 2, scenarioKey: "s1", axis: 90 }),
      makeRun({ runIndex: 1, scenarioKey: "s2", axis: 50 }),
    ];

    const aggregates = aggregateByPair(runs);

    expect(aggregates.size).toBe(2);
    expect(aggregates.get(pairKey({ scenarioKey: "s1", agentName: "a1" }))?.spread?.n).toBe(2);
    expect(aggregates.get(pairKey({ scenarioKey: "s2", agentName: "a1" }))?.spread?.n).toBe(1);
  });
});
