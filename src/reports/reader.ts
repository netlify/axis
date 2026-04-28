import * as fs from "node:fs";
import * as path from "node:path";
import type { ReportManifest } from "../types/report.js";
import type { RunResult } from "../types/output.js";
import type { ScoredRunResult } from "../types/scoring.js";
import { getReportsDir } from "./writer.js";

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

/**
 * Read a full scenario result (with transcript) from a report.
 */
export function readScenarioResult(
  configDir: string,
  reportId: string,
  scenarioKey: string,
  agentName: string,
): ScoredRunResult | RunResult | null {
  const resolvedId = resolveReportId(configDir, reportId);
  if (!resolvedId) return null;

  const reportsRoot = getReportsDir(configDir);
  const filePath = path.join(reportsRoot, resolvedId, "scenarios", scenarioKey, `${agentName}.json`);

  assertPathWithin(filePath, reportsRoot);

  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read all agent results for a scenario within a report.
 */
export function readScenarioResults(
  configDir: string,
  reportId: string,
  scenarioKey: string,
): Array<ScoredRunResult | RunResult> {
  const resolvedId = resolveReportId(configDir, reportId);
  if (!resolvedId) return [];

  const reportsRoot = getReportsDir(configDir);
  const scenarioDir = path.join(reportsRoot, resolvedId, "scenarios", scenarioKey);

  assertPathWithin(scenarioDir, reportsRoot);

  if (!fs.existsSync(scenarioDir)) return [];

  const results: Array<ScoredRunResult | RunResult> = [];
  for (const entry of fs.readdirSync(scenarioDir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(scenarioDir, entry);
    try {
      results.push(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    } catch {
      // Skip corrupted files
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
