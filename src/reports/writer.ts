import * as fs from "node:fs";
import * as path from "node:path";
import type { RunOutput, RunResult } from "../types/output.js";
import { isScoredResult } from "../types/output.js";
import type { ScoredOutput, ScoredRunResult, SparseIndex } from "../types/scoring.js";
import type { ReportManifest, ReportResultEntry } from "../types/report.js";
import { generateReportHtml } from "./html.js";

const REPORTS_DIR = ".axis/reports";

// --- Phase 1: Create report directory ---

/**
 * Create the report directory for a run.
 * Call this early — before scoring — so the report dir is available
 * for writing raw data that judges can read.
 */
export function initReport(
  timestamp: string,
  configDir: string,
): { reportId: string; reportDir: string } {
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
  const scenarioDir = path.join(reportDir, "scenarios", result.scenarioKey);
  fs.mkdirSync(scenarioDir, { recursive: true });

  const baseName = result.agentName;

  // Write raw NDJSON (if available)
  const rawOutput = result.output.rawOutput;
  if (rawOutput?.length) {
    const rawPath = path.join(scenarioDir, `${baseName}.raw.ndjson`);
    fs.writeFileSync(rawPath, rawOutput.join("\n") + "\n");
  }

  // Write sparse index (always, when available)
  if (sparseIndex) {
    const indexPath = path.join(scenarioDir, `${baseName}.sparse-index.txt`);
    const header = [
      `# Sparse Index: ${result.scenarioKey} / ${result.agentName}`,
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
 * Finalize a report: write scored scenario JSON, manifest, and HTML.
 * Call this after all scoring is complete.
 */
export function finalizeReport(reportDir: string, output: ScoredOutput | RunOutput, name?: string): void {
  const reportId = path.basename(reportDir);
  const entries: ReportResultEntry[] = [];

  for (const result of output.results) {
    const relPath = `scenarios/${result.scenarioKey}/${result.agentName}.json`;
    const absPath = path.join(reportDir, relPath);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    // Strip rawOutput from scenario JSON — written separately in phase 2
    const { rawOutput: _rawOutput, ...outputWithoutRaw } = result.output;

    // Strip sparseIndex from score — written separately in phase 2
    let resultToWrite: typeof result = { ...result, output: outputWithoutRaw };
    if (isScoredResult(result) && result.score.sparseIndex) {
      const { sparseIndex: _sparseIndex, ...scoreWithoutIndex } = result.score;
      resultToWrite = { ...resultToWrite, score: scoreWithoutIndex } as typeof result;
    }

    fs.writeFileSync(absPath, JSON.stringify(resultToWrite, null, 2));
    entries.push(buildResultEntry(result, relPath));
  }

  const manifest: ReportManifest = {
    version: output.version,
    reportId,
    ...(name ? { name } : {}),
    timestamp: output.timestamp,
    durationMs: output.durationMs,
    summary: output.summary,
    results: entries,
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

function buildResultEntry(result: RunResult | ScoredRunResult, relPath: string): ReportResultEntry {
  const entry: ReportResultEntry = {
    scenarioKey: result.scenarioKey,
    scenarioName: result.scenarioName,
    agentName: result.agentName,
    durationMs: result.output.metadata.durationMs,
    exitCode: result.output.metadata.exitCode,
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
  entry.rubric = result.rubric;
  entry.agentConfig = result.agentConfig;
  if (result.resolvedConfig) {
    entry.resolvedConfig = result.resolvedConfig;
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
