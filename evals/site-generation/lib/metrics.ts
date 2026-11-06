import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CriterionGrade, ReportManifest } from "../../../src/types/index.js";
import { ROOT, TAG_RE, type Metric } from "./compile.js";

/** Recall and pass checks count as met at score ≥ 5, so a stray 7 from the judge still reads as a yes. */
const MET_THRESHOLD = 5;
const COUNTS_RE = /supported\s*=\s*(\d+)\s*,?\s*placeholder\s*=\s*(\d+)\s*,?\s*unsupported\s*=\s*(\d+)/i;

/** `check` is the script-check pass rate from lib/checks.mjs; the rest come from the LLM judge. */
export type MetricKind = Metric | "check";
const ROW_ORDER = ["recall", "precision", "f1", "pass", "check"] as const;

export interface Tally {
  hits: number;
  total: number;
  /** Precision audits whose rationale lacked parseable counts; hits/total fell back to score/10. */
  estimated: number;
}

export type VerticalMetrics = Partial<Record<MetricKind, Tally>>;

export interface Summary {
  reportId: string;
  by: "agent" | "scenario";
  /** Group label (agent name or scenario key) → vertical → metrics. */
  groups: Record<string, Record<string, VerticalMetrics>>;
  /** Runs with no goal-achievement grades (agent or judge failed), per group. */
  unscored: Record<string, number>;
}

export interface LoadedReport {
  manifest: ReportManifest;
  dir: string;
}

interface SiteChecks {
  checks: { vertical: string; id: string; hits: number; total: number }[];
}

/** Turn one graded criterion into counts. Untagged criteria (not from lib/compile.ts) return null. */
export function tallyCriterion(grade: CriterionGrade): { vertical: string; metric: Metric; tally: Tally } | null {
  const match = TAG_RE.exec(grade.check);
  if (!match) return null;
  const [, vertical, metric] = match as unknown as [string, string, Metric];

  if (metric !== "precision") {
    return { vertical, metric, tally: { hits: grade.score >= MET_THRESHOLD ? 1 : 0, total: 1, estimated: 0 } };
  }
  const counts = COUNTS_RE.exec(grade.rationale);
  if (!counts) {
    return { vertical, metric, tally: { hits: grade.score / 10, total: 1, estimated: 1 } };
  }
  const supported = Number(counts[1]);
  const unsupported = Number(counts[3]);
  return { vertical, metric, tally: { hits: supported, total: supported + unsupported, estimated: 0 } };
}

/**
 * Pool counts per group × vertical × metric (micro-average), so running a
 * scenario several times, or across several scenarios, just adds to the
 * tallies. With `reportDir`, script checks captured as `site-checks.json`
 * artifacts are pooled in as the `check` metric.
 */
export function summarize(manifest: ReportManifest, by: "agent" | "scenario", reportDir?: string): Summary {
  const summary: Summary = { reportId: manifest.reportId, by, groups: {}, unscored: {} };
  const add = (group: string, vertical: string, metric: MetricKind, t: Tally) => {
    const metrics = (summary.groups[group][vertical] ??= {});
    const tally = (metrics[metric] ??= { hits: 0, total: 0, estimated: 0 });
    tally.hits += t.hits;
    tally.total += t.total;
    tally.estimated += t.estimated;
  };

  for (const result of manifest.results) {
    const group = by === "agent" ? result.agentName : result.scenarioKey;
    summary.groups[group] ??= {};

    const criteria = result.score?.goalAchievement?.criteria;
    if (criteria?.length) {
      for (const grade of criteria) {
        const parsed = tallyCriterion(grade);
        if (parsed) add(group, parsed.vertical, parsed.metric, parsed.tally);
      }
    } else {
      summary.unscored[group] = (summary.unscored[group] ?? 0) + 1;
    }

    const checks = reportDir && readSiteChecks(reportDir, result.scenarioKey, result.agentName);
    for (const c of checks ? checks.checks : []) {
      // A check with nothing to inspect (no images, no scripts) isn't evidence either way.
      if (c.total > 0) add(group, c.vertical, "check", { hits: c.hits, total: c.total, estimated: 0 });
    }
  }
  return summary;
}

export function readSiteChecks(reportDir: string, scenarioKey: string, agentName: string): SiteChecks | undefined {
  const file = path.join(reportDir, "scenarios", scenarioKey, agentName, "artifacts", "site-checks.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as SiteChecks) : undefined;
}

export function rate(tally: Tally | undefined): number | undefined {
  if (!tally) return undefined;
  // An audit that found nothing to label has nothing unsupported: precision 1.
  return tally.total === 0 ? 1 : tally.hits / tally.total;
}

export function f1(metrics: VerticalMetrics): number | undefined {
  const p = rate(metrics.precision);
  const r = rate(metrics.recall);
  if (p === undefined || r === undefined) return undefined;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function value(metrics: VerticalMetrics | undefined, kind: (typeof ROW_ORDER)[number]): number | undefined {
  if (!metrics) return undefined;
  return kind === "f1" ? f1(metrics) : rate(metrics[kind]);
}

export function formatTable(summary: Summary): string {
  const groups = Object.keys(summary.groups).sort();
  const verticals = [...new Set(groups.flatMap((g) => Object.keys(summary.groups[g])))].sort();
  const body: string[][] = [];

  for (const vertical of verticals) {
    for (const kind of ROW_ORDER) {
      const cells = groups.map((g) => {
        const m = summary.groups[g][vertical];
        if (kind === "f1") return fmt(value(m, kind));
        const tally = m?.[kind];
        if (!tally) return "";
        const approx = tally.estimated > 0 ? "~" : "";
        return `${approx}${fmt(rate(tally))} (${round(tally.hits)}/${tally.total})`;
      });
      if (cells.some((c) => c !== "")) body.push([`${vertical} ${kind}`, ...cells]);
    }
  }
  body.push(["unscored runs", ...groups.map((g) => String(summary.unscored[g] ?? 0))]);

  return (
    renderTable(["", ...groups], body) +
    "\npass = LLM judge PASS/FAIL · check = script checks (lib/checks.mjs)" +
    "\n~ = includes precision audits without parseable counts (estimated from the 0–10 score)\n"
  );
}

export interface Regression {
  group: string;
  vertical: string;
  kind: string;
  baseline: number;
  current: number;
}

/** Per-vertical deltas against a saved baseline. A drop larger than `threshold` is a regression. */
export function compareSummaries(current: Summary, baseline: Summary, threshold: number) {
  const rows: string[][] = [];
  const regressions: Regression[] = [];
  for (const group of Object.keys(current.groups).sort()) {
    const verticals = Object.keys(current.groups[group]).sort();
    for (const vertical of verticals) {
      for (const kind of ROW_ORDER) {
        const now = value(current.groups[group][vertical], kind);
        const then = value(baseline.groups[group]?.[vertical], kind);
        if (now === undefined || then === undefined) continue;
        const delta = now - then;
        const flag = delta < -threshold ? "REGRESSED" : delta > threshold ? "improved" : "";
        if (flag === "REGRESSED") regressions.push({ group, vertical, kind, baseline: then, current: now });
        rows.push([group, `${vertical} ${kind}`, fmt(then), fmt(now), signed(delta), flag]);
      }
    }
  }
  return { table: renderTable(["group", "metric", "baseline", "current", "delta", ""], rows), regressions };
}

/** Pairwise runs (pairwise.config.ts) share the reports dir; `latest` picks the newest report of the requested kind. */
export function isPairwiseReport(manifest: ReportManifest): boolean {
  return manifest.results.length > 0 && manifest.results.every((r) => r.scenarioKey.startsWith("pairwise/"));
}

/** Accepts a report id, `latest`, or a path to a report directory (what afterAll passes as $AXIS_REPORT_DIR). */
export function loadReport(ref: string, root = ROOT, kind: "eval" | "pairwise" = "eval"): LoadedReport {
  let dir: string;
  if (fs.existsSync(path.join(ref, "report.json"))) {
    dir = path.resolve(ref);
  } else {
    const reportsDir = path.join(root, ".axis", "reports");
    if (ref !== "latest") {
      dir = path.join(reportsDir, ref);
    } else {
      const ids = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).sort().reverse() : [];
      const match = ids.find((id) => {
        const file = path.join(reportsDir, id, "report.json");
        return fs.existsSync(file) && isPairwiseReport(readManifest(file)) === (kind === "pairwise");
      });
      if (!match) throw new Error(`No ${kind} reports in ${reportsDir}. Run the evals first.`);
      dir = path.join(reportsDir, match);
    }
  }
  return { manifest: readManifest(path.join(dir, "report.json")), dir };
}

function readManifest(file: string): ReportManifest {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as ReportManifest;
}

export function renderTable(header: string[], body: string[][]): string {
  const table = [header, ...body];
  const widths = header.map((_, i) => Math.max(...table.map((r) => (r[i] ?? "").length)));
  const lines = table.map((r) =>
    r
      .map((c, i) => (c ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd(),
  );
  lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return lines.join("\n") + "\n";
}

function fmt(n: number | undefined): string {
  return n === undefined ? "" : n.toFixed(2);
}

function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): number {
  const valueFlags = ["--save-baseline", "--compare", "--threshold"];
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1]));
  const by = argv.includes("--by-scenario") ? "scenario" : "agent";
  const { manifest, dir } = loadReport(positional[0] ?? "latest");
  const summary = summarize(manifest, by, dir);
  const table = formatTable(summary);

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(`Report ${manifest.reportId}, by ${by}\n\n${table}`);
  }

  // --write: drop metrics next to the report (used by afterAll in axis.config.ts).
  if (argv.includes("--write")) {
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(dir, "metrics.md"),
      `# Metrics: ${manifest.reportId} (by ${by})\n\n\`\`\`\n${table}\`\`\`\n`,
    );
  }

  const baselinesDir = path.join(ROOT, "baselines");
  const save = flag(argv, "--save-baseline");
  if (save) {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.writeFileSync(path.join(baselinesDir, `${save}.json`), JSON.stringify(summary, null, 2) + "\n");
    process.stdout.write(`\nSaved baseline "${save}" from report ${manifest.reportId}\n`);
  }

  const compare = flag(argv, "--compare");
  if (compare) {
    const baseline = JSON.parse(fs.readFileSync(path.join(baselinesDir, `${compare}.json`), "utf-8")) as Summary;
    if (baseline.by !== by) throw new Error(`Baseline "${compare}" is grouped by ${baseline.by}; pass matching flags.`);
    const threshold = Number(flag(argv, "--threshold") ?? 0.05);
    const { table: diff, regressions } = compareSummaries(summary, baseline, threshold);
    process.stdout.write(
      `\nAgainst baseline "${compare}" (report ${baseline.reportId}), threshold ${threshold}\n\n${diff}`,
    );
    process.stdout.write(`\n${regressions.length} regression(s)\n`);
    return regressions.length > 0 ? 1 : 0;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
