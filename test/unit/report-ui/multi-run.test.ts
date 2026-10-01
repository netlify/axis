import { describe, it, expect } from "vitest";
import { renderReport } from "../../../src/report-ui/src/scripts/render.js";
import type { ReportData, ResultEntry, ScoreResult } from "../../../src/report-ui/src/scripts/types.js";

function makeScore(axis: number): ScoreResult {
  const category = (score: number) => ({
    score,
    interactionCount: 1,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment", score: 1, unnecessaryIds: [], rationale: "fine" },
  });
  return {
    axisScore: axis,
    goalAchievement: { score: axis, criteria: [] },
    environment: category(axis),
    service: category(axis),
    agent: category(axis),
    weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
  };
}

function makeReport(entry: Partial<ResultEntry>): ReportData {
  return {
    version: "0.1.0",
    reportId: "2026-09-29-120000",
    timestamp: "2026-09-29T12:00:00.000Z",
    durationMs: 9000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 87 },
    results: [
      {
        scenarioKey: "cms/create-post",
        scenarioName: "Create post",
        agentName: "claude-code|opus",
        durationMs: 2000,
        exitCode: 0,
        file: "scenarios/cms/create-post/claude-code|opus/run-2/result.json",
        ...entry,
      },
    ],
  };
}

const REPEATED = makeReport({
  score: makeScore(87),
  runCount: 3,
  reliability: { succeeded: 3, total: 3, withheld: 0 },
  spread: {
    n: 3,
    axisScore: { median: 87, min: 81, max: 92, mean: 86.67, stdev: 5.51 },
    representativeRunIndex: 2,
  },
  runs: [
    {
      runIndex: 1,
      durationMs: 1000,
      exitCode: 0,
      axisScore: 81,
      score: makeScore(81),
      file: "scenarios/cms/create-post/claude-code|opus/run-1/result.json",
    },
    {
      runIndex: 2,
      durationMs: 2000,
      exitCode: 0,
      axisScore: 87,
      score: makeScore(87),
      representative: true,
      file: "scenarios/cms/create-post/claude-code|opus/run-2/result.json",
    },
    {
      runIndex: 3,
      durationMs: 3000,
      exitCode: 0,
      axisScore: 92,
      score: makeScore(92),
      file: "scenarios/cms/create-post/claude-code|opus/run-3/result.json",
    },
  ],
});

describe("renderReport with a repeated pair", () => {
  it("marks the row with a runs pill", () => {
    const html = renderReport(REPEATED);
    expect(html).toContain('class="runs-pill"');
    expect(html).toContain("3 runs · σ 5.5");
  });

  it("explains the representative selection in the pill tooltip", () => {
    const html = renderReport(REPEATED);
    expect(html).toContain("Representative run #2");
    expect(html).toContain("median 87, range 81-92");
  });

  it("renders a per-run table with the spread summary", () => {
    const html = renderReport(REPEATED);
    expect(html).toContain('class="runs-table"');
    expect(html).toContain("Median 87");
    expect(html).toContain("across 3 scored runs");
  });

  it("emits every hook the run switcher queries", () => {
    // `initInteractions` in interactions.ts selects on these exactly. Renaming
    // one here without the other would break switching silently, and there is
    // no DOM in the test environment to catch it at runtime.
    const html = renderReport(REPEATED);
    for (const hook of [
      'class="runs-row', // row click target
      'class="runs-select"', // the actual button
      'class="run-panel', // the panels being toggled
      'data-pair="0"', // scopes a switch to one pair
      'data-run="2"', // identifies which run
      'aria-pressed="true"', // selection state on the button
    ]) {
      expect(html).toContain(hook);
    }
  });

  it("shows each run's dimension scores so a moving dimension is visible", () => {
    const html = renderReport(
      makeReport({
        score: makeScore(87),
        runCount: 3,
        reliability: { succeeded: 3, total: 3, withheld: 0 },
        runs: [
          {
            runIndex: 1,
            durationMs: 1000,
            exitCode: 0,
            axisScore: 80,
            dimensionScores: { goalAchievement: 95, environment: 90, service: 60, agent: 55 },
            file: "a",
          },
          {
            runIndex: 2,
            durationMs: 1000,
            exitCode: 0,
            axisScore: 80,
            dimensionScores: { goalAchievement: 62, environment: 90, service: 95, agent: 93 },
            representative: true,
            file: "b",
          },
        ],
      }),
    );

    // Two runs with the same composite and opposite profiles: the columns are
    // what make that legible.
    for (const value of [95, 60, 55, 62, 93]) {
      expect(html).toContain(`>${value}</td>`);
    }
  });

  it("dashes the dimension columns for a run with no score", () => {
    const html = renderReport(
      makeReport({
        score: makeScore(87),
        runCount: 3,
        reliability: { succeeded: 1, total: 2, withheld: 1 },
        runs: [
          { runIndex: 1, durationMs: 1000, exitCode: 0, axisScore: 87, representative: true, file: "a" },
          { runIndex: 2, durationMs: 1000, exitCode: 1, failed: true, file: "b" },
        ],
      }),
    );

    expect(html).toContain("\u2013");
  });

  it("no longer links out to result.json, since every run is inspectable in-page", () => {
    const html = renderReport(REPEATED);
    expect(html).not.toContain("result.json");
    expect(html).not.toContain("runs-link");
  });

  it("renders one switchable panel per run, keyed to the pair", () => {
    const html = renderReport(REPEATED);
    for (const i of [1, 2, 3]) {
      expect(html).toContain(`data-run="${i}"`);
    }
    // Three rows plus three panels, all carrying the same pair key so the
    // switcher cannot reach another pair's panels.
    expect(html.match(/class="run-panel[^"]*" data-pair="0"/g)).toHaveLength(3);
    expect(html.match(/class="runs-row[^"]*" data-pair="0"/g)).toHaveLength(3);
  });

  it("opens on the representative run and hides the rest", () => {
    const html = renderReport(REPEATED);
    const visible = html.match(/class="run-panel visible" data-pair="0" data-run="(\d+)"/g) ?? [];
    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain('data-run="2"');
    expect(html).toContain('class="runs-row runs-row-rep runs-row-selected"');
  });

  it("falls back to the first run when no run earned a representative", () => {
    const html = renderReport(
      makeReport({
        score: undefined,
        failed: true,
        runCount: 3,
        reliability: { succeeded: 0, total: 3, withheld: 0 },
        runs: [
          { runIndex: 1, durationMs: 100, exitCode: 1, failed: true, error: "boom", file: "a" },
          { runIndex: 2, durationMs: 100, exitCode: 1, failed: true, error: "boom", file: "b" },
          { runIndex: 3, durationMs: 100, exitCode: 1, failed: true, error: "boom", file: "c" },
        ],
      }),
    );

    const visible = html.match(/class="run-panel visible" data-pair="0" data-run="(\d+)"/g) ?? [];
    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain('data-run="1"');
  });

  it("explains why a run without a score has no breakdown", () => {
    const html = renderReport(
      makeReport({
        score: makeScore(87),
        runCount: 3,
        reliability: { succeeded: 1, total: 2, withheld: 1 },
        runs: [
          {
            runIndex: 1,
            durationMs: 1000,
            exitCode: 0,
            axisScore: 87,
            representative: true,
            score: makeScore(87),
            file: "a",
          },
          { runIndex: 2, durationMs: 1000, exitCode: 1, failed: true, error: "timeout", file: "b" },
          { runIndex: 3, durationMs: 1000, exitCode: 1, failed: true, withheld: true, file: "c" },
        ],
      }),
    );

    // The reason text is HTML-escaped, so assert on apostrophe-free fragments.
    expect(html).toContain("This run failed, so it was excluded from the pair");
    expect(html).toContain("measurement failure, not an agent failure");
  });

  it("marks the representative in its own column rather than inline", () => {
    const html = renderReport(REPEATED);
    expect(html).toContain("runs-row-rep");
    // A dedicated cell, so every Run cell stays the same width.
    expect(html).toContain('<th class="runs-rep-col">Representative');
    expect(html).toContain('class="runs-rep-mark"');
    // Exactly one run is marked.
    expect(html.match(/class="runs-rep-mark"/g)).toHaveLength(1);
    // The marker is not back in the Run cell.
    expect(html).not.toContain("representative</span>");
  });

  it("explains the representative in a tooltip instead of a block of prose", () => {
    const html = renderReport(REPEATED);
    // The old static paragraph claimed "showing the representative run below",
    // which went stale as soon as a reader switched runs, and cost height on
    // every expanded pair.
    // Assert on the removed wording, not on the class: `.runs-note` is still
    // used by the panel for a run that has no score.
    expect(html).not.toContain("Showing the representative run below");
    expect(html).toContain('class="info-btn" data-tooltip=');
    expect(html).toContain("nearest the median");
    expect(html).toContain("Select any row to switch the breakdown");
    expect(html).toContain('aria-label="What is the representative run?"');
  });

  it("distinguishes a failed run from a withheld one", () => {
    const html = renderReport(
      makeReport({
        score: makeScore(87),
        runCount: 3,
        reliability: { succeeded: 1, total: 2, withheld: 1 },
        runs: [
          { runIndex: 1, durationMs: 1000, exitCode: 0, axisScore: 87, representative: true, file: "a" },
          { runIndex: 2, durationMs: 1000, exitCode: 1, failed: true, error: "timeout", file: "b" },
          { runIndex: 3, durationMs: 1000, exitCode: 1, failed: true, withheld: true, file: "c" },
        ],
      }),
    );

    expect(html).toContain(">failed</span>");
    expect(html).toContain(">withheld</span>");
    expect(html).toContain("1/2 scored");
  });

  it("reports when no run scored", () => {
    const html = renderReport(
      makeReport({
        score: undefined,
        failed: true,
        runCount: 2,
        reliability: { succeeded: 0, total: 2, withheld: 0 },
        runs: [
          { runIndex: 1, durationMs: 100, exitCode: 1, failed: true, file: "a" },
          { runIndex: 2, durationMs: 100, exitCode: 1, failed: true, file: "b" },
        ],
      }),
    );

    expect(html).toContain("No run produced a score.");
  });
});

describe("renderReport with a single-run pair", () => {
  it("adds no pill, table, or note", () => {
    const html = renderReport(makeReport({ score: makeScore(87), file: "scenarios/x/y.json" }));

    expect(html).not.toContain("runs-pill");
    expect(html).not.toContain("runs-table");
    expect(html).not.toContain("runs-note");
  });

  it("does not render the runs table for a pair with a single-entry runs list", () => {
    const html = renderReport(
      makeReport({
        score: makeScore(87),
        runCount: 1,
        runs: [{ runIndex: 1, durationMs: 1000, exitCode: 0, axisScore: 87, file: "a" }],
      }),
    );

    expect(html).not.toContain("runs-table");
  });
});
