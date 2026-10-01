import { describe, it, expect } from "vitest";
import { buildRepeatedLabel, groupIntoPairs, pairScore, summarizePair } from "../../../src/ui/LiveStatus.js";
import { selectRepresentative } from "../../../src/scoring/aggregate.js";
import type { JobState, JobStatus } from "../../../src/types/output.js";
import type { ScoredRunResult, ScoringWeights } from "../../../src/types/scoring.js";

function job(overrides: Partial<JobState> & { status: JobStatus }): JobState {
  return {
    scenarioKey: "s1",
    agentName: "a1",
    ...overrides,
  };
}

function pair(runs: JobState[]) {
  return { scenarioKey: "s1", agentName: "a1", runs };
}

describe("groupIntoPairs", () => {
  it("collapses a pair's runs into one row", () => {
    const pairs = groupIntoPairs([
      job({ status: "done", runIndex: 1, runCount: 2 }),
      job({ status: "running", runIndex: 2, runCount: 2 }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].runs.map((r) => r.runIndex)).toEqual([1, 2]);
  });

  it("sorts runs by index regardless of arrival order", () => {
    const pairs = groupIntoPairs([
      job({ status: "done", runIndex: 3, runCount: 3 }),
      job({ status: "done", runIndex: 1, runCount: 3 }),
      job({ status: "done", runIndex: 2, runCount: 3 }),
    ]);

    expect(pairs[0].runs.map((r) => r.runIndex)).toEqual([1, 2, 3]);
  });

  it("keeps variants of the same scenario as separate pairs", () => {
    const pairs = groupIntoPairs([
      job({ status: "done", scenarioKey: "s1@fast" }),
      job({ status: "done", scenarioKey: "s1@slow" }),
    ]);

    expect(pairs).toHaveLength(2);
  });

  it("keeps different agents as separate pairs", () => {
    const pairs = groupIntoPairs([job({ status: "done", agentName: "a1" }), job({ status: "done", agentName: "a2" })]);
    expect(pairs).toHaveLength(2);
  });

  it("preserves first-seen pair order", () => {
    const pairs = groupIntoPairs([
      job({ status: "done", scenarioKey: "z" }),
      job({ status: "done", scenarioKey: "a" }),
    ]);

    expect(pairs.map((p) => p.scenarioKey)).toEqual(["z", "a"]);
  });
});

describe("pairScore", () => {
  it("is the median of the scored runs", () => {
    const score = pairScore(
      pair([
        job({ status: "done", runIndex: 1, axisScore: 79 }),
        job({ status: "done", runIndex: 2, axisScore: 86 }),
        job({ status: "done", runIndex: 3, axisScore: 91 }),
      ]),
    );
    expect(score).toBe(86);
  });

  it("ignores runs that have no score yet", () => {
    const score = pairScore(
      pair([job({ status: "done", runIndex: 1, axisScore: 80 }), job({ status: "running", runIndex: 2 })]),
    );
    expect(score).toBe(80);
  });

  it("is null before anything scores", () => {
    expect(pairScore(pair([job({ status: "running", runIndex: 1 })]))).toBeNull();
  });
});

describe("buildRepeatedLabel", () => {
  it("shows progress and a running median mid-flight", () => {
    const runs = [
      job({ status: "done", runIndex: 1, axisScore: 87 }),
      job({ status: "done", runIndex: 2, axisScore: 84 }),
      job({ status: "running", runIndex: 3 }),
    ];
    expect(buildRepeatedLabel(runs, false, 86)).toBe("2/3 · med 86");
  });

  it("shows a dash until something scores", () => {
    const runs = [job({ status: "running", runIndex: 1 }), job({ status: "pending", runIndex: 2 })];
    expect(buildRepeatedLabel(runs, false, null)).toBe("0/2 · —");
  });

  it("switches to the final score once every run lands", () => {
    const runs = [job({ status: "done", runIndex: 1 }), job({ status: "done", runIndex: 2 })];
    expect(buildRepeatedLabel(runs, true, 86)).toBe("86 / 100");
  });

  it("says failed when a finished pair never scored", () => {
    const runs = [job({ status: "failed", runIndex: 1 }), job({ status: "failed", runIndex: 2 })];
    expect(buildRepeatedLabel(runs, true, null)).toBe("failed");
  });
});

describe("summarizePair", () => {
  it("takes its status from whichever run is still moving", () => {
    const summary = summarizePair(
      pair([
        job({ status: "done", runIndex: 1, runCount: 3, axisScore: 80 }),
        job({ status: "scoring", runIndex: 2, runCount: 3 }),
        job({ status: "pending", runIndex: 3, runCount: 3 }),
      ]),
    );

    expect(summary.status).toBe("scoring");
    expect(summary.active).toBe(true);
    expect(summary.finalMs).toBeUndefined();
  });

  it("passes a finished pair when any run succeeded", () => {
    const summary = summarizePair(
      pair([
        job({ status: "failed", runIndex: 1, runCount: 2, durationMs: 100 }),
        job({ status: "done", runIndex: 2, runCount: 2, durationMs: 200, axisScore: 84 }),
      ]),
    );

    expect(summary.status).toBe("done");
    expect(summary.active).toBe(false);
  });

  it("fails a finished pair only when no run succeeded", () => {
    const summary = summarizePair(
      pair([
        job({ status: "failed", runIndex: 1, runCount: 2, durationMs: 100 }),
        job({ status: "failed", runIndex: 2, runCount: 2, durationMs: 100 }),
      ]),
    );

    expect(summary.status).toBe("failed");
    expect(summary.label).toBe("failed");
  });

  it("totals the duration of a finished pair rather than showing one run's", () => {
    const summary = summarizePair(
      pair([
        job({ status: "done", runIndex: 1, runCount: 2, durationMs: 1000 }),
        job({ status: "done", runIndex: 2, runCount: 2, durationMs: 2500 }),
      ]),
    );

    expect(summary.finalMs).toBe(3500);
  });

  it("back-dates the live timer by the time already spent", () => {
    const startedAt = 1_000_000;
    const summary = summarizePair(
      pair([
        job({ status: "done", runIndex: 1, runCount: 2, durationMs: 4000 }),
        job({ status: "running", runIndex: 2, runCount: 2, runStartedAt: startedAt }),
      ]),
    );

    // Ticking from this point reads as "4s already spent, plus the current run".
    expect(summary.startedAt).toBe(startedAt - 4000);
    expect(summary.finalMs).toBeUndefined();
  });

  it("sums live tokens across runs", () => {
    const summary = summarizePair(
      pair([
        job({ status: "done", runIndex: 1, runCount: 2, liveTokens: 1200, tokensFinal: true }),
        job({ status: "running", runIndex: 2, runCount: 2, liveTokens: 300 }),
      ]),
    );

    expect(summary.liveTokens).toBe(1500);
    // Still an estimate while a run is in flight.
    expect(summary.tokensFinal).toBe(false);
  });

  it("marks tokens final once every run is final or failed", () => {
    const summary = summarizePair(
      pair([
        job({ status: "done", runIndex: 1, runCount: 2, liveTokens: 1200, tokensFinal: true }),
        job({ status: "failed", runIndex: 2, runCount: 2, liveTokens: 100 }),
      ]),
    );

    expect(summary.tokensFinal).toBe(true);
  });

  it("leaves a single-run pair's label exactly as before", () => {
    const summary = summarizePair(pair([job({ status: "done", durationMs: 1234, axisScore: 87 })]));

    expect(summary.label).toBe("87 / 100");
    expect(summary.finalMs).toBe(1234);
  });

  it("uses the status label for a single run that has not finished", () => {
    const summary = summarizePair(pair([job({ status: "running" })]));
    expect(summary.label).toBe("running");
  });
});

describe("agreement with the report", () => {
  const WEIGHTS: ScoringWeights = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

  /** The same run expressed as the report sees it. */
  function asScoredRun(runIndex: number, axisScore: number): ScoredRunResult {
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
      scenarioKey: "s1",
      scenarioName: "s1",
      agentName: "a1",
      runIndex,
      runCount: 9,
      prompt: "p",
      judge: "j",
      agentConfig: { agent: "m" },
      output: {
        transcript: [{ type: "assistant", timestamp: now, content: { text: "x" } }],
        result: "ok",
        metadata: { startTime: now, endTime: now, durationMs: 1, exitCode: 0 },
      },
      // Dimension profiles are deliberately unrelated to the composite here:
      // the selection rule must not consult them, so nothing about the result
      // may depend on what they contain.
      score: {
        axisScore,
        goalAchievement: { score: (axisScore * 7) % 101, criteria: [] },
        environment: category((axisScore * 13) % 101),
        service: category((axisScore * 29) % 101),
        agent: category((axisScore * 41) % 101),
        weights: WEIGHTS,
      },
    } as ScoredRunResult;
  }

  /** The same run as the live display sees it: a composite and nothing else. */
  function asJob(runIndex: number, axisScore: number): JobState {
    return { scenarioKey: "s1", agentName: "a1", runIndex, runCount: 9, status: "done", axisScore };
  }

  it("shows the same score the report headlines", () => {
    const composites = [81, 92, 87];
    const live = pairScore(pair(composites.map((c, i) => asJob(i + 1, c))));
    const reported = selectRepresentative(composites.map((c, i) => asScoredRun(i + 1, c)))?.score.axisScore;

    expect(live).toBe(87);
    expect(live).toBe(reported);
  });

  it("agrees across many random samples, odd and even", () => {
    // The terminal and the report used to be two different statistics that
    // merely tended to agree. They now share one rule, so this holds exactly.
    let checked = 0;
    for (let trial = 0; trial < 400; trial++) {
      const n = [1, 2, 3, 5, 7][trial % 5];
      const composites = Array.from({ length: n }, () => Math.floor(Math.random() * 101));

      const live = pairScore(pair(composites.map((c, i) => asJob(i + 1, c))));
      const reported = selectRepresentative(composites.map((c, i) => asScoredRun(i + 1, c)))?.score.axisScore;

      expect(live).toBe(reported);
      checked++;
    }
    expect(checked).toBe(400);
  });

  it("agrees when some runs have not scored yet", () => {
    // Mid-run the live view sees fewer scores than the finished pair will, but
    // it applies the rule to what it has rather than to a different statistic.
    const runs = [asJob(1, 70), asJob(2, 90), { ...asJob(3, 0), status: "running" as JobStatus, axisScore: undefined }];
    const live = pairScore(pair(runs));
    const reported = selectRepresentative([asScoredRun(1, 70), asScoredRun(2, 90)])?.score.axisScore;

    expect(live).toBe(reported);
  });
});
