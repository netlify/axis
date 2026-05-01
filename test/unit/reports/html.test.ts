import { describe, it, expect } from "vitest";
import { generateReportHtml } from "../../../src/reports/html.js";
import type { ReportManifest, ReportResultEntry } from "../../../src/types/report.js";
import type { CategoryScore } from "../../../src/types/scoring.js";

function mockCategoryScore(score: number): CategoryScore {
  return {
    score,
    interactionCount: 3,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [
      {
        id: 1,
        categories: ["environment"],
        success: score / 100,
        speed: score / 100,
        weight: score / 100,
        contextRelevance: score / 100,
        rationale: score === 100 ? "default" : "Tool had issues with response size",
      },
    ],
    necessity: { category: "environment", score: score / 100, unnecessaryIds: [], rationale: "test necessity" },
  };
}

function makeResultEntry(overrides?: Partial<ReportResultEntry>): ReportResultEntry {
  return {
    scenarioKey: "hello-world",
    scenarioName: "Hello World Scenario",
    agentName: "claude-code",
    durationMs: 2000,
    exitCode: 0,
    tokenUsage: { input: 500, output: 200 },
    totalCostUsd: 0.005,
    file: "scenarios/hello-world/claude-code.json",
    score: {
      axisScore: 85,
      goalAchievement: {
        score: 90,
        criteria: [
          { check: "Page loaded successfully", weight: 0.5, score: 9, rationale: "Page loaded fine" },
          { check: "Content is visible", weight: 0.5, score: 8, rationale: "Content rendered correctly" },
        ],
      },
      environment: mockCategoryScore(80),
      service: mockCategoryScore(70),
      agent: mockCategoryScore(90),
      weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
    },
    ...overrides,
  };
}

function makeReport(overrides?: Partial<ReportManifest>): ReportManifest {
  return {
    version: "0.1.0",
    reportId: "2025-04-13-183042",
    timestamp: "2025-04-13T18:30:42.000Z",
    durationMs: 5000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 85 },
    results: [
      {
        scenarioKey: "hello-world",
        scenarioName: "Hello World Scenario",
        agentName: "claude-code",
        durationMs: 2000,
        exitCode: 0,
        tokenUsage: { input: 500, output: 200 },
        totalCostUsd: 0.005,
        file: "scenarios/hello-world/claude-code.json",
        score: {
          axisScore: 85,
          goalAchievement: {
            score: 90,
            criteria: [
              { check: "Page loaded successfully", weight: 0.5, score: 9, rationale: "Page loaded fine" },
              { check: "Content is visible", weight: 0.5, score: 8, rationale: "Content rendered correctly" },
            ],
          },
          environment: mockCategoryScore(80),
          service: mockCategoryScore(70),
          agent: mockCategoryScore(90),
          weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
        },
      },
    ],
    ...overrides,
  };
}

describe("generateReportHtml", () => {
  it("returns a valid HTML document", () => {
    const html = generateReportHtml(makeReport());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<title>");
  });

  it("includes report ID", () => {
    const html = generateReportHtml(makeReport({ reportId: "2025-04-13-183042" }));
    expect(html).toContain("2025-04-13-183042");
  });

  it("includes design system colors in CSS", () => {
    const html = generateReportHtml(makeReport());
    expect(html).toContain("#fafbf9");
    expect(html).toContain("#016867");
    expect(html).toContain("#059669");
    expect(html).toContain("#d97706");
  });

  it("embeds report data as JSON", () => {
    const html = generateReportHtml(makeReport());
    // The JSON should be embedded (escaped) in the HTML
    expect(html).toContain("Hello World Scenario");
    expect(html).toContain("claude-code");
    expect(html).toContain("85");
  });

  it("escapes HTML-dangerous characters in JSON", () => {
    const report = makeReport();
    report.results[0].scenarioName = '<script>alert("xss")</script>';
    const html = generateReportHtml(report);
    // < and > should be escaped as unicode escapes in the JSON
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003cscript\\u003e");
  });

  it("handles unscored results", () => {
    const report = makeReport();
    report.results[0].score = undefined;
    const html = generateReportHtml(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("NaN");
  });

  it("handles empty results array", () => {
    const report = makeReport({ results: [] });
    const html = generateReportHtml(report);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("handles error messages in results", () => {
    const report = makeReport();
    report.results[0].error = "API quota exceeded";
    report.results[0].exitCode = 1;
    const html = generateReportHtml(report);
    // Error message embedded in JSON data
    expect(html).toContain("API quota exceeded");
    // CSS and JS bundle contain error-btn styling and interaction code
    expect(html).toContain(".error-btn");
  });

  it("includes goal achievement criteria data", () => {
    const html = generateReportHtml(makeReport());
    expect(html).toContain("Page loaded successfully");
    expect(html).toContain("Content is visible");
  });

  it("includes criterion rendering code in JS bundle", () => {
    const html = generateReportHtml(makeReport());
    expect(html).toContain("criterion-perfect");
    expect(html).toContain("criterion-imperfect");
  });

  it("includes category dimension data", () => {
    const html = generateReportHtml(makeReport());
    // The embedded JSON should contain dimension data
    expect(html).toContain('"success"');
    expect(html).toContain('"speed"');
    expect(html).toContain('"weight"');
    expect(html).toContain('"relevance"');
    expect(html).toContain('"necessity"');
  });

  it("includes sparse index when present", () => {
    const report = makeReport();
    report.results[0].score!.sparseIndex = {
      lines: ["#1   agent    assistant   Planning approach"],
      interactions: [
        {
          id: 1,
          entryIndices: [0],
          categories: ["agent"],
          sparseLine: "#1   agent    assistant   Planning approach",
          toolName: null,
          hasError: false,
          durationMs: null,
          startMs: 0,
          contextBytes: 100,
        },
      ],
      stats: {
        totalInteractions: 1,
        byCategory: { environment: 0, service: 0, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 500,
        wallClockMs: 500,
      },
    };
    const html = generateReportHtml(report);
    expect(html).toContain("Planning approach");
  });

  it("renders expandable interaction content when present", () => {
    const report = makeReport();
    report.results[0].score!.sparseIndex = {
      lines: ["#1   env      tool_use   Write(file.md)"],
      interactions: [
        {
          id: 1,
          entryIndices: [0, 1],
          categories: ["environment"],
          sparseLine: "#1   env      tool_use   Write(file.md)",
          toolName: "Write",
          hasError: false,
          durationMs: null,
          startMs: 0,
          contextBytes: 100,
          content: "[TOOL_USE] Write\n  Input: file.md\n[TOOL_RESULT]\n  Result: File written successfully",
        },
      ],
      stats: {
        totalInteractions: 1,
        byCategory: { environment: 1, service: 0, agent: 0 },
        totalErrors: 0,
        totalDurationMs: 500,
        wallClockMs: 500,
      },
    };
    const html = generateReportHtml(report);
    expect(html).toContain("sparse-line-expandable");
    expect(html).toContain("sparse-line-content");
    expect(html).toContain("[TOOL_USE] Write");
    expect(html).toContain("File written successfully");
    expect(html).toContain("sparse-expand-all");
  });

  it("does not render interaction content blocks when interactions have no content", () => {
    const report = makeReport();
    report.results[0].score!.sparseIndex = {
      lines: ["#1   agent    assistant   Planning approach"],
      interactions: [
        {
          id: 1,
          entryIndices: [0],
          categories: ["agent"],
          sparseLine: "#1   agent    assistant   Planning approach",
          toolName: null,
          hasError: false,
          durationMs: null,
          startMs: 0,
          contextBytes: 100,
        },
      ],
      stats: {
        totalInteractions: 1,
        byCategory: { environment: 0, service: 0, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 500,
        wallClockMs: 500,
      },
    };
    const html = generateReportHtml(report);
    // The interaction content (TOOL_USE, TOOL_RESULT, etc.) should not appear in data
    expect(html).not.toContain("[TOOL_USE]");
    expect(html).not.toContain("[TOOL_RESULT]");
  });

  it("renders waterfall timeline when sparse index has startMs", () => {
    const report = makeReport();
    report.results[0].score!.sparseIndex = {
      lines: ["#1   agent    assistant   Planning", "#2   env      tool_use   Write(file.md)"],
      interactions: [
        {
          id: 1,
          entryIndices: [0],
          categories: ["agent"],
          sparseLine: "#1   agent    assistant   Planning",
          toolName: null,
          hasError: false,
          durationMs: 1000,
          startMs: 0,
          contextBytes: 50,
        },
        {
          id: 2,
          entryIndices: [1, 2],
          categories: ["environment"],
          sparseLine: "#2   env      tool_use   Write(file.md)",
          toolName: "Write",
          hasError: false,
          durationMs: 5000,
          startMs: 1000,
          contextBytes: 200,
        },
      ],
      stats: {
        totalInteractions: 2,
        byCategory: { environment: 1, service: 0, agent: 1 },
        totalErrors: 0,
        totalDurationMs: 6000,
        wallClockMs: 6000,
      },
    };
    const html = generateReportHtml(report);
    expect(html).toContain("Timeline");
    expect(html).toContain("wf-agent");
    expect(html).toContain("wf-env");
    expect(html).toContain("wf-bar");
    expect(html).toContain("wf-legend");
  });

  it("renders modal with prompt and rubric when present", () => {
    const report = makeReport();
    report.results[0].prompt = "Fetch docs and write summary.md";
    report.results[0].rubric = [
      { check: "Fetched the URL", weight: 0.5 },
      { check: "Wrote summary", weight: 0.5 },
    ];
    const html = generateReportHtml(report);
    expect(html).toContain("modal-backdrop");
    expect(html).toContain("modal-prompt");
    expect(html).toContain("Fetch docs and write summary.md");
    expect(html).toContain("Fetched the URL");
    expect(html).toContain("50%");
    expect(html).toContain("info-btn");
  });

  it("does not render modal when prompt is absent", () => {
    const report = makeReport();
    delete report.results[0].prompt;
    const html = generateReportHtml(report);
    // No modal elements rendered — CSS/JS definitions still exist in the bundle
    expect(html).not.toContain('data-modal-index="0"');
  });

  it("includes audit rationale data", () => {
    const report = makeReport();
    // The service category has a non-default rationale
    const html = generateReportHtml(report);
    expect(html).toContain("Tool had issues with response size");
  });

  it("handles unsored summary (RunSummary without averageAxisScore)", () => {
    const report = makeReport({
      summary: { total: 1, completed: 1, failed: 0 },
    });
    report.results[0].score = undefined;
    const html = generateReportHtml(report);
    expect(html).toContain("<!DOCTYPE html>");
  });

  describe("scenario grouping", () => {
    it("includes scenario grouping CSS and JS in the bundle", () => {
      const html = generateReportHtml(makeReport());
      // CSS class for scenario headers
      expect(html).toContain(".scenario-header-row");
      // CSS class for agent rows
      expect(html).toContain(".agent-row");
      // CSS class for collapse state
      expect(html).toContain(".scenario-collapsed");
      // JS grouping logic
      expect(html).toContain("col-scenario-header");
    });

    it("embeds multi-agent scenario data correctly", () => {
      const report = makeReport({
        summary: { total: 2, completed: 2, failed: 0, averageAxisScore: 85 },
        results: [
          makeResultEntry({ scenarioKey: "s1", scenarioName: "Scenario One", agentName: "agent-a" }),
          makeResultEntry({ scenarioKey: "s1", scenarioName: "Scenario One", agentName: "agent-b" }),
        ],
      });
      const html = generateReportHtml(report);
      expect(html).toContain("Scenario One");
      expect(html).toContain("agent-a");
      expect(html).toContain("agent-b");
    });

    it("embeds multi-scenario data correctly", () => {
      const report = makeReport({
        summary: { total: 4, completed: 4, failed: 0, averageAxisScore: 85 },
        results: [
          makeResultEntry({ scenarioKey: "s1", scenarioName: "Scenario A", agentName: "agent-1" }),
          makeResultEntry({ scenarioKey: "s2", scenarioName: "Scenario B", agentName: "agent-1" }),
          makeResultEntry({ scenarioKey: "s1", scenarioName: "Scenario A", agentName: "agent-2" }),
          makeResultEntry({ scenarioKey: "s2", scenarioName: "Scenario B", agentName: "agent-2" }),
        ],
      });
      const html = generateReportHtml(report);
      expect(html).toContain("Scenario A");
      expect(html).toContain("Scenario B");
      expect(html).toContain("agent-1");
      expect(html).toContain("agent-2");
    });

    it("handles unscored results with multiple agents", () => {
      const report = makeReport({
        summary: { total: 2, completed: 2, failed: 0 },
        results: [
          makeResultEntry({ scenarioKey: "s1", scenarioName: "S1", agentName: "a", score: undefined }),
          makeResultEntry({ scenarioKey: "s1", scenarioName: "S1", agentName: "b", score: undefined }),
        ],
      });
      const html = generateReportHtml(report);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).not.toContain("NaN");
    });

    it("embeds error data for failed agents in multi-agent scenarios", () => {
      const report = makeReport({
        summary: { total: 2, completed: 1, failed: 1, averageAxisScore: 85 },
        results: [
          makeResultEntry({ scenarioKey: "s1", scenarioName: "S1", agentName: "a" }),
          makeResultEntry({ scenarioKey: "s1", scenarioName: "S1", agentName: "b", exitCode: 1, error: "Timeout" }),
        ],
      });
      const html = generateReportHtml(report);
      expect(html).toContain("Timeout");
    });

    it("includes scenario collapse interaction code in bundle", () => {
      const html = generateReportHtml(makeReport());
      // The JS bundle should contain the collapse/expand logic
      expect(html).toContain("scenario-collapsed");
      expect(html).toContain("col-scenario-header");
    });
  });
});
