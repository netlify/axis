import * as fs from "node:fs";
import * as path from "node:path";
import type { Baseline, BaselineEntry } from "../types/baseline.js";
import type { ReportManifest } from "../types/report.js";

const BASELINE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

/** Default baseline name used when no name is specified. */
export const DEFAULT_BASELINE_NAME = "default";

export function validateBaselineName(name: string): void {
  if (!name || name.length > MAX_NAME_LENGTH || !BASELINE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid baseline name "${name}". ` +
        `Names must be 1-${MAX_NAME_LENGTH} characters using only letters, numbers, hyphens, and underscores.`,
    );
  }
}

function baselinesDir(configDir: string): string {
  return path.join(configDir, ".axis", "baselines");
}

function baselinePath(configDir: string, name: string): string {
  return path.join(baselinesDir(configDir), `${name}.json`);
}

/**
 * Set (create or merge) a baseline from a report manifest.
 * Only scored, non-failed results are included.
 * Existing entries for scenarios not in this report are preserved.
 * If `name` is omitted, uses the default baseline.
 */
export function setBaseline(configDir: string, report: ReportManifest, name: string = DEFAULT_BASELINE_NAME): Baseline {
  validateBaselineName(name);

  const now = new Date().toISOString();
  const existing = readBaseline(configDir, name);
  const baseline: Baseline = existing ?? {
    name,
    createdAt: now,
    updatedAt: now,
    results: {},
  };

  let merged = 0;

  for (const result of report.results) {
    // Skip unscored or failed results
    if (!result.score || result.error) continue;

    const entry: BaselineEntry = {
      axisScore: result.score.axisScore,
      goalAchievement: result.score.goalAchievement.score,
      environment: result.score.environment.score,
      service: result.score.service.score,
      agent: result.score.agent.score,
      durationMs: result.durationMs,
      tokens:
        (result.tokenUsage?.input ?? 0) + (result.tokenUsage?.output ?? 0) + (result.tokenUsage?.cacheReadInput ?? 0),
      fromReportId: report.reportId,
      timestamp: report.timestamp,
    };

    if (!baseline.results[result.scenarioKey]) {
      baseline.results[result.scenarioKey] = {};
    }
    baseline.results[result.scenarioKey][result.agentName] = entry;
    merged++;
  }

  // Only write if we actually merged results (or created a new baseline)
  if (merged > 0 || !existing) {
    baseline.updatedAt = now;
    const dir = baselinesDir(configDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = baselinePath(configDir, name);
    fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2) + "\n");
  }

  return baseline;
}

/** Read a baseline by name. Returns null if not found. Defaults to the default baseline. */
export function readBaseline(configDir: string, name: string = DEFAULT_BASELINE_NAME): Baseline | null {
  validateBaselineName(name);

  const filePath = baselinePath(configDir, name);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Baseline;
  return data;
}

/** List all baselines, sorted by updatedAt (newest first). */
export function listBaselines(configDir: string): Baseline[] {
  const dir = baselinesDir(configDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const baselines: Baseline[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as Baseline;
      baselines.push(data);
    } catch {
      // Skip corrupted files
    }
  }

  baselines.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return baselines;
}

/** Delete a baseline. Returns true if it existed. Defaults to the default baseline. */
export function deleteBaseline(configDir: string, name: string = DEFAULT_BASELINE_NAME): boolean {
  validateBaselineName(name);

  const filePath = baselinePath(configDir, name);
  if (!fs.existsSync(filePath)) return false;

  fs.unlinkSync(filePath);
  return true;
}
