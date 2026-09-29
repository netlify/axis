import { describe, it, expect } from "vitest";
import { renderReport } from "../../../src/report-ui/src/scripts/render.js";
import type { ReportData } from "../../../src/report-ui/src/scripts/types.js";

function makeReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    version: "0.1.0",
    reportId: "2026-09-29-120000",
    timestamp: "2026-09-29T12:00:00.000Z",
    durationMs: 1000,
    summary: { total: 1, completed: 1, failed: 0 },
    results: [
      {
        scenarioKey: "hello",
        scenarioName: "Hello",
        agentName: "claude-code",
        durationMs: 500,
        exitCode: 0,
        file: "scenarios/hello/claude-code.json",
      },
    ],
    ...overrides,
  };
}

describe("load failure banner", () => {
  it("is absent when every scenario file loaded", () => {
    const html = renderReport(makeReport());
    expect(html).not.toContain("failed to load");
  });

  it("names each file that failed to load", () => {
    const html = renderReport(
      makeReport({
        summary: { total: 1, completed: 1, failed: 0, loadFailed: 2 },
        loadFailures: [
          { path: "/suite/scenarios/broken.ts", reason: "Unexpected end of input" },
          { path: "/suite/scenarios/data.json", reason: "file is not valid JSON" },
        ],
      }),
    );

    expect(html).toContain("2 scenario files failed to load");
    expect(html).toContain("does not cover the whole suite");
    expect(html).toContain("/suite/scenarios/broken.ts");
    expect(html).toContain("file is not valid JSON");
  });

  it("escapes paths and reasons", () => {
    const html = renderReport(
      makeReport({
        loadFailures: [{ path: "/s/<script>.ts", reason: "bad <tag>" }],
      }),
    );

    expect(html).not.toContain("<script>.ts");
    expect(html).toContain("&lt;script&gt;.ts");
    expect(html).toContain("1 scenario file failed to load");
  });
});
