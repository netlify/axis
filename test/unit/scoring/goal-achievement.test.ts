import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/adapters/registry.js", () => ({
  getAdapter: vi.fn(),
}));

import { scoreGoalAchievement } from "../../../src/scoring/goal-achievement.js";
import { normalizeTranscript } from "../../../src/transcript/normalize.js";
import { getAdapter } from "../../../src/adapters/registry.js";
import type { RunResult } from "../../../src/types/output.js";

const mockGetAdapter = vi.mocked(getAdapter);

function createMockAdapter(resultText: string) {
  return {
    name: "mock-judge",
    run: vi.fn().mockResolvedValue({
      transcript: [],
      result: resultText,
      metadata: {
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 100,
        exitCode: 0,
      },
    }),
  };
}

function makeRunResult(judge: RunResult["judge"]): RunResult {
  return {
    scenarioKey: "test",
    scenarioName: "Test Scenario",
    agentName: "claude-code",
    prompt: "Visit the target URL and verify the page content",
    judge,
    agentConfig: { agent: "claude-code" },
    output: {
      transcript: [{ type: "assistant", timestamp: new Date().toISOString(), content: { text: "I did the task" } }],
      result: "Task completed",
      metadata: {
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        durationMs: 1000,
        exitCode: 0,
      },
    },
  };
}

function getNormalizedEntries(result: RunResult) {
  return normalizeTranscript(result.output.transcript).entries;
}

describe("scoreGoalAchievement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("array judge", () => {
    it("parses judge grades and computes weighted score", async () => {
      const adapter = createMockAdapter(
        JSON.stringify({
          grades: [
            { criterion_index: 0, score: 10, rationale: "Fully met" },
            { criterion_index: 1, score: 7, rationale: "Partially met" },
          ],
        }),
      );
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult([
        { check: "Task done", weight: 0.5 },
        { check: "Quality good", weight: 0.5 },
      ]);
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.criteria).toHaveLength(2);
      expect(result.criteria[0].score).toBe(10);
      expect(result.criteria[1].score).toBe(7);
      // (10/10 * 0.5 + 7/10 * 0.5) / 1.0 * 100 = 85
      expect(result.score).toBe(85);
    });

    it("handles markdown-wrapped JSON", async () => {
      const adapter = createMockAdapter(
        '```json\n{"grades": [{"criterion_index": 0, "score": 8, "rationale": "Good"}]}\n```',
      );
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult([{ check: "Did it", weight: 1.0 }]);
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.criteria[0].score).toBe(8);
      expect(result.score).toBe(80);
    });

    it("returns zero scores on invalid JSON", async () => {
      const adapter = createMockAdapter("I cannot evaluate this properly.");
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult([{ check: "Did it", weight: 1.0 }]);
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.criteria[0].score).toBe(0);
      expect(result.criteria[0].rationale).toContain("Failed to parse");
      expect(result.score).toBe(0);
    });

    it("returns score 0 for empty judge", async () => {
      const runResult = makeRunResult([]);
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));
      expect(result.score).toBe(0);
      expect(result.criteria).toEqual([]);
    });

    it("clamps scores to 0-10", async () => {
      const adapter = createMockAdapter(
        JSON.stringify({
          grades: [{ criterion_index: 0, score: 15, rationale: "Overshot" }],
        }),
      );
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult([{ check: "Did it", weight: 1.0 }]);
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.criteria[0].score).toBe(10);
    });
  });

  describe("string judge", () => {
    it("parses judge score and rationale", async () => {
      const adapter = createMockAdapter(JSON.stringify({ score: 8, rationale: "Agent completed most tasks" }));
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult("The agent should complete the task successfully");
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.criteria).toHaveLength(1);
      expect(result.criteria[0].score).toBe(8);
      expect(result.criteria[0].weight).toBe(1.0);
      expect(result.criteria[0].check).toBe("The agent should complete the task successfully");
      expect(result.score).toBe(80);
    });

    it("returns zero on invalid response for string judge", async () => {
      const adapter = createMockAdapter("Unable to evaluate.");
      mockGetAdapter.mockReturnValue(adapter);

      const runResult = makeRunResult("Evaluate the agent");
      const result = await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

      expect(result.score).toBe(0);
      expect(result.criteria[0].rationale).toContain("Failed to parse");
    });
  });

  it("calls adapter with judging prompt", async () => {
    const adapter = createMockAdapter(JSON.stringify({ grades: [{ criterion_index: 0, score: 5, rationale: "OK" }] }));
    mockGetAdapter.mockReturnValue(adapter);

    const runResult = makeRunResult([{ check: "Test criterion", weight: 1.0 }]);
    await scoreGoalAchievement(runResult, getNormalizedEntries(runResult));

    expect(adapter.run).toHaveBeenCalledTimes(1);
    const call = adapter.run.mock.calls[0][0];
    expect(call.prompt).toContain("AXIS");
    expect(call.prompt).toContain("Test criterion");
    expect(call.prompt).toContain("TRANSCRIPT");
    expect(call.prompt).toContain("SCENARIO:");
    expect(call.prompt).toContain("Test Scenario");
    expect(call.prompt).toContain("TASK GIVEN TO AGENT:");
    expect(call.prompt).toContain("Visit the target URL");
    expect(call.scenario.key).toBe("__judge__");
  });
});
