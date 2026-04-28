import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeReportToStore } from "../../../src/reports/writer.js";
import { listReports, readReport, readScenarioResult, readScenarioResults } from "../../../src/reports/reader.js";
import type { ScoredOutput, CategoryScore } from "../../../src/types/scoring.js";

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-reader-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeScoredOutput(timestamp: string, scenarioKey = "hello-world"): ScoredOutput {
  return {
    version: "0.1.0",
    timestamp,
    durationMs: 5000,
    results: [
      {
        scenarioKey,
        scenarioName: "Hello World",
        agentName: "claude-code",
        target: "https://example.com",
        prompt: "Visit the target",
        rubric: "Check the page loads",
        agentConfig: { adapter: "claude-code" },
        output: {
          transcript: [{ type: "assistant", timestamp, content: { text: "Done" } }],
          result: "Completed",
          metadata: {
            startTime: timestamp,
            endTime: timestamp,
            durationMs: 2000,
            exitCode: 0,
          },
        },
        score: {
          axisScore: 80,
          goalAchievement: {
            score: 80,
            criteria: [{ check: "Page loaded", weight: 1.0, score: 8, rationale: "OK" }],
          },
          environment: mockCategoryScore(100),
          service: mockCategoryScore(100),
          agent: mockCategoryScore(100),
          weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
        },
      },
    ],
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 80 },
  };
}

describe("listReports", () => {
  it("returns empty array when no reports exist", () => {
    expect(listReports(tmpDir)).toEqual([]);
  });

  it("returns reports sorted newest first", () => {
    writeReportToStore(makeScoredOutput("2025-04-10T10:00:00.000Z"), tmpDir);
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:00.000Z"), tmpDir);
    writeReportToStore(makeScoredOutput("2025-04-12T12:00:00.000Z"), tmpDir);

    const reports = listReports(tmpDir);

    expect(reports).toHaveLength(3);
    expect(reports[0].reportId).toBe("2025-04-13-183000");
    expect(reports[1].reportId).toBe("2025-04-12-120000");
    expect(reports[2].reportId).toBe("2025-04-10-100000");
  });

  it("skips corrupted report files", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:00.000Z"), tmpDir);

    // Write a corrupted report
    const corruptDir = path.join(tmpDir, ".axis/reports/bad-report");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "report.json"), "not json");

    const reports = listReports(tmpDir);
    expect(reports).toHaveLength(1);
  });
});

describe("readReport", () => {
  it("reads a report by ID", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    const report = readReport(tmpDir, "2025-04-13-183042");

    expect(report).not.toBeNull();
    expect(report!.reportId).toBe("2025-04-13-183042");
    expect(report!.results).toHaveLength(1);
  });

  it("returns null for nonexistent report", () => {
    expect(readReport(tmpDir, "nonexistent")).toBeNull();
  });

  it("supports 'latest' alias", () => {
    writeReportToStore(makeScoredOutput("2025-04-10T10:00:00.000Z"), tmpDir);
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:00.000Z"), tmpDir);

    const report = readReport(tmpDir, "latest");

    expect(report).not.toBeNull();
    expect(report!.reportId).toBe("2025-04-13-183000");
  });

  it("returns null for 'latest' when no reports exist", () => {
    expect(readReport(tmpDir, "latest")).toBeNull();
  });
});

describe("readScenarioResult", () => {
  it("reads a full scenario result with transcript", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    const result = readScenarioResult(tmpDir, "2025-04-13-183042", "hello-world", "claude-code");

    expect(result).not.toBeNull();
    expect(result!.scenarioKey).toBe("hello-world");
    expect(result!.output.transcript).toHaveLength(1);
    expect(result!.output.result).toBe("Completed");
    expect("score" in result!).toBe(true);
  });

  it("returns null for nonexistent scenario", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    expect(readScenarioResult(tmpDir, "2025-04-13-183042", "nonexistent", "claude-code")).toBeNull();
  });

  it("supports 'latest' alias", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    const result = readScenarioResult(tmpDir, "latest", "hello-world", "claude-code");
    expect(result).not.toBeNull();
    expect(result!.scenarioKey).toBe("hello-world");
  });
});

function makeMultiAgentOutput(timestamp: string): ScoredOutput {
  const base = makeScoredOutput(timestamp);
  const codexResult = {
    ...base.results[0],
    agentName: "codex",
    agentConfig: { adapter: "codex" },
    score: {
      ...base.results[0].score,
      axisScore: 65,
    },
  };
  return {
    ...base,
    results: [base.results[0], codexResult],
    summary: { total: 2, completed: 2, failed: 0, averageAxisScore: 73 },
  };
}

describe("readScenarioResults", () => {
  it("reads all agent results for a scenario", () => {
    writeReportToStore(makeMultiAgentOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    const results = readScenarioResults(tmpDir, "2025-04-13-183042", "hello-world");

    expect(results).toHaveLength(2);
    const agents = results.map((r) => r.agentName).sort();
    expect(agents).toEqual(["claude-code", "codex"]);
  });

  it("returns empty array for nonexistent scenario", () => {
    writeReportToStore(makeScoredOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    expect(readScenarioResults(tmpDir, "2025-04-13-183042", "nonexistent")).toEqual([]);
  });

  it("returns empty array for nonexistent report", () => {
    expect(readScenarioResults(tmpDir, "nonexistent", "hello-world")).toEqual([]);
  });

  it("supports 'latest' alias", () => {
    writeReportToStore(makeMultiAgentOutput("2025-04-13T18:30:42.000Z"), tmpDir);

    const results = readScenarioResults(tmpDir, "latest", "hello-world");
    expect(results).toHaveLength(2);
  });
});
