import * as fs from "node:fs";
import * as path from "node:path";
import type { ReportManifest } from "../types/report.js";
import type { RunResult } from "../types/output.js";
import type { ScoredRunResult } from "../types/scoring.js";
import { getReportsDir } from "./writer.js";
import { pairDir, parseRunDirName, resultPath, scenarioDir as scenarioDirPath } from "./paths.js";

/** Ensure a resolved path stays within the expected root directory. */
function assertPathWithin(filePath: string, rootDir: string): void {
  const normalized = path.resolve(filePath);
  const root = path.resolve(rootDir);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    throw new Error(`Path traversal detected: ${filePath} escapes ${rootDir}`);
  }
}

/**
 * List all reports, sorted newest first.
 */
export function listReports(configDir: string): ReportManifest[] {
  const reportsDir = getReportsDir(configDir);

  if (!fs.existsSync(reportsDir)) return [];

  const entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  const manifests: ReportManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(reportsDir, entry.name, "report.json");
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ReportManifest;
      manifests.push(data);
    } catch {
      // Skip corrupted report files
    }
  }

  // Sort by timestamp descending (newest first)
  manifests.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return manifests;
}

/**
 * Read a single report manifest by ID.
 * Supports "latest" as a special ID.
 */
export function readReport(configDir: string, reportId: string): ReportManifest | null {
  if (reportId === "latest") {
    const reports = listReports(configDir);
    return reports[0] ?? null;
  }

  const manifestPath = path.join(getReportsDir(configDir), reportId, "report.json");
  if (!fs.existsSync(manifestPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ReportManifest;
  } catch {
    return null;
  }
}

/** Parse a result file, returning null when missing or corrupted. */
function readResultFile(filePath: string): ScoredRunResult | RunResult | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Every run file for one scenario/agent pair, ordered by run index.
 *
 * Handles both layouts: the single file a pair that ran once writes, and the
 * `run-{i}/result.json` tree a repeated pair writes. Returns an empty array
 * when the pair isn't in the report.
 */
function listPairRunFiles(reportRoot: string, scenarioKey: string, agentName: string): string[] {
  const single = path.join(reportRoot, resultPath({ scenarioKey, agentName }));
  if (fs.existsSync(single)) return [single];

  const dir = path.join(reportRoot, pairDir(scenarioKey, agentName));
  if (!fs.existsSync(dir)) return [];

  const runs: Array<{ index: number; file: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = parseRunDirName(entry.name);
    if (index === null) continue;
    const file = path.join(dir, entry.name, "result.json");
    if (fs.existsSync(file)) runs.push({ index, file });
  }
  runs.sort((a, b) => a.index - b.index);
  return runs.map((r) => r.file);
}

/**
 * Read a full scenario result (with transcript) from a report.
 *
 * For a repeated pair, `runIndex` selects one run; without it the lowest run
 * index is returned. The pair's representative run is named in the manifest
 * entry's `spread.representativeRunIndex`, so callers that want the run
 * backing the headline score should pass that.
 */
export function readScenarioResult(
  configDir: string,
  reportId: string,
  scenarioKey: string,
  agentName: string,
  runIndex?: number,
): ScoredRunResult | RunResult | null {
  const resolvedId = resolveReportId(configDir, reportId);
  if (!resolvedId) return null;

  const reportsRoot = getReportsDir(configDir);
  const reportRoot = path.join(reportsRoot, resolvedId);

  if (runIndex !== undefined) {
    const filePath = path.join(reportRoot, resultPath({ scenarioKey, agentName, runIndex, runCount: 2 }));
    assertPathWithin(filePath, reportsRoot);
    const direct = readResultFile(filePath);
    if (direct) return direct;
    // A pair configured for repeats but retried alone still writes the single
    // layout, so fall through to the general search rather than reporting a
    // missing run.
  }

  const files = listPairRunFiles(reportRoot, scenarioKey, agentName);
  for (const file of files) assertPathWithin(file, reportsRoot);

  if (runIndex !== undefined) {
    const match = files.find((f) => parseRunDirName(path.basename(path.dirname(f))) === runIndex);
    return match ? readResultFile(match) : null;
  }
  return files.length > 0 ? readResultFile(files[0]) : null;
}

/**
 * Read all results for a scenario within a report: every agent, and every run
 * of each agent when the pair was repeated. Ordered by agent name, then run
 * index.
 */
export function readScenarioResults(
  configDir: string,
  reportId: string,
  scenarioKey: string,
): Array<ScoredRunResult | RunResult> {
  const resolvedId = resolveReportId(configDir, reportId);
  if (!resolvedId) return [];

  const reportsRoot = getReportsDir(configDir);
  const reportRoot = path.join(reportsRoot, resolvedId);
  const dir = path.join(reportRoot, scenarioDirPath(scenarioKey));

  assertPathWithin(dir, reportsRoot);

  if (!fs.existsSync(dir)) return [];

  // Agent names come from both layouts: `{agent}.json` files and `{agent}/`
  // directories. A pair can have both, because artifacts live in the directory
  // even when the pair ran once, so dedupe before reading.
  const agentNames = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      agentNames.add(entry.name.slice(0, -".json".length));
    } else if (entry.isDirectory()) {
      agentNames.add(entry.name);
    }
  }

  const results: Array<ScoredRunResult | RunResult> = [];
  for (const agentName of [...agentNames].sort()) {
    for (const file of listPairRunFiles(reportRoot, scenarioKey, agentName)) {
      assertPathWithin(file, reportsRoot);
      const parsed = readResultFile(file);
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

function resolveReportId(configDir: string, reportId: string): string | null {
  if (reportId === "latest") {
    const reports = listReports(configDir);
    return reports[0]?.reportId ?? null;
  }
  return reportId;
}
