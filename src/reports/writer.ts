import * as fs from "node:fs";
import * as path from "node:path";
import type { RunOutput, RunResult } from "../types/output.js";
import { isFailedRun, isScoredResult } from "../types/output.js";
import type { ScoredOutput, ScoredRunResult, SparseIndex } from "../types/scoring.js";
import type { ReportManifest, ReportResultEntry, ReportRunEntry } from "../types/report.js";
import { aggregatePair, groupRunsByPair } from "../scoring/aggregate.js";
import { resultPath, runSiblingPath, type RunRef } from "./paths.js";
import { generateReportHtml } from "./html.js";

const REPORTS_DIR = ".axis/reports";

/** Where in the report tree a given result's files belong. */
function runRefOf(result: RunResult | ScoredRunResult): RunRef {
  return {
    scenarioKey: result.scenarioKey,
    agentName: result.agentName,
    runIndex: result.runIndex,
    runCount: result.runCount,
  };
}

// --- Phase 1: Create report directory ---

/**
 * Create the report directory for a run.
 * Call this early — before scoring — so the report dir is available
 * for writing raw data that judges can read.
 */
export function initReport(timestamp: string, configDir: string): { reportId: string; reportDir: string } {
  const reportId = generateReportId(timestamp);
  const reportDir = path.join(configDir, REPORTS_DIR, reportId);
  fs.mkdirSync(reportDir, { recursive: true });
  return { reportId, reportDir };
}

// --- Phase 2: Write raw data (before scoring judges run) ---

/**
 * Write raw run data for a single scenario×agent to the report directory.
 * Call this after building the sparse index but before running LLM judges,
 * so judges can read these files for context.
 *
 * Writes:
 *   - `{agent}.raw.ndjson` — raw agent stdout lines (if available)
 *   - `{agent}.sparse-index.txt` — human-readable sparse index (always)
 */
export function writeScenarioRawData(
  reportDir: string,
  result: RunResult | ScoredRunResult,
  sparseIndex?: SparseIndex,
): void {
  const ref = runRefOf(result);

  // Write raw NDJSON (if available)
  const rawOutput = result.output.rawOutput;
  if (rawOutput?.length) {
    const rawPath = path.join(reportDir, runSiblingPath(ref, "raw.ndjson"));
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, rawOutput.join("\n") + "\n");
  }

  // Write sparse index (always, when available)
  if (sparseIndex) {
    const indexPath = path.join(reportDir, runSiblingPath(ref, "sparse-index.txt"));
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const runLabel = result.runCount && result.runCount > 1 ? ` run ${result.runIndex}/${result.runCount}` : "";
    const header = [
      `# Sparse Index: ${result.scenarioKey} / ${result.agentName}${runLabel}`,
      `# ${sparseIndex.stats.totalInteractions} interactions | ` +
        `env: ${sparseIndex.stats.byCategory.environment} | ` +
        `svc: ${sparseIndex.stats.byCategory.service} | ` +
        `agent: ${sparseIndex.stats.byCategory.agent} | ` +
        `errors: ${sparseIndex.stats.totalErrors}`,
      "",
    ];
    fs.writeFileSync(indexPath, header.join("\n") + sparseIndex.lines.join("\n") + "\n");
  }
}

// --- Phase 3: Finalize report (after scoring completes) ---

/**
 * Finalize a report: write per-run result JSON, the manifest, and the HTML.
 * Call this after all scoring is complete.
 *
 * Results arrive one per run. They are grouped back into scenario/agent pairs
 * so the manifest carries one entry per pair regardless of the repeat count:
 * every existing consumer (baselines, `--failed`, the CLI tables, the HTML
 * report) keeps seeing one row per pair, and multi-run detail is additive.
 */
export function finalizeReport(
  reportDir: string,
  output: ScoredOutput | RunOutput,
  name?: string,
  profile?: string,
): void {
  const reportId = path.basename(reportDir);
  const entries: ReportResultEntry[] = [];

  for (const runs of groupRunsByPair(output.results).values()) {
    for (const result of runs) {
      const absPath = path.join(reportDir, resultPath(runRefOf(result)));
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, JSON.stringify(stripHeavyFields(result), null, 2));
    }
    entries.push(buildPairEntry(runs));
  }

  const manifest: ReportManifest = {
    version: output.version,
    reportId,
    ...(name ? { name } : {}),
    ...(profile ? { profile } : {}),
    timestamp: output.timestamp,
    durationMs: output.durationMs,
    summary: output.summary,
    results: entries,
    ...(output.loadFailures?.length ? { loadFailures: output.loadFailures } : {}),
  };

  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(manifest, null, 2));

  try {
    fs.writeFileSync(path.join(reportDir, "report.html"), generateReportHtml(manifest));
  } catch {
    /* HTML generation is optional — template may not be built yet */
  }
}

// --- Convenience wrapper (backward compat) ---

/**
 * Write a run's output to the persistent report store in a single call.
 * Combines initReport + writeScenarioRawData + finalizeReport.
 * Returns the reportId.
 */
export function writeReportToStore(output: ScoredOutput | RunOutput, configDir: string, name?: string): string {
  const { reportId, reportDir } = initReport(output.timestamp, configDir);

  // Write raw data for each result
  for (const result of output.results) {
    const sparseIndex = isScoredResult(result) ? result.score.sparseIndex : undefined;
    writeScenarioRawData(reportDir, result, sparseIndex);
  }

  // Finalize with scored results, manifest, and HTML
  finalizeReport(reportDir, output, name);

  return reportId;
}

/**
 * Drop the payloads that are persisted elsewhere, so a result file doesn't
 * carry the same bytes twice: `rawOutput` and the sparse index go to sibling
 * files in phase 2, and artifacts are embedded in the manifest entry as well
 * as copied to disk.
 */
function stripHeavyFields(result: RunResult | ScoredRunResult): RunResult | ScoredRunResult {
  const { rawOutput: _rawOutput, ...outputWithoutRaw } = result.output;
  const { artifacts: _artifacts, ...resultWithoutArtifacts } = result;

  let resultToWrite: typeof result = {
    ...(resultWithoutArtifacts as typeof result),
    output: outputWithoutRaw,
  };
  if (isScoredResult(result) && result.score.sparseIndex) {
    const { sparseIndex: _sparseIndex, ...scoreWithoutIndex } = result.score;
    resultToWrite = { ...resultToWrite, score: scoreWithoutIndex } as typeof result;
  }
  return resultToWrite;
}

/**
 * Build the single manifest entry describing one scenario/agent pair.
 *
 * A pair that ran once produces exactly the entry it always did. A pair that
 * ran several times headlines its representative run (see
 * `scoring/aggregate.ts` for how that run is chosen) and appends the spread,
 * the reliability fraction, and a per-run summary list.
 */
function buildPairEntry(runs: Array<RunResult | ScoredRunResult>): ReportResultEntry {
  if (runs.length === 1) {
    return buildResultEntry(runs[0], resultPath(runRefOf(runs[0])));
  }

  const scoredRuns = runs.filter((r): r is ScoredRunResult => isScoredResult(r));
  // With `--no-score` there is nothing to select a representative on, so fall
  // back to the first run that produced usable output.
  const aggregate =
    scoredRuns.length === runs.length
      ? aggregatePair(scoredRuns)
      : {
          representative: runs.find((r) => !isFailedRun(r.output)),
          spread: undefined,
          reliability: {
            succeeded: runs.filter((r) => !isFailedRun(r.output)).length,
            total: runs.length,
            withheld: 0,
          },
        };

  const representative = aggregate.representative ?? runs[0];
  const entry = buildResultEntry(representative, resultPath(runRefOf(representative)));

  entry.runCount = representative.runCount ?? runs.length;
  entry.reliability = aggregate.reliability;
  if (aggregate.spread) entry.spread = aggregate.spread;
  entry.runs = runs.map((run) => buildRunEntry(run, run === representative));

  return entry;
}

/** One row of a pair's `runs` list. */
function buildRunEntry(run: RunResult | ScoredRunResult, isRepresentative: boolean): ReportRunEntry {
  const scored = isScoredResult(run) ? run : undefined;
  const withheld = scored?.score.withheld === true;

  const entry: ReportRunEntry = {
    runIndex: run.runIndex ?? 1,
    durationMs: run.output.metadata.durationMs,
    exitCode: run.output.metadata.exitCode,
    file: resultPath(runRefOf(run)),
  };

  if (isFailedRun(run.output)) entry.failed = true;
  if (withheld) entry.withheld = true;
  // A withheld score is a zero standing in for "unknown", so omit it rather
  // than publishing a number nobody should read as a grade.
  if (scored && !withheld) {
    entry.axisScore = scored.score.axisScore;
    entry.dimensionScores = {
      goalAchievement: scored.score.goalAchievement.score,
      environment: scored.score.environment.score,
      service: scored.score.service.score,
      agent: scored.score.agent.score,
    };
    // The full score, sparse index included, so the HTML report can switch its
    // breakdown between runs client-side. Without it only the representative
    // could be inspected without reading files off disk, which browsers block
    // when the report is opened over file://.
    entry.score = scored.score;
  }
  if (run.output.metadata.tokenUsage) entry.tokenUsage = run.output.metadata.tokenUsage;
  if (run.output.metadata.totalCostUsd !== undefined) entry.totalCostUsd = run.output.metadata.totalCostUsd;
  if (run.output.metadata.error) entry.error = run.output.metadata.error;
  if (isRepresentative) entry.representative = true;

  return entry;
}

function buildResultEntry(result: RunResult | ScoredRunResult, relPath: string): ReportResultEntry {
  const entry: ReportResultEntry = {
    scenarioKey: result.scenarioKey,
    scenarioName: result.scenarioName,
    agentName: result.agentName,
    durationMs: result.output.metadata.durationMs,
    exitCode: result.output.metadata.exitCode,
    failed: isFailedRun(result.output),
    file: relPath,
  };

  if (result.output.metadata.tokenUsage) {
    entry.tokenUsage = result.output.metadata.tokenUsage;
  }
  if (result.output.metadata.totalCostUsd !== undefined) {
    entry.totalCostUsd = result.output.metadata.totalCostUsd;
  }
  if (result.output.metadata.error) {
    entry.error = result.output.metadata.error;
  }
  if (isScoredResult(result)) {
    entry.score = result.score;
  }

  entry.prompt = result.prompt;
  entry.judge = result.judge;
  entry.agentConfig = result.agentConfig;
  if (result.resolvedConfig) {
    entry.resolvedConfig = result.resolvedConfig;
  }
  if (result.artifacts && result.artifacts.length > 0) {
    entry.artifacts = result.artifacts;
  }
  if (result.setupOutput) {
    entry.setupOutput = result.setupOutput;
  }
  if (result.teardownOutput) {
    entry.teardownOutput = result.teardownOutput;
  }

  return entry;
}

function generateReportId(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** Resolve the reports directory for a given config directory. */
export function getReportsDir(configDir: string): string {
  return path.join(configDir, REPORTS_DIR);
}
