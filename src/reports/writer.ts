import * as fs from "node:fs";
import * as path from "node:path";
import type { RunOutput, RunResult } from "../types/output.js";
import { isScoredResult } from "../types/output.js";
import type { ScoredOutput, ScoredRunResult } from "../types/scoring.js";
import type { ReportManifest, ReportResultEntry } from "../types/report.js";
import { generateReportHtml } from "./html.js";

const REPORTS_DIR = ".axis/reports";

/**
 * Write a run's output to the persistent report store.
 * Returns the reportId (used to recall the report later).
 *
 * Structure:
 *   .axis/reports/{reportId}/report.json
 *   .axis/reports/{reportId}/scenarios/{scenarioKey}/{agentName}.json
 */
export function writeReportToStore(output: ScoredOutput | RunOutput, configDir: string): string {
  const reportId = generateReportId(output.timestamp);
  const reportDir = path.join(configDir, REPORTS_DIR, reportId);

  fs.mkdirSync(reportDir, { recursive: true });

  const entries: ReportResultEntry[] = [];

  for (const result of output.results) {
    const relPath = `scenarios/${result.scenarioKey}/${result.agentName}.json`;
    const absPath = path.join(reportDir, relPath);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    // Strip rawOutput from scenario JSON — written as a separate file
    const { rawOutput, ...outputWithoutRaw } = result.output;

    // Strip sparseIndex from score — written as a separate file in debug mode
    let resultToWrite: typeof result = { ...result, output: outputWithoutRaw };
    if (isScoredResult(result) && result.score.sparseIndex) {
      const { sparseIndex: _sparseIndex, ...scoreWithoutIndex } = result.score;
      resultToWrite = { ...resultToWrite, score: scoreWithoutIndex } as typeof result;
    }

    fs.writeFileSync(absPath, JSON.stringify(resultToWrite, null, 2));

    if (rawOutput?.length) {
      const rawPath = absPath.replace(/\.json$/, ".raw.ndjson");
      fs.writeFileSync(rawPath, rawOutput.join("\n") + "\n");
    }

    // Write sparse index as a human-readable file in debug mode
    if (rawOutput && isScoredResult(result) && result.score.sparseIndex) {
      const indexPath = absPath.replace(/\.json$/, ".sparse-index.txt");
      const { sparseIndex } = result.score;
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

    entries.push(buildResultEntry(result, relPath));
  }

  const manifest: ReportManifest = {
    version: output.version,
    reportId,
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
