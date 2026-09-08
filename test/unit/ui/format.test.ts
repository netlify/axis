import { describe, it, expect } from "vitest";
import {
  buildScoreInsight,
  friendlyError,
  renderSummaryTable,
  renderResultDetail,
  renderScenarioDetail,
  renderBaselineList,
  renderBaselineComparison,
} from "../../../src/ui/format.js";
import type { CategoryScore, InteractionAudit, ScoreResult } from "../../../src/types/scoring.js";
import type { RunOutput, RunResult } from "../../../src/types/output.js";
import type { AgentOutput } from "../../../src/types/agent.js";
import type { Baseline, BaselineComparison } from "../../../src/types/baseline.js";

// --- friendlyError ---

describe("friendlyError", () => {
  it("detects quota exceeded", () => {
    expect(friendlyError("Your free tier request quota has been exhausted")).toBe(
      "API quota exceeded — wait or upgrade your plan",
    );
  });

  it("detects rate limiting", () => {
    expect(friendlyError("429 Too Many Requests")).toBe("Rate limited — wait and retry");
  });

  it("detects auth failure", () => {
    expect(friendlyError("401 Unauthorized: invalid api key")).toBe("Authentication failed — check your API key");
  });

  it("detects permission denied", () => {
    expect(friendlyError("403 Forbidden")).toBe("Permission denied — check API key permissions");
  });

  it("detects timeout", () => {
    expect(friendlyError("Agent timed out after 600s")).toBe("Agent timed out");
  });

  it("detects network errors", () => {
    expect(friendlyError("connect ECONNREFUSED 127.0.0.1:443")).toBe("Network error — check your connection");
  });

  it("detects CLI not found", () => {
    expect(friendlyError("gemini not found on PATH")).toBe("CLI tool not found — check installation");
  });

  it("returns first line truncated for unknown errors", () => {
    const longError = "Something went wrong: " + "x".repeat(100);
    const result = friendlyError(longError);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns short unknown errors as-is", () => {
    expect(friendlyError("Unknown failure")).toBe("Unknown failure");
  });

  it("returns first line of multiline unknown errors", () => {
    expect(friendlyError("First line\nSecond line\nThird")).toBe("First line");
  });
});

// --- Error display in renderers ---

function makeResult(overrides: Partial<{ error: string; exitCode: number }>): RunResult {
  const output: AgentOutput = {
    // A normal run produces work; keep the fixture non-empty so a clean exit
    // reads as a pass. (An empty transcript AND null result is the failure
    // signature that isFailedRun now catches.)
    transcript: [{ type: "assistant", timestamp: "2026-01-01T00:00:00Z", content: { text: "done" } }],
    result: "Task completed",
    metadata: {
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T00:01:00Z",
      durationMs: 60000,
      exitCode: overrides.exitCode ?? 1,
      error: overrides.error,
    },
  };
  return {
    scenarioKey: "test/scenario",
    scenarioName: "Test Scenario",
    agentName: "test-agent",
    prompt: "do something",
    judge: "verify it works",
    agentConfig: { agent: "test-adapter" },
    output,
  };
}

// --- buildScoreInsight ---

function makeCategory(score: number, dims?: Partial<Record<string, number>>): CategoryScore {
  const defaultDims = { success: 80, speed: 80, weight: 80, relevance: 80, necessity: 80 };
  return {
    score,
    interactionCount: 1,
    auditedCount: 0,
    dimensions: { ...defaultDims, ...dims },
    audits: [],
    necessity: { category: "environment", score: 0.8, unnecessaryIds: [], rationale: "" },
  };
}

function makeScoreResult(overrides?: { env?: CategoryScore; svc?: CategoryScore; agent?: CategoryScore }): ScoreResult {
  return {
    axisScore: 80,
    goalAchievement: { score: 80, criteria: [] },
    environment: overrides?.env ?? makeCategory(80),
    service: overrides?.svc ?? makeCategory(80),
    agent: overrides?.agent ?? makeCategory(80),
    weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
  };
}

describe("buildScoreInsight", () => {
  it("returns null when all categories >= 75", () => {
    expect(buildScoreInsight(makeScoreResult())).toBeNull();
  });

  it("returns insight for category below 75", () => {
    const insight = buildScoreInsight(
      makeScoreResult({ env: makeCategory(51, { success: 60, speed: 90, weight: 65, relevance: 75, necessity: 100 }) }),
    );
    expect(insight).toContain("Env: success 60");
  });

  it("identifies the weakest dimension", () => {
    const insight = buildScoreInsight(
      makeScoreResult({ svc: makeCategory(59, { success: 70, speed: 20, weight: 80, relevance: 90, necessity: 90 }) }),
    );
    expect(insight).toContain("Svc: speed 20");
  });

  it("shows multiple categories separated by pipe", () => {
    const insight = buildScoreInsight(
      makeScoreResult({
        env: makeCategory(50, { success: 40 }),
        svc: makeCategory(60, { speed: 30 }),
      }),
    );
    expect(insight).toContain("Env: success 40");
    expect(insight).toContain("Svc: speed 30");
    expect(insight).toContain("|");
  });

  it("skips categories at exactly 75", () => {
    const insight = buildScoreInsight(makeScoreResult({ env: makeCategory(75), svc: makeCategory(74, { speed: 50 }) }));
    expect(insight).not.toContain("Env");
    expect(insight).toContain("Svc: speed 50");
  });
});

describe("renderSummaryTable", () => {
  it("shows friendly error below failed rows", () => {
    const output: RunOutput = {
      version: "1.0",
      timestamp: "2026-01-01T00:00:00Z",
      durationMs: 60000,
      results: [makeResult({ error: "Your free tier request quota has been exhausted", exitCode: 1 })],
      summary: { total: 1, completed: 0, failed: 1 },
    };
    const table = renderSummaryTable(output);
    expect(table).toContain("✗ fail");
    expect(table).toContain("↳ API quota exceeded");
  });

  it("does not show error line for passing results", () => {
    const output: RunOutput = {
      version: "1.0",
      timestamp: "2026-01-01T00:00:00Z",
      durationMs: 60000,
      results: [makeResult({ exitCode: 0 })],
      summary: { total: 1, completed: 1, failed: 0 },
    };
    const table = renderSummaryTable(output);
    expect(table).toContain("✓ pass");
    expect(table).not.toContain("↳");
  });
});

describe("renderResultDetail", () => {
  it("shows friendly error for failed result", () => {
    const result = makeResult({ error: "429 Too Many Requests", exitCode: 1 });
    const detail = renderResultDetail(result);
    expect(detail).toContain("Error:      Rate limited");
  });

  it("omits error line for successful result", () => {
    const result = makeResult({ exitCode: 0 });
    const detail = renderResultDetail(result);
    expect(detail).not.toContain("Error:");
  });
});

describe("renderScenarioDetail", () => {
  it("shows friendly error for failed unscored result", () => {
    const result = makeResult({ error: "connect ECONNREFUSED 127.0.0.1:443", exitCode: 1 });
    const detail = renderScenarioDetail(result);
    expect(detail).toContain("Error:    Network error");
  });
});

// --- Baseline rendering ---

describe("renderBaselineList", () => {
  it("renders baseline names, dates, and counts", () => {
    const baselines: Baseline[] = [
      {
        name: "main",
        createdAt: "2026-04-15T20:00:00.000Z",
        updatedAt: "2026-04-15T21:00:00.000Z",
        results: {
          "hello-world": {
            "claude-code": {
              axisScore: 85,
              goalAchievement: 80,
              environment: 90,
              service: 85,
              agent: 100,
              durationMs: 5000,
              tokens: 1700,
              fromReportId: "r1",
              timestamp: "2026-04-15T20:00:00.000Z",
            },
            codex: {
              axisScore: 72,
              goalAchievement: 65,
              environment: 78,
              service: 70,
              agent: 90,
              durationMs: 8000,
              tokens: 3000,
              fromReportId: "r1",
              timestamp: "2026-04-15T20:00:00.000Z",
            },
          },
        },
      },
    ];

    const output = renderBaselineList(baselines);
    expect(output).toContain("AXIS Baselines");
    expect(output).toContain("main");
    expect(output).toContain("2026-04-15 21:00:00");
    // 1 scenario, 2 agents
    expect(output).toContain("1");
    expect(output).toContain("2");
  });
});

describe("renderBaselineComparison", () => {
  it("renders improvement with ▲", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [
        {
          scenarioKey: "hello-world",
          agentName: "claude-code",
          baseline: 85,
          current: 92,
          delta: 7,
          categories: {
            goalAchievement: { baseline: 80, current: 90, delta: 10 },
            environment: { baseline: 90, current: 95, delta: 5 },
            service: { baseline: 85, current: 90, delta: 5 },
            agent: { baseline: 100, current: 100, delta: 0 },
          },
        },
      ],
      summary: { improved: 1, regressed: 0, unchanged: 0, newScenarios: 0 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).toContain("Baseline: main");
    expect(output).toContain("+7 ▲");
    expect(output).toContain("1 improved, 0 regressed, 0 unchanged");
  });

  it("renders regression with ▼", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [
        {
          scenarioKey: "hello-world",
          agentName: "claude-code",
          baseline: 85,
          current: 70,
          delta: -15,
          categories: {
            goalAchievement: { baseline: 80, current: 60, delta: -20 },
            environment: { baseline: 90, current: 80, delta: -10 },
            service: { baseline: 85, current: 75, delta: -10 },
            agent: { baseline: 100, current: 90, delta: -10 },
          },
        },
      ],
      summary: { improved: 0, regressed: 1, unchanged: 0, newScenarios: 0 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).toContain("-15 ▼");
    expect(output).toContain("0 improved, 1 regressed, 0 unchanged");
  });

  it("renders unchanged with bare number (no indicator)", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [
        {
          scenarioKey: "hello-world",
          agentName: "claude-code",
          baseline: 85,
          current: 85,
          delta: 0,
          categories: {
            goalAchievement: { baseline: 80, current: 80, delta: 0 },
            environment: { baseline: 90, current: 90, delta: 0 },
            service: { baseline: 85, current: 85, delta: 0 },
            agent: { baseline: 100, current: 100, delta: 0 },
          },
        },
      ],
      summary: { improved: 0, regressed: 0, unchanged: 1, newScenarios: 0 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).toContain("0 improved, 0 regressed, 1 unchanged");
    // Zero delta should not have a "+" prefix or any direction indicator
    expect(output).not.toContain("+0");
    expect(output).not.toContain("▲");
    expect(output).not.toContain("▼");
  });

  it("shows direction for noise-range deltas (±1) without arrow indicator", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [
        {
          scenarioKey: "hello-world",
          agentName: "claude-code",
          baseline: 85,
          current: 86,
          delta: 1,
          categories: {
            goalAchievement: { baseline: 80, current: 81, delta: 1 },
            environment: { baseline: 90, current: 90, delta: 0 },
            service: { baseline: 85, current: 85, delta: 0 },
            agent: { baseline: 100, current: 100, delta: 0 },
          },
        },
      ],
      summary: { improved: 0, regressed: 0, unchanged: 1, newScenarios: 0 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).toContain("+1");
    // No arrow — it's within noise tolerance
    expect(output).not.toContain("+1 ▲");
  });

  it("shows new scenario count when present", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [],
      summary: { improved: 0, regressed: 0, unchanged: 0, newScenarios: 2 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).toContain("New (not in baseline): 2");
  });

  it("hides new scenario line when zero", () => {
    const diff: BaselineComparison = {
      baselineName: "main",
      reportId: "r2",
      entries: [],
      summary: { improved: 0, regressed: 0, unchanged: 0, newScenarios: 0 },
    };

    const output = renderBaselineComparison(diff);
    expect(output).not.toContain("New (not in baseline)");
  });
});

// --- Score breakdown table (verbose scored output) ---

function makeAudit(overrides: Partial<InteractionAudit> & { id: number }): InteractionAudit {
  return {
    categories: ["agent"],
    success: 1,
    speed: 1,
    weight: 1,
    contextRelevance: 1,
    rationale: "Looked fine.",
    ...overrides,
  };
}

/** A scored result whose Agent category carries the given audits and necessity judgment. */
function makeScoredResult(agentCat: Partial<CategoryScore>): RunResult {
  const agent: CategoryScore = {
    ...makeCategory(60),
    auditedCount: 3,
    necessity: { category: "agent", score: 1, unnecessaryIds: [], rationale: "default" },
    ...agentCat,
  };
  return {
    ...makeResult({ exitCode: 0 }),
    score: makeScoreResult({ agent }),
  } as RunResult;
}

describe("renderScenarioDetail score breakdown", () => {
  it("renders a table row per imperfect audit with its sub-perfect dimensions", () => {
    const out = renderScenarioDetail(
      makeScoredResult({
        audits: [
          makeAudit({ id: 3, success: 0.5, speed: 0.8, rationale: "Install failed once." }),
          makeAudit({ id: 7, speed: 0.6, rationale: "Slow directory scan." }),
        ],
      }),
    );

    expect(out).toContain("Score breakdown");
    expect(out).toContain("Interaction");
    expect(out).toMatch(/#3\s+Success: 50\s+Speed: 80\s+Install failed once\./);
    expect(out).toMatch(/#7\s+Speed: 60\s+Slow directory scan\./);
  });

  it("omits dimensions that are already perfect", () => {
    const out = renderScenarioDetail(makeScoredResult({ audits: [makeAudit({ id: 1, speed: 0.4 })] }));
    expect(out).toMatch(/#1\s+Speed: 40/);
    expect(out).not.toContain("Success: 100");
  });

  it("counts passing audits instead of listing them", () => {
    const out = renderScenarioDetail(
      makeScoredResult({
        audits: [
          makeAudit({ id: 1, success: 0.5 }),
          makeAudit({ id: 2 }),
          makeAudit({ id: 3 }),
          makeAudit({ id: 4, rationale: "default" }),
        ],
      }),
    );
    expect(out).toContain("2 other passing interactions not shown");
    expect(out).not.toMatch(/^\s+#2\s/m);
  });

  it("singularizes the passing-interaction count", () => {
    const out = renderScenarioDetail(
      makeScoredResult({ audits: [makeAudit({ id: 1, success: 0.5 }), makeAudit({ id: 2 })] }),
    );
    expect(out).toContain("1 other passing interaction not shown");
  });

  it("renders a necessity row with the flagged interaction ids", () => {
    const out = renderScenarioDetail(
      makeScoredResult({
        audits: [makeAudit({ id: 1, success: 0.5 })],
        necessity: { category: "agent", score: 0.7, unnecessaryIds: [4, 12], rationale: "Redundant greps." },
      }),
    );
    expect(out).toMatch(/Necessity\s+Unnecessary: #4, #12\s+Redundant greps\./);
  });

  it("spills a long flagged-id list into a +N more suffix", () => {
    const out = renderScenarioDetail(
      makeScoredResult({
        audits: [makeAudit({ id: 1, success: 0.5 })],
        necessity: {
          category: "agent",
          score: 0.1,
          unnecessaryIds: [1, 2, 3, 4, 5, 6, 7],
          rationale: "Many redundant calls.",
        },
      }),
    );
    expect(out).toContain("Unnecessary: #1, #2, #3, #4, +3 more");
  });

  it("omits the table when every audit is a default placeholder", () => {
    const out = renderScenarioDetail(
      makeScoredResult({ audits: [makeAudit({ id: 1, success: 0.5, rationale: "default" })] }),
    );
    expect(out).not.toContain("Score breakdown");
  });

  it("omits the table when all audits pass and necessity is default", () => {
    const out = renderScenarioDetail(makeScoredResult({ audits: [makeAudit({ id: 1 })] }));
    expect(out).not.toContain("Score breakdown");
  });

  it("ignores context relevance outside the Agent category", () => {
    const envAudit = makeAudit({ id: 1, categories: ["environment"], contextRelevance: 0.2 });
    const env: CategoryScore = { ...makeCategory(60), auditedCount: 1, audits: [envAudit] };
    const out = renderScenarioDetail({ ...makeResult({ exitCode: 0 }), score: makeScoreResult({ env }) } as RunResult);

    // Relevance does not feed Env's score, so this audit counts as passing.
    expect(out).not.toMatch(/#1\s+Relevance: 20/);
  });

  it("keeps every line within the 102-column table footprint", () => {
    const out = renderScenarioDetail(
      makeScoredResult({
        audits: [
          makeAudit({
            id: 1,
            success: 0.99,
            speed: 0.99,
            contextRelevance: 0.99,
            rationale: "A ".repeat(200),
          }),
        ],
        necessity: {
          category: "agent",
          score: 0.1,
          unnecessaryIds: Array.from({ length: 40 }, (_, i) => i + 100),
          rationale: "Long rationale. ".repeat(40),
        },
      }),
    );

    for (const line of out.split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(102);
    }
  });
});
