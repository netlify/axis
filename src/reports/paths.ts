/**
 * Report-relative paths for a single run's files.
 *
 * Two layouts exist, chosen by the pair's configured run count:
 *
 *   runs === 1 (unchanged from before multi-run support)
 *     scenarios/{key}/{agent}.json
 *     scenarios/{key}/{agent}.raw.ndjson
 *     scenarios/{key}/{agent}/artifacts/...
 *
 *   runs > 1
 *     scenarios/{key}/{agent}/run-{i}/result.json
 *     scenarios/{key}/{agent}/run-{i}/raw.ndjson
 *     scenarios/{key}/{agent}/run-{i}/artifacts/...
 *
 * Keeping the single-run layout byte-identical means reports written before
 * repeats existed stay readable, and no migration is needed. The layout is
 * chosen from `runCount` alone (never from how many runs happen to be present),
 * so the runner can build paths while jobs are still in flight and a `--failed`
 * retry of run 2 lands back in `run-2/` rather than moving.
 *
 * Every function returns a path relative to the report directory using forward
 * slashes; callers pass it through `path.join(reportDir, rel)`, which
 * normalizes separators per platform.
 */

const SCENARIOS = "scenarios";

/** True when a pair's runs live in per-run subdirectories. */
export function isMultiRun(runCount: number | undefined): boolean {
  return (runCount ?? 1) > 1;
}

/** Identifies which run of which pair a set of files belongs to. */
export interface RunRef {
  scenarioKey: string;
  agentName: string;
  /** 1-based. Treated as 1 when omitted. */
  runIndex?: number;
  /** Treated as 1 when omitted, which selects the single-run layout. */
  runCount?: number;
}

/**
 * Shared prefix for one run's files: a file stem in the single-run layout, a
 * directory in the multi-run layout. Not a complete path on its own.
 */
function runPathPrefix(ref: RunRef): string {
  const base = `${SCENARIOS}/${ref.scenarioKey}/${ref.agentName}`;
  return isMultiRun(ref.runCount) ? `${base}/run-${ref.runIndex ?? 1}` : base;
}

/** Directory holding every run of one pair. Also the single-run artifacts parent. */
export function pairDir(scenarioKey: string, agentName: string): string {
  return `${SCENARIOS}/${scenarioKey}/${agentName}`;
}

/** Directory holding all agents' results for one scenario. */
export function scenarioDir(scenarioKey: string): string {
  return `${SCENARIOS}/${scenarioKey}`;
}

/** The run's result JSON: `{agent}.json` or `{agent}/run-{i}/result.json`. */
export function resultPath(ref: RunRef): string {
  const prefix = runPathPrefix(ref);
  return isMultiRun(ref.runCount) ? `${prefix}/result.json` : `${prefix}.json`;
}

/**
 * A file sitting alongside the run's result, named by suffix (`raw.ndjson`,
 * `sparse-index.txt`, `debug.ndjson`, `debug.stderr.log`). Joined with `.` in
 * the single-run layout and `/` in the multi-run one, so single-run names stay
 * `{agent}.raw.ndjson` exactly as before.
 */
export function runSiblingPath(ref: RunRef, suffix: string): string {
  const prefix = runPathPrefix(ref);
  return isMultiRun(ref.runCount) ? `${prefix}/${suffix}` : `${prefix}.${suffix}`;
}

/** Directory artifacts are copied into for this run. */
export function artifactsPath(ref: RunRef): string {
  return `${runPathPrefix(ref)}/artifacts`;
}

/** Matches a per-run directory name, capturing the 1-based index. */
export const RUN_DIR_RE = /^run-(\d+)$/;

/** Parse a `run-{i}` directory name into its index, or null if it isn't one. */
export function parseRunDirName(name: string): number | null {
  const match = RUN_DIR_RE.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}
