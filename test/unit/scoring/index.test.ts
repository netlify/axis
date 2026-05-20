import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CategoryScore, DeepEvalResult, SparseIndex } from "../../../src/types/scoring.js";

// --- Hoisted mock data (available inside vi.mock factories) ---

const { mockSparseIndex, mockDeepEvalResult, makeCategoryScore } = vi.hoisted(() => {
  const mockSparseIndex: SparseIndex = {
    lines: ["#1    agent    assistant   Done"],
    interactions: [
      {
        id: 1,
        entryIndices: [0],
        categories: ["agent"],
        sparseLine: "#1    agent    assistant   Done",
        toolName: null,
        hasError: false,
        durationMs: null,
        startMs: null,
        contextBytes: 4,
      },
    ],
    stats: {
      totalInteractions: 1,
      byCategory: { environment: 0, service: 0, agent: 1 },
      totalErrors: 0,
      totalDurationMs: 0,
      wallClockMs: 0,
    },
  };

  const mockDeepEvalResult: DeepEvalResult = {
    audits: [
      {
        id: 1,
        categories: ["agent"],
        success: 1.0,
        speed: 0.8,
        weight: 0.8,
        contextRelevance: 0.8,
        rationale: "default",
      },
    ],
    necessity: [
      { category: "environment", score: 0.8, unnecessaryIds: [], rationale: "default" },
      { category: "service", score: 0.8, unnecessaryIds: [], rationale: "default" },
      { category: "agent", score: 0.8, unnecessaryIds: [], rationale: "default" },
    ],
    patterns: [],
  };

  function makeCategoryScore(overrides: Partial<CategoryScore> = {}): CategoryScore {
    return {
      score: 75,
      interactionCount: 1,
      auditedCount: 0,
      dimensions: { success: 100, speed: 80, weight: 80, relevance: 80, necessity: 80 },
      audits: [],
      necessity: { category: "agent", score: 0.8, unnecessaryIds: [], rationale: "default" },
      ...overrides,
    };
  }

  return { mockSparseIndex, mockDeepEvalResult, makeCategoryScore };
});

// --- Mocks ---

vi.mock("../../../src/scoring/goal-achievement.js", () => ({
  scoreGoalAchievement: vi.fn().mockResolvedValue({
    score: 80,
    criteria: [{ check: "Test criterion", weight: 1.0, score: 8, rationale: "Good" }],
  }),
}));

vi.mock("../../../src/scoring/sparse-index.js", () => ({
  buildSparseIndex: vi.fn().mockReturnValue(mockSparseIndex),
  populateInteractionContent: vi.fn(),
}));

vi.mock("../../../src/scoring/deep-eval.js", () => ({
  runDeepEval: vi.fn().mockResolvedValue(mockDeepEvalResult),
}));

vi.mock("../../../src/scoring/category-score.js", () => ({
  computeCategoryScore: vi.fn().mockReturnValue(makeCategoryScore()),
  DEFAULT_AUDIT_SCORES: { success: 1.0, speed: 0.8, weight: 0.8, contextRelevance: 0.8 },
}));

import { scoreResults } from "../../../src/scoring/index.js";
import { buildSparseIndex } from "../../../src/scoring/sparse-index.js";
import { runDeepEval } from "../../../src/scoring/deep-eval.js";
import { computeCategoryScore } from "../../../src/scoring/category-score.js";
import { scoreGoalAchievement } from "../../../src/scoring/goal-achievement.js";
import type { RunOutput } from "../../../src/types/output.js";

function makeRunOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    durationMs: 5000,
    results: [
      {
        scenarioKey: "test-scenario",
        scenarioName: "Test Scenario",
        agentName: "claude-code",
        prompt: "Visit the target and verify content",
        judge: [{ check: "Did it", weight: 1.0 }],
        agentConfig: { agent: "claude-code" },
        output: {
          transcript: [
            { type: "assistant", timestamp: new Date().toISOString(), content: { text: "Done" } },
            { type: "tool_use", timestamp: new Date().toISOString(), content: { name: "write" } },
          ],
          result: "Completed",
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 2000,
            exitCode: 0,
            tokenUsage: { input: 500, output: 200 },
          },
        },
      },
    ],
    summary: { total: 1, completed: 1, failed: 0 },
    ...overrides,
  };
}

describe("scoreResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to default return values
    vi.mocked(buildSparseIndex).mockReturnValue(mockSparseIndex);
    vi.mocked(runDeepEval).mockResolvedValue(mockDeepEvalResult);
    vi.mocked(computeCategoryScore).mockReturnValue(makeCategoryScore());
  });

  it("returns ScoredOutput with correct structure", async () => {
    const output = makeRunOutput();
    const scored = await scoreResults(output);

    expect(scored.version).toBe("0.1.0");
    expect(scored.results).toHaveLength(1);
    expect(scored.results[0].score).toBeDefined();
    expect(scored.results[0].score.axisScore).toBeGreaterThanOrEqual(0);
    expect(scored.results[0].score.goalAchievement.score).toBe(80);
    expect(scored.results[0].score.environment).toBeDefined();
    expect(scored.results[0].score.service).toBeDefined();
    expect(scored.results[0].score.agent).toBeDefined();
  });

  it("stamps the resolved judging agent onto score (self-judge default)", async () => {
    const scored = await scoreResults(makeRunOutput());
    expect(scored.results[0].score.judging).toEqual({ agent: "claude-code" });
  });

  it("stamps the picked judging agent when a list is configured", async () => {
    const scored = await scoreResults(makeRunOutput(), {
      judging: [{ agent: "claude-code", model: "opus" }, { agent: "codex" }],
    });
    // Run agent is claude-code; first non-matching entry is codex.
    expect(scored.results[0].score.judging).toEqual({ agent: "codex" });
  });

  it("calls the scoring pipeline in order", async () => {
    await scoreResults(makeRunOutput());

    // buildSparseIndex is called with normalized transcript
    expect(buildSparseIndex).toHaveBeenCalledTimes(1);

    // runDeepEval is called with the run result, sparse index, and normalized transcript
    expect(runDeepEval).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runDeepEval).mock.calls[0][1]).toBe(mockSparseIndex);

    // computeCategoryScore is called once per category (environment, service, agent)
    expect(computeCategoryScore).toHaveBeenCalledTimes(3);
    expect(vi.mocked(computeCategoryScore).mock.calls[0][0]).toBe("environment");
    expect(vi.mocked(computeCategoryScore).mock.calls[1][0]).toBe("service");
    expect(vi.mocked(computeCategoryScore).mock.calls[2][0]).toBe("agent");
  });

  it("computes average AXIS result across completed results", async () => {
    const scored = await scoreResults(makeRunOutput());
    expect(scored.summary.averageAxisScore).toBeGreaterThan(0);
  });

  it("excludes failed results from average", async () => {
    const output = makeRunOutput();
    output.results[0].output.metadata.exitCode = 1;
    output.summary.completed = 0;
    output.summary.failed = 1;

    const scored = await scoreResults(output);
    expect(scored.summary.averageAxisScore).toBe(0);
  });

  it("uses default weights when none specified", async () => {
    const scored = await scoreResults(makeRunOutput());
    expect(scored.results[0].score.weights).toEqual({
      goal_achievement: 0.4,
      environment: 0.2,
      service: 0.2,
      agent: 0.2,
    });
  });

  it("uses custom weights from options", async () => {
    const weights = { goal_achievement: 0.7, environment: 0.1, service: 0.1, agent: 0.1 };
    const scored = await scoreResults(makeRunOutput(), { weights });
    expect(scored.results[0].score.weights).toEqual(weights);
  });

  it("preserves run output metadata", async () => {
    const output = makeRunOutput();
    const scored = await scoreResults(output);

    expect(scored.timestamp).toBe(output.timestamp);
    expect(scored.durationMs).toBe(output.durationMs);
    expect(scored.summary.total).toBe(1);
    expect(scored.summary.completed).toBe(1);
  });

  it("includes sparseIndex in score result", async () => {
    const scored = await scoreResults(makeRunOutput());
    expect(scored.results[0].score.sparseIndex).toBe(mockSparseIndex);
  });

  describe("failed-run short-circuit", () => {
    it("returns zero scores for non-zero exit code without invoking judges", async () => {
      const output = makeRunOutput();
      output.results[0].output.metadata.exitCode = 1;
      output.results[0].output.metadata.error = "Authentication required";

      const scored = await scoreResults(output);
      const score = scored.results[0].score;

      expect(score.axisScore).toBe(0);
      expect(score.goalAchievement.score).toBe(0);
      expect(score.environment.score).toBe(0);
      expect(score.service.score).toBe(0);
      expect(score.agent.score).toBe(0);

      // No LLM judges were called
      expect(scoreGoalAchievement).not.toHaveBeenCalled();
      expect(runDeepEval).not.toHaveBeenCalled();
      expect(computeCategoryScore).not.toHaveBeenCalled();
    });

    it("treats metadata.error as failure even when exit code is 0", async () => {
      const output = makeRunOutput();
      output.results[0].output.metadata.exitCode = 0;
      output.results[0].output.metadata.error = "Stream closed unexpectedly";

      const scored = await scoreResults(output);

      expect(scored.results[0].score.axisScore).toBe(0);
      expect(runDeepEval).not.toHaveBeenCalled();
    });

    it("populates judge criteria with the failure reason on zero score", async () => {
      const output = makeRunOutput();
      output.results[0].judge = [{ check: "Did the thing", weight: 1.0 }];
      output.results[0].output.metadata.exitCode = 1;
      output.results[0].output.metadata.error = "Authentication required";

      const scored = await scoreResults(output);
      const criteria = scored.results[0].score.goalAchievement.criteria;

      expect(criteria).toHaveLength(1);
      expect(criteria[0].score).toBe(0);
      expect(criteria[0].rationale).toContain("Authentication required");
    });

    it("handles a string judge on failed runs", async () => {
      const output = makeRunOutput();
      output.results[0].judge = "Agent should echo prompt";
      output.results[0].output.metadata.exitCode = 1;

      const scored = await scoreResults(output);
      const criteria = scored.results[0].score.goalAchievement.criteria;

      expect(criteria).toHaveLength(1);
      expect(criteria[0].check).toBe("Agent should echo prompt");
      expect(criteria[0].score).toBe(0);
    });
  });
});
