import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeReportToStore } from "../../../src/reports/writer.js";
import type { RunOutput } from "../../../src/types/output.js";
import type { ScoredOutput } from "../../../src/types/scoring.js";
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-writer-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunOutput(): RunOutput {
  return {
    version: "0.1.0",
    timestamp: "2025-04-13T18:30:42.000Z",
    durationMs: 5000,
    results: [
      {
        scenarioKey: "hello-world",
        scenarioName: "Hello World",
        agentName: "claude-code",
        prompt: "Visit the target",
        rubric: [{ check: "Page loaded", weight: 1.0 }],
        agentConfig: { adapter: "claude-code" },
        output: {
          transcript: [{ type: "assistant", timestamp: "2025-04-13T18:30:43.000Z", content: { text: "Done" } }],
          result: "Completed",
          metadata: {
            startTime: "2025-04-13T18:30:42.000Z",
            endTime: "2025-04-13T18:30:44.000Z",
            durationMs: 2000,
            exitCode: 0,
            tokenUsage: { input: 500, output: 200 },
            totalCostUsd: 0.005,
          },
        },
      },
    ],
    summary: { total: 1, completed: 1, failed: 0 },
  };
}

function makeScoredOutput(): ScoredOutput {
  return {
    version: "0.1.0",
    timestamp: "2025-04-13T18:30:42.000Z",
    durationMs: 5000,
    results: [
      {
        scenarioKey: "cms/create-post",
        scenarioName: "Create Post",
        agentName: "claude-code",
        prompt: "Create a blog post",
        rubric: [{ check: "Post exists", weight: 1.0 }],
        agentConfig: { adapter: "claude-code" },
        output: {
          transcript: [],
          result: "Done",
          metadata: {
            startTime: "2025-04-13T18:30:42.000Z",
            endTime: "2025-04-13T18:30:47.000Z",
            durationMs: 5000,
            exitCode: 0,
          },
        },
        score: {
          axisScore: 85,
          goalAchievement: {
            score: 90,
            criteria: [{ check: "Post exists", weight: 1.0, score: 9, rationale: "Good" }],
          },
          environment: mockCategoryScore(100),
          service: mockCategoryScore(100),
          agent: mockCategoryScore(100),
          weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
        },
      },
    ],
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 85 },
  };
}

describe("writeReportToStore", () => {
  it("creates report directory structure", () => {
    const reportId = writeReportToStore(makeRunOutput(), tmpDir);

    expect(reportId).toBe("2025-04-13-183042");

    const reportDir = path.join(tmpDir, ".axis/reports", reportId);
    expect(fs.existsSync(path.join(reportDir, "report.json"))).toBe(true);
    expect(fs.existsSync(path.join(reportDir, "scenarios/hello-world/claude-code.json"))).toBe(true);
  });

  it("writes manifest without transcript data", () => {
    const reportId = writeReportToStore(makeRunOutput(), tmpDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "report.json"), "utf-8"));

    expect(manifest.version).toBe("0.1.0");
    expect(manifest.reportId).toBe(reportId);
    expect(manifest.timestamp).toBe("2025-04-13T18:30:42.000Z");
    expect(manifest.durationMs).toBe(5000);
    expect(manifest.summary.total).toBe(1);
    expect(manifest.results).toHaveLength(1);
    expect(manifest.results[0].scenarioKey).toBe("hello-world");
    expect(manifest.results[0].durationMs).toBe(2000);
    expect(manifest.results[0].exitCode).toBe(0);
    expect(manifest.results[0].tokenUsage).toEqual({ input: 500, output: 200 });
    expect(manifest.results[0].totalCostUsd).toBe(0.005);
    expect(manifest.results[0].file).toBe("scenarios/hello-world/claude-code.json");
    // No transcript in manifest
    expect(manifest.results[0].transcript).toBeUndefined();
    expect(manifest.results[0].output).toBeUndefined();
  });

  it("writes full result to scenario file", () => {
    const reportId = writeReportToStore(makeRunOutput(), tmpDir);
    const result = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "scenarios/hello-world/claude-code.json"), "utf-8"),
    );

    expect(result.scenarioKey).toBe("hello-world");
    expect(result.output.transcript).toHaveLength(1);
    expect(result.output.result).toBe("Completed");
    expect(result.prompt).toBe("Visit the target");
  });

  it("includes scores in manifest for scored output", () => {
    const reportId = writeReportToStore(makeScoredOutput(), tmpDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "report.json"), "utf-8"));

    expect(manifest.results[0].score).toBeDefined();
    expect(manifest.results[0].score.axisScore).toBe(85);
    expect(manifest.summary.averageAxisScore).toBe(85);
  });

  it("handles nested scenario keys", () => {
    const reportId = writeReportToStore(makeScoredOutput(), tmpDir);

    expect(
      fs.existsSync(path.join(tmpDir, ".axis/reports", reportId, "scenarios/cms/create-post/claude-code.json")),
    ).toBe(true);
  });

  it("omits optional fields when not present", () => {
    const output = makeRunOutput();
    delete output.results[0].output.metadata.tokenUsage;
    delete output.results[0].output.metadata.totalCostUsd;

    const reportId = writeReportToStore(output, tmpDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "report.json"), "utf-8"));

    expect(manifest.results[0].tokenUsage).toBeUndefined();
    expect(manifest.results[0].totalCostUsd).toBeUndefined();
  });

  it("writes .raw.ndjson file when rawOutput is present", () => {
    const output = makeRunOutput();
    output.results[0].output.rawOutput = [
      '{"type":"assistant","message":"hello"}',
      '{"type":"result","result":"done"}',
    ];

    const reportId = writeReportToStore(output, tmpDir);
    const rawPath = path.join(tmpDir, ".axis/reports", reportId, "scenarios/hello-world/claude-code.raw.ndjson");

    expect(fs.existsSync(rawPath)).toBe(true);
    const content = fs.readFileSync(rawPath, "utf-8");
    expect(content).toBe('{"type":"assistant","message":"hello"}\n{"type":"result","result":"done"}\n');
  });

  it("does not write .raw.ndjson when rawOutput is absent", () => {
    const reportId = writeReportToStore(makeRunOutput(), tmpDir);
    const rawPath = path.join(tmpDir, ".axis/reports", reportId, "scenarios/hello-world/claude-code.raw.ndjson");

    expect(fs.existsSync(rawPath)).toBe(false);
  });

  it("strips rawOutput from scenario JSON file", () => {
    const output = makeRunOutput();
    output.results[0].output.rawOutput = ['{"type":"result"}'];

    const reportId = writeReportToStore(output, tmpDir);
    const result = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "scenarios/hello-world/claude-code.json"), "utf-8"),
    );

    expect(result.output.rawOutput).toBeUndefined();
    // But the rest of the output is still there
    expect(result.output.transcript).toHaveLength(1);
    expect(result.output.result).toBe("Completed");
  });

  it("writes .sparse-index.txt in debug mode for scored results", () => {
    const scored = makeScoredOutput();
    scored.results[0].output.rawOutput = ['{"type":"result"}'];
    scored.results[0].score.sparseIndex = {
      lines: [
        "#1    agent    assistant   Planning approach",
        "#2    env      tool_use   Bash(ls -la) → ok, 0.5KB",
        "#3    service  tool_use   WebFetch(https://api.example.com) → 200, 2.1KB",
      ],
      interactions: [],
      stats: {
        totalInteractions: 3,
        byCategory: { environment: 1, service: 1, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 1500,
        wallClockMs: 1500,
      },
    };

    const reportId = writeReportToStore(scored, tmpDir);
    const indexPath = path.join(
      tmpDir,
      ".axis/reports",
      reportId,
      "scenarios/cms/create-post/claude-code.sparse-index.txt",
    );

    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, "utf-8");
    expect(content).toContain("# Sparse Index: cms/create-post / claude-code");
    expect(content).toContain("3 interactions");
    expect(content).toContain("env: 1");
    expect(content).toContain("svc: 1");
    expect(content).toContain("agent: 1");
    expect(content).toContain("#1    agent    assistant   Planning approach");
    expect(content).toContain("#3    service  tool_use   WebFetch(https://api.example.com) → 200, 2.1KB");
  });

  it("does not write .sparse-index.txt without debug mode", () => {
    const scored = makeScoredOutput();
    scored.results[0].score.sparseIndex = {
      lines: ["#1    agent    assistant   Done"],
      interactions: [],
      stats: {
        totalInteractions: 1,
        byCategory: { environment: 0, service: 0, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 0,
        wallClockMs: 0,
      },
    };

    const reportId = writeReportToStore(scored, tmpDir);
    const indexPath = path.join(
      tmpDir,
      ".axis/reports",
      reportId,
      "scenarios/cms/create-post/claude-code.sparse-index.txt",
    );

    // No rawOutput = not debug mode, so no sparse index file
    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it("writes report.html alongside report.json", () => {
    const reportId = writeReportToStore(makeScoredOutput(), tmpDir);
    const htmlPath = path.join(tmpDir, ".axis/reports", reportId, "report.html");
    expect(fs.existsSync(htmlPath)).toBe(true);
    const content = fs.readFileSync(htmlPath, "utf-8");
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain(reportId);
  });

  it("includes prompt, rubric, and agentConfig in manifest", () => {
    const output = makeRunOutput();
    const reportId = writeReportToStore(output, tmpDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".axis/reports", reportId, "report.json"), "utf-8"));

    expect(manifest.results[0].prompt).toBe("Visit the target");
    expect(manifest.results[0].rubric).toEqual([{ check: "Page loaded", weight: 1.0 }]);
    expect(manifest.results[0].agentConfig).toEqual({ adapter: "claude-code" });
  });

  it("strips sparseIndex from scenario JSON", () => {
    const scored = makeScoredOutput();
    scored.results[0].output.rawOutput = ['{"type":"result"}'];
    scored.results[0].score.sparseIndex = {
      lines: ["#1    agent    assistant   Done"],
      interactions: [],
      stats: {
        totalInteractions: 1,
        byCategory: { environment: 0, service: 0, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 0,
        wallClockMs: 0,
      },
    };

    const reportId = writeReportToStore(scored, tmpDir);
    const result = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".axis/reports", reportId, "scenarios/cms/create-post/claude-code.json"),
        "utf-8",
      ),
    );

    // sparseIndex should be stripped from the score to keep scenario JSON small
    expect(result.score.sparseIndex).toBeUndefined();
    // But the rest of the score is still there
    expect(result.score.axisScore).toBe(85);
    expect(result.score.goalAchievement.score).toBe(90);
    expect(result.score.environment).toBeDefined();
  });
});
