import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the judge layer so we can drive callJudge's return value directly.
vi.mock("../../../src/scoring/judge.js", () => ({
  callJudge: vi.fn(),
  resolveJudgeAgent: vi.fn().mockReturnValue({ agent: "claude-code" }),
  formatJudgeLabel: vi.fn().mockReturnValue("claude-code"),
}));

import { runDeepEval } from "../../../src/scoring/deep-eval.js";
import { callJudge } from "../../../src/scoring/judge.js";
import { ScoringError } from "../../../src/scoring/errors.js";
import type { NormalizedTranscript } from "../../../src/transcript/types.js";
import type { RunResult } from "../../../src/types/output.js";
import type { SparseIndex } from "../../../src/types/scoring.js";

const mockCallJudge = vi.mocked(callJudge);

function makeSparseIndex(): SparseIndex {
  return {
    lines: ["#1 [agent] did a thing"],
    interactions: [
      {
        id: 1,
        entryIndices: [0],
        categories: ["agent"],
        sparseLine: "#1 [agent] did a thing",
        toolName: null,
        hasError: false,
        durationMs: null,
        startMs: null,
        contextBytes: 100,
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
}

const normalized = {
  entries: [{ type: "assistant", text: "did a thing" }],
} as unknown as NormalizedTranscript;

const runResult = {
  scenarioKey: "s",
  scenarioName: "S",
  agentName: "claude-code",
  prompt: "do it",
  judge: [],
  agentConfig: { agent: "claude-code" },
} as unknown as RunResult;

describe("runDeepEval judge-parse guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws ScoringError when a category judge response is unparseable", async () => {
    mockCallJudge.mockResolvedValue("I could not produce JSON for this.");

    await expect(runDeepEval(runResult, makeSparseIndex(), normalized)).rejects.toBeInstanceOf(ScoringError);
  });

  it("does not throw when the judge returns valid JSON", async () => {
    mockCallJudge.mockResolvedValue(
      JSON.stringify({ audits: [{ id: 1, success: 1, weight: 1, contextRelevance: 1, rationale: "ok" }] }),
    );

    const result = await runDeepEval(runResult, makeSparseIndex(), normalized);
    expect(result.audits.length).toBeGreaterThan(0);
  });
});
