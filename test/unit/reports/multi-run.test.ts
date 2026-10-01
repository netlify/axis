import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { finalizeReport, initReport, writeScenarioRawData } from "../../../src/reports/writer.js";
import { readReport, readScenarioResult, readScenarioResults } from "../../../src/reports/reader.js";
import type { ScoredOutput, ScoredRunResult, ScoringWeights } from "../../../src/types/scoring.js";
import type { ReportManifest } from "../../../src/types/report.js";

const WEIGHTS: ScoringWeights = { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 };

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-multirun-test-"));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

interface RunSpec {
  runIndex: number;
  runCount: number;
  dims?: number;
  axis?: number;
  failed?: boolean;
  withheld?: boolean;
  agentName?: string;
}

function makeScoredRun(spec: RunSpec): ScoredRunResult {
  const broken = (spec.failed ?? false) || (spec.withheld ?? false);
  // Mirror `buildZeroScore`: a run that failed or was withheld carries zeros,
  // not the caller's nominal dimension value.
  const dims = broken ? 0 : (spec.dims ?? 80);
  const category = (score: number) => ({
    score,
    interactionCount: 1,
    auditedCount: 1,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment" as const, score: 1, unnecessaryIds: [], rationale: "" },
  });

  return {
    scenarioKey: "hello-world",
    scenarioName: "Hello World",
    agentName: spec.agentName ?? "claude-code",
    runIndex: spec.runIndex,
    runCount: spec.runCount,
    prompt: "Do the thing",
    judge: [{ check: "It happened", weight: 1 }],
    agentConfig: { agent: "claude-code" },
    output: {
      transcript: [{ type: "assistant", timestamp: "2025-04-13T18:30:43.000Z", content: { text: "Done" } }],
      result: "Completed",
      rawOutput: [`{"run":${spec.runIndex}}`],
      metadata: {
        startTime: "2025-04-13T18:30:42.000Z",
        endTime: "2025-04-13T18:30:44.000Z",
        durationMs: 1000 * spec.runIndex,
        exitCode: broken ? 1 : 0,
        tokenUsage: { input: 100, output: 50 },
        totalCostUsd: 0.001,
        ...(broken ? { error: "boom" } : {}),
      },
    },
    score: {
      axisScore: spec.axis ?? dims,
      goalAchievement: { score: dims, criteria: [] },
      environment: category(dims),
      service: category(dims),
      agent: category(dims),
      weights: WEIGHTS,
      ...(spec.withheld ? { withheld: true } : {}),
    },
  } as ScoredRunResult;
}

function makeOutput(results: ScoredRunResult[]): ScoredOutput {
  const pairs = new Set(results.map((r) => `${r.scenarioKey}/${r.agentName}`));
  return {
    version: "0.1.0",
    timestamp: "2025-04-13T18:30:42.000Z",
    durationMs: 9000,
    results,
    summary: {
      total: pairs.size,
      completed: pairs.size,
      failed: 0,
      runsTotal: results.length,
      runsFailed: results.filter((r) => r.output.metadata.error).length,
      averageAxisScore: 80,
    },
  };
}

/** Write a report and return both its manifest and its directory. */
function writeReport(results: ScoredRunResult[]): { manifest: ReportManifest; reportDir: string } {
  const { reportDir } = initReport("2025-04-13T18:30:42.000Z", configDir);
  for (const result of results) {
    writeScenarioRawData(reportDir, result, undefined);
  }
  finalizeReport(reportDir, makeOutput(results));
  const manifest = readReport(configDir, "latest")!;
  return { manifest, reportDir };
}

describe("multi-run report layout", () => {
  it("writes each run into its own directory", () => {
    const { reportDir } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    const pair = path.join(reportDir, "scenarios", "hello-world", "claude-code");
    for (const i of [1, 2, 3]) {
      expect(fs.existsSync(path.join(pair, `run-${i}`, "result.json"))).toBe(true);
      expect(fs.existsSync(path.join(pair, `run-${i}`, "raw.ndjson"))).toBe(true);
    }
    // The single-run file must not also exist, or readers would find it first.
    expect(fs.existsSync(path.join(reportDir, "scenarios", "hello-world", "claude-code.json"))).toBe(false);
  });

  it("keeps a single-run pair in the original flat layout", () => {
    const { reportDir, manifest } = writeReport([makeScoredRun({ runIndex: 1, runCount: 1 })]);

    expect(fs.existsSync(path.join(reportDir, "scenarios", "hello-world", "claude-code.json"))).toBe(true);
    expect(manifest.results[0].file).toBe("scenarios/hello-world/claude-code.json");
    // No multi-run fields leak into a single-run entry.
    expect(manifest.results[0].runs).toBeUndefined();
    expect(manifest.results[0].spread).toBeUndefined();
    expect(manifest.results[0].reliability).toBeUndefined();
    expect(manifest.results[0].runCount).toBeUndefined();
  });

  it("collapses a repeated pair into one manifest entry", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    expect(manifest.results).toHaveLength(1);
    const entry = manifest.results[0];
    expect(entry.runCount).toBe(3);
    expect(entry.runs).toHaveLength(3);
    expect(entry.reliability).toEqual({ succeeded: 3, total: 3, withheld: 0 });
  });

  it("headlines the representative run and points `file` at it", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    const entry = manifest.results[0];
    expect(entry.spread?.representativeRunIndex).toBe(2);
    expect(entry.score?.axisScore).toBe(80);
    expect(entry.file).toBe("scenarios/hello-world/claude-code/run-2/result.json");
    // The headline duration is the representative's, not a sum.
    expect(entry.durationMs).toBe(2000);
    expect(entry.runs?.find((r) => r.representative)?.runIndex).toBe(2);
  });

  it("records each run's dimension scores, replacing a single set of medians", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70, axis: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90, axis: 90 }),
    ]);

    const runs = manifest.results[0].runs!;
    expect(runs.map((r) => r.dimensionScores?.goalAchievement)).toEqual([70, 80, 90]);
    expect(runs[1].dimensionScores).toEqual({
      goalAchievement: 80,
      environment: 80,
      service: 80,
      agent: 80,
    });
    // The spread no longer carries per-dimension medians; the distribution is
    // visible per run instead.
    expect(manifest.results[0].spread).not.toHaveProperty("dimensionMedians");
  });

  it("publishes a failed run's zeros but omits a withheld run's entirely", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 2, runCount: 3, failed: true, axis: 0 }),
      makeScoredRun({ runIndex: 3, runCount: 3, withheld: true, axis: 0 }),
    ]);

    const runs = manifest.results[0].runs!;
    expect(runs[0].dimensionScores?.goalAchievement).toBe(80);

    // A failed run really did score zero on process quality, and it is flagged
    // `failed`, so the zeros are a measurement rather than a placeholder.
    expect(runs[1].failed).toBe(true);
    expect(runs[1].axisScore).toBe(0);
    expect(runs[1].dimensionScores).toEqual({
      goalAchievement: 0,
      environment: 0,
      service: 0,
      agent: 0,
    });

    // A withheld run's zeros stand in for "unknown", so no number is published
    // at all, composite or per dimension.
    expect(runs[2].withheld).toBe(true);
    expect(runs[2].axisScore).toBeUndefined();
    expect(runs[2].dimensionScores).toBeUndefined();
  });

  it("carries each run's full score so the HTML can switch between them offline", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70, axis: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90, axis: 90 }),
    ]);

    const entry = manifest.results[0];
    const runs = entry.runs!;
    expect(runs.map((r) => r.score?.axisScore)).toEqual([70, 80, 90]);
    // Enough of the score to render a full breakdown, not just the headline.
    expect(runs[0].score?.goalAchievement).toBeDefined();
    expect(runs[0].score?.environment.audits).toBeDefined();
    // The representative's copy matches the pair's top-level score.
    expect(entry.score?.axisScore).toBe(80);
    expect(runs[1].score?.axisScore).toBe(entry.score?.axisScore);
  });

  it("omits the score for runs that have none", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 2, runCount: 3, failed: true, axis: 0 }),
      makeScoredRun({ runIndex: 3, runCount: 3, withheld: true, axis: 0 }),
    ]);

    const runs = manifest.results[0].runs!;
    expect(runs[0].score).toBeDefined();
    // A failed run's zeros are real, so its score rides along; a withheld
    // run's are not, so nothing is published.
    expect(runs[1].score?.axisScore).toBe(0);
    expect(runs[2].score).toBeUndefined();
  });

  it("records the spread across successful runs", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70, axis: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90, axis: 90 }),
    ]);

    const spread = manifest.results[0].spread!;
    expect(spread.n).toBe(3);
    expect(spread.axisScore.median).toBe(80);
    expect(spread.axisScore.min).toBe(70);
    expect(spread.axisScore.max).toBe(90);
    expect(spread.axisScore.stdev).toBe(10);
  });

  it("excludes a failed run from the score but counts it against reliability", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, failed: true, axis: 0 }),
    ]);

    const entry = manifest.results[0];
    expect(entry.reliability).toEqual({ succeeded: 2, total: 3, withheld: 0 });
    // The zero from the crash must not drag the band down.
    expect(entry.spread?.n).toBe(2);
    expect(entry.spread?.axisScore.min).toBe(80);
    expect(entry.runs?.find((r) => r.runIndex === 3)?.failed).toBe(true);
  });

  it("drops a withheld run from the reliability denominator", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, withheld: true, axis: 0 }),
    ]);

    const entry = manifest.results[0];
    expect(entry.reliability).toEqual({ succeeded: 2, total: 2, withheld: 1 });
    const withheldRun = entry.runs?.find((r) => r.runIndex === 3);
    expect(withheldRun?.withheld).toBe(true);
    // A withheld score is unknown, not zero, so no number is published.
    expect(withheldRun?.axisScore).toBeUndefined();
  });

  it("still produces an entry when every run failed", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, failed: true, axis: 0 }),
      makeScoredRun({ runIndex: 2, runCount: 3, failed: true, axis: 0 }),
      makeScoredRun({ runIndex: 3, runCount: 3, failed: true, axis: 0 }),
    ]);

    const entry = manifest.results[0];
    expect(entry.failed).toBe(true);
    expect(entry.spread).toBeUndefined();
    expect(entry.reliability).toEqual({ succeeded: 0, total: 3, withheld: 0 });
  });

  it("keeps separate agents on the same scenario as separate entries", () => {
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, agentName: "claude-code" }),
      makeScoredRun({ runIndex: 2, runCount: 3, agentName: "claude-code" }),
      makeScoredRun({ runIndex: 3, runCount: 3, agentName: "claude-code" }),
      makeScoredRun({ runIndex: 1, runCount: 3, agentName: "codex" }),
      makeScoredRun({ runIndex: 2, runCount: 3, agentName: "codex" }),
      makeScoredRun({ runIndex: 3, runCount: 3, agentName: "codex" }),
    ]);

    expect(manifest.results).toHaveLength(2);
    expect(manifest.results.map((r) => r.agentName).sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("incomplete samples", () => {
  it("still aggregates a pair holding fewer runs than it was configured for", () => {
    // Not reachable through `--failed`, which retries whole pairs precisely so
    // a retry report never holds a partial sample. Kept as a guard: nothing
    // validates `runs.length`, so aggregation must stay defined if some other
    // path ever produces a short list.
    const { manifest } = writeReport([
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80, axis: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90, axis: 90 }),
    ]);

    const entry = manifest.results[0];
    expect(entry.runCount).toBe(3);
    expect(entry.runs).toHaveLength(2);
    expect(entry.spread?.n).toBe(2);
    // Median of two is their midpoint, which neither run scored, so the
    // lower-indexed of the two central runs wins. Still a real run.
    expect(entry.spread?.representativeRunIndex).toBe(2);
    expect(entry.score?.axisScore).toBe(80);
  });
});

describe("reading multi-run reports", () => {
  it("reads every run of a pair", () => {
    writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    const results = readScenarioResults(configDir, "latest", "hello-world");
    expect(results.map((r) => r.runIndex)).toEqual([1, 2, 3]);
  });

  it("selects a specific run by index", () => {
    writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    const run = readScenarioResult(configDir, "latest", "hello-world", "claude-code", 3);
    expect(run?.runIndex).toBe(3);
  });

  it("defaults to the lowest run index when none is requested", () => {
    writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    expect(readScenarioResult(configDir, "latest", "hello-world", "claude-code")?.runIndex).toBe(1);
  });

  it("returns null for a run index that was not recorded", () => {
    writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, dims: 70 }),
      makeScoredRun({ runIndex: 2, runCount: 3, dims: 80 }),
      makeScoredRun({ runIndex: 3, runCount: 3, dims: 90 }),
    ]);

    expect(readScenarioResult(configDir, "latest", "hello-world", "claude-code", 7)).toBeNull();
  });

  it("still reads a single-run pair, ignoring a stray artifacts directory", () => {
    const { reportDir } = writeReport([makeScoredRun({ runIndex: 1, runCount: 1 })]);
    // Artifacts live in the agent directory even for a single run, so the
    // reader has to tolerate a directory and a file for the same agent.
    fs.mkdirSync(path.join(reportDir, "scenarios", "hello-world", "claude-code", "artifacts"), { recursive: true });

    const results = readScenarioResults(configDir, "latest", "hello-world");
    expect(results).toHaveLength(1);
    expect(results[0].agentName).toBe("claude-code");
  });

  it("reads every agent's runs in a stable order", () => {
    writeReport([
      makeScoredRun({ runIndex: 1, runCount: 3, agentName: "codex" }),
      makeScoredRun({ runIndex: 2, runCount: 3, agentName: "codex" }),
      makeScoredRun({ runIndex: 1, runCount: 3, agentName: "claude-code" }),
      makeScoredRun({ runIndex: 2, runCount: 3, agentName: "claude-code" }),
    ]);

    const results = readScenarioResults(configDir, "latest", "hello-world");
    expect(results.map((r) => `${r.agentName}#${r.runIndex}`)).toEqual([
      "claude-code#1",
      "claude-code#2",
      "codex#1",
      "codex#2",
    ]);
  });
});
