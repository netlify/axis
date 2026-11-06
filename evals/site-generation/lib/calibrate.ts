import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, TAG_RE } from "./compile.js";
import { flag, loadReport, renderTable, tallyCriterion } from "./metrics.js";

/**
 * Judge calibration against human labels.
 *
 *   template <report> [--sample N]   write golden/<reportId>.json for people to fill in
 *   score <golden file>             compare the judge's calls to the human labels
 *
 * The template copies each labelled site into golden/<reportId>/sites/ so the
 * golden set outlives `.axis/`, and leaves out the judge's verdicts so labellers
 * aren't anchored by them.
 */

export interface GoldenLabel {
  scenario: string;
  agent: string;
  check: string;
  /** Relative to the golden file. Open `index.html` to label. */
  site: string;
  /** Recall/pass checks: true = met. Precision audits: counts of what the human found. */
  human: boolean | { supported: number | null; unsupported: number | null } | null;
  note?: string;
}

export interface GoldenFile {
  report: string;
  instructions: string;
  labels: GoldenLabel[];
}

const INSTRUCTIONS =
  "For each label, open the site and decide the check yourself before looking at any AXIS report. " +
  "Recall/pass checks: set human to true (met) or false (not met). " +
  'Precision audits: set human to {"supported": N, "unsupported": N} using the audit\'s own definitions; placeholders are not counted. ' +
  "Leave human as null to skip a label. Use note for anything ambiguous.";

export function buildTemplate(reportRef: string, sample?: number, root = ROOT): GoldenFile {
  const { manifest, dir } = loadReport(reportRef, root);
  const goldenDir = path.join(root, "golden");
  const sitesDir = path.join(goldenDir, manifest.reportId, "sites");
  let labels: GoldenLabel[] = [];

  for (const result of manifest.results) {
    const criteria = result.score?.goalAchievement?.criteria;
    const site = path.join(dir, "scenarios", result.scenarioKey, result.agentName, "artifacts", "site");
    if (!criteria?.length || !fs.existsSync(site)) continue;
    const dest = path.join(sitesDir, result.scenarioKey, result.agentName);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(site, dest, { recursive: true });
    for (const c of criteria) {
      if (!TAG_RE.test(c.check)) continue;
      const isAudit = c.check.includes(":precision]");
      labels.push({
        scenario: result.scenarioKey,
        agent: result.agentName,
        check: c.check,
        site: path.relative(goldenDir, dest),
        human: isAudit ? { supported: null, unsupported: null } : null,
      });
    }
  }
  if (sample !== undefined && sample < labels.length) labels = seededSample(labels, sample, manifest.reportId);
  return { report: manifest.reportId, instructions: INSTRUCTIONS, labels };
}

export interface Agreement {
  n: number;
  /** Share of labels where judge and human agree. */
  accuracy: number;
  /** Of the checks the judge called met, the share humans agree were met. */
  precision?: number;
  /** Of the checks humans called met, the share the judge also called met. */
  recall?: number;
  /** Agreement corrected for chance. ~0 = no better than chance, 1 = perfect. */
  kappa?: number;
}

export interface Calibration {
  report: string;
  /** Recall/pass checks, per vertical plus `all`. */
  binary: Record<string, Agreement>;
  /** Precision audits: mean absolute gap between judge and human precision, per vertical plus `all`. */
  audits: Record<string, { n: number; mae: number }>;
  unmatched: number;
}

export function agreement(pairs: { judge: boolean; human: boolean }[]): Agreement {
  const n = pairs.length;
  const tp = pairs.filter((p) => p.judge && p.human).length;
  const fp = pairs.filter((p) => p.judge && !p.human).length;
  const fn = pairs.filter((p) => !p.judge && p.human).length;
  const tn = n - tp - fp - fn;
  const po = (tp + tn) / n;
  const pe = ((tp + fp) / n) * ((tp + fn) / n) + ((fn + tn) / n) * ((fp + tn) / n);
  return {
    n,
    accuracy: po,
    ...(tp + fp > 0 ? { precision: tp / (tp + fp) } : {}),
    ...(tp + fn > 0 ? { recall: tp / (tp + fn) } : {}),
    ...(pe < 1 ? { kappa: (po - pe) / (1 - pe) } : {}),
  };
}

export function scoreGolden(golden: GoldenFile, root = ROOT): Calibration {
  const { manifest } = loadReport(golden.report, root);
  const binary = new Map<string, { judge: boolean; human: boolean }[]>();
  const audits = new Map<string, number[]>();
  let unmatched = 0;

  for (const label of golden.labels) {
    if (label.human === null) continue;
    const grade = manifest.results
      .find((r) => r.scenarioKey === label.scenario && r.agentName === label.agent)
      ?.score?.goalAchievement?.criteria.find((c) => c.check === label.check);
    const parsed = grade && tallyCriterion(grade);
    if (!parsed) {
      unmatched++;
      continue;
    }
    for (const key of [parsed.vertical, "all"]) {
      if (typeof label.human === "boolean") {
        binary.set(key, [...(binary.get(key) ?? []), { judge: parsed.tally.hits === 1, human: label.human }]);
      } else if (label.human.supported !== null && label.human.unsupported !== null) {
        const humanTotal = label.human.supported + label.human.unsupported;
        const humanP = humanTotal === 0 ? 1 : label.human.supported / humanTotal;
        const judgeP = parsed.tally.total === 0 ? 1 : parsed.tally.hits / parsed.tally.total;
        audits.set(key, [...(audits.get(key) ?? []), Math.abs(judgeP - humanP)]);
      }
    }
  }

  return {
    report: golden.report,
    binary: Object.fromEntries([...binary].map(([k, pairs]) => [k, agreement(pairs)])),
    audits: Object.fromEntries(
      [...audits].map(([k, gaps]) => [k, { n: gaps.length, mae: gaps.reduce((a, b) => a + b, 0) / gaps.length }]),
    ),
    unmatched,
  };
}

export function formatCalibration(c: Calibration): string {
  const f = (n: number | undefined) => (n === undefined ? "" : n.toFixed(2));
  const sortAllLast = (keys: string[]) =>
    keys.sort((a, b) => (a === "all" ? 1 : b === "all" ? -1 : a.localeCompare(b)));
  const binaryRows = sortAllLast(Object.keys(c.binary)).map((k) => {
    const a = c.binary[k];
    return [k, String(a.n), f(a.accuracy), f(a.precision), f(a.recall), f(a.kappa)];
  });
  const auditRows = sortAllLast(Object.keys(c.audits)).map((k) => [k, String(c.audits[k].n), f(c.audits[k].mae)]);
  return (
    `Judge vs human labels, report ${c.report}\n\n` +
    renderTable(["vertical", "n", "accuracy", "precision", "recall", "kappa"], binaryRows) +
    (auditRows.length ? "\nPrecision audits\n\n" + renderTable(["vertical", "n", "mean abs gap"], auditRows) : "") +
    (c.unmatched ? `\n${c.unmatched} label(s) didn't match a graded check in the report\n` : "")
  );
}

/** Deterministic sample so re-running `template` gives labellers the same set. */
function seededSample<T>(items: T[], n: number, seed: string): T[] {
  let h = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rand = () => (h = (h * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function main(argv: string[]): void {
  const [command, target] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--sample");
  if (command === "template") {
    const sample = flag(argv, "--sample");
    const golden = buildTemplate(target ?? "latest", sample === undefined ? undefined : Number(sample));
    const out = path.join(ROOT, "golden", `${golden.report}.json`);
    if (fs.existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite human labels.`);
    fs.writeFileSync(out, JSON.stringify(golden, null, 2) + "\n");
    process.stdout.write(`Wrote ${golden.labels.length} labels to ${path.relative(process.cwd(), out)}\n`);
  } else if (command === "score" && target) {
    const golden = JSON.parse(fs.readFileSync(target, "utf-8")) as GoldenFile;
    const calibration = scoreGolden(golden);
    process.stdout.write(
      argv.includes("--json") ? JSON.stringify(calibration, null, 2) + "\n" : formatCalibration(calibration),
    );
  } else {
    process.stderr.write(
      "Usage: calibrate.ts template <report|latest> [--sample N]\n       calibrate.ts score <golden file>\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
