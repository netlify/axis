import { describe, it, expect } from "vitest";
import { compareBaseline } from "../../../src/baselines/compare.js";
import type { Baseline } from "../../../src/types/baseline.js";
import type { ReportManifest } from "../../../src/types/report.js";
import type { CategoryScore } from "../../../src/types/scoring.js";

function mockCategoryScore(score: number): CategoryScore {
  return {
    score,
    interactionCount: 5,
    auditedCount: 2,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment", score: score / 100, unnecessaryIds: [], rationale: "test" },
  };
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    name: "main",
    createdAt: "2026-04-15T20:00:00.000Z",
    updatedAt: "2026-04-15T20:00:00.000Z",
    results: {
      "hello-world": {
        "claude-code": {
          axisScore: 85,
          goalAchievement: 80,
          environment: 90,
          service: 95,
          agent: 100,
          durationMs: 5000,
          tokens: 1700,
          fromReportId: "2026-04-15-200000",
          timestamp: "2026-04-15T20:00:00.000Z",
        },
      },
    },
    ...overrides,
  };
}

function makeReport(overrides: Partial<ReportManifest> = {}): ReportManifest {
  return {
    version: "1",
    reportId: "2026-04-15-210000",
    timestamp: "2026-04-15T21:00:00.000Z",
    durationMs: 5000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 92 },
    results: [
      {
        scenarioKey: "hello-world",
        scenarioName: "Hello World",
        agentName: "claude-code",
        durationMs: 3000,
        exitCode: 0,
        score: {
          axisScore: 92,
          goalAchievement: { score: 90, criteria: [] },
          environment: mockCategoryScore(95),
          service: mockCategoryScore(98),
          agent: mockCategoryScore(100),
          weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
        },
        file: "scenarios/hello-world/claude-code.json",
      },
    ],
    ...overrides,
  };
}

describe("baselines/compare", () => {
  it("detects improvement", () => {
    const result = compareBaseline(makeBaseline(), makeReport());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].delta).toBe(7); // 92 - 85
    expect(result.summary.improved).toBe(1);
    expect(result.summary.regressed).toBe(0);
    expect(result.summary.unchanged).toBe(0);
  });

  it("detects regression", () => {
    const report = makeReport({
      results: [
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "claude-code",
          durationMs: 8000,
          exitCode: 0,
          score: {
            axisScore: 70,
            goalAchievement: { score: 60, criteria: [] },
            environment: mockCategoryScore(80),
            service: mockCategoryScore(75),
            agent: mockCategoryScore(90),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/hello-world/claude-code.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);

    expect(result.entries[0].delta).toBe(-15); // 70 - 85
    expect(result.summary.regressed).toBe(1);
    expect(result.summary.improved).toBe(0);
  });

  it("treats delta <=1 as unchanged (noise tolerance)", () => {
    const report = makeReport({
      results: [
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "claude-code",
          durationMs: 5000,
          exitCode: 0,
          score: {
            axisScore: 86, // +1 from baseline (85)
            goalAchievement: { score: 80, criteria: [] },
            environment: mockCategoryScore(92),
            service: mockCategoryScore(95),
            agent: mockCategoryScore(100),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/hello-world/claude-code.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);

    expect(result.entries[0].delta).toBe(1);
    expect(result.summary.unchanged).toBe(1);
    expect(result.summary.improved).toBe(0);
    expect(result.summary.regressed).toBe(0);
  });

  it("counts new scenarios (in report, not baseline)", () => {
    const report = makeReport({
      results: [
        {
          scenarioKey: "new-scenario",
          scenarioName: "New Scenario",
          agentName: "claude-code",
          durationMs: 5000,
          exitCode: 0,
          score: {
            axisScore: 75,
            goalAchievement: { score: 70, criteria: [] },
            environment: mockCategoryScore(80),
            service: mockCategoryScore(75),
            agent: mockCategoryScore(90),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/new-scenario/claude-code.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);

    expect(result.entries).toHaveLength(0);
    expect(result.summary.newScenarios).toBe(1);
  });

  it("ignores scenarios in baseline but not report (partial runs)", () => {
    const baseline = makeBaseline({
      results: {
        "hello-world": {
          "claude-code": {
            axisScore: 85,
            goalAchievement: 80,
            environment: 90,
            service: 95,
            agent: 100,
            durationMs: 5000,
            tokens: 1700,
            fromReportId: "2026-04-15-200000",
            timestamp: "2026-04-15T20:00:00.000Z",
          },
        },
        "cms/create-post": {
          "claude-code": {
            axisScore: 70,
            goalAchievement: 60,
            environment: 80,
            service: 75,
            agent: 90,
            durationMs: 8000,
            tokens: 3000,
            fromReportId: "2026-04-15-200000",
            timestamp: "2026-04-15T20:00:00.000Z",
          },
        },
      },
    });

    // Report only has hello-world
    const result = compareBaseline(baseline, makeReport());

    // Only hello-world is compared; cms/create-post is ignored
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].scenarioKey).toBe("hello-world");
  });

  it("computes per-category deltas", () => {
    const result = compareBaseline(makeBaseline(), makeReport());

    const cats = result.entries[0].categories;
    expect(cats.goalAchievement).toEqual({ baseline: 80, current: 90, delta: 10 });
    expect(cats.environment).toEqual({ baseline: 90, current: 95, delta: 5 });
    expect(cats.service).toEqual({ baseline: 95, current: 98, delta: 3 });
    expect(cats.agent).toEqual({ baseline: 100, current: 100, delta: 0 });
  });

  it("skips unscored report results", () => {
    const report = makeReport({
      results: [
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "claude-code",
          durationMs: 5000,
          exitCode: 0,
          // No score
          file: "scenarios/hello-world/claude-code.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);
    expect(result.entries).toHaveLength(0);
    expect(result.summary.newScenarios).toBe(0);
  });

  it("skips failed report results", () => {
    const report = makeReport({
      results: [
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "claude-code",
          durationMs: 5000,
          exitCode: 1,
          error: "Agent timed out",
          score: {
            axisScore: 0,
            goalAchievement: { score: 0, criteria: [] },
            environment: mockCategoryScore(0),
            service: mockCategoryScore(0),
            agent: mockCategoryScore(0),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/hello-world/claude-code.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);
    expect(result.entries).toHaveLength(0);
  });

  it("handles empty overlap (no matching scenarios)", () => {
    const baseline = makeBaseline({
      results: {
        "scenario-a": {
          "agent-1": {
            axisScore: 80,
            goalAchievement: 70,
            environment: 85,
            service: 90,
            agent: 95,
            durationMs: 5000,
            tokens: 1500,
            fromReportId: "r1",
            timestamp: "2026-04-15T20:00:00.000Z",
          },
        },
      },
    });

    const report = makeReport({
      results: [
        {
          scenarioKey: "scenario-b",
          scenarioName: "Scenario B",
          agentName: "agent-2",
          durationMs: 5000,
          exitCode: 0,
          score: {
            axisScore: 75,
            goalAchievement: { score: 70, criteria: [] },
            environment: mockCategoryScore(80),
            service: mockCategoryScore(75),
            agent: mockCategoryScore(90),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/scenario-b/agent-2.json",
        },
      ],
    });

    const result = compareBaseline(baseline, report);
    expect(result.entries).toHaveLength(0);
    expect(result.summary.improved).toBe(0);
    expect(result.summary.regressed).toBe(0);
    expect(result.summary.unchanged).toBe(0);
    expect(result.summary.newScenarios).toBe(1);
  });

  it("treats new agent for existing scenario as new", () => {
    // Baseline has claude-code for hello-world
    // Report has codex for hello-world
    const report = makeReport({
      results: [
        {
          scenarioKey: "hello-world",
          scenarioName: "Hello World",
          agentName: "codex",
          durationMs: 5000,
          exitCode: 0,
          score: {
            axisScore: 75,
            goalAchievement: { score: 70, criteria: [] },
            environment: mockCategoryScore(80),
            service: mockCategoryScore(75),
            agent: mockCategoryScore(90),
            weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
          },
          file: "scenarios/hello-world/codex.json",
        },
      ],
    });

    const result = compareBaseline(makeBaseline(), report);
    expect(result.entries).toHaveLength(0);
    expect(result.summary.newScenarios).toBe(1);
  });
});
