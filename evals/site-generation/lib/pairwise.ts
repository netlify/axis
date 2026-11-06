import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineScenario, ReportManifest } from "../../../src/types/index.js";
import { ROOT } from "./compile.js";
import { loadReport, renderTable } from "./metrics.js";

/**
 * Pairwise visual judging, built from two finished reports. The judge runs as
 * the *agent* of an ordinary AXIS scenario: setup copies both saved sites into
 * `left/` and `right/`, and the judge writes `verdict.json`, captured as an
 * artifact. Each pair runs in both orders (`@a-left`, `@b-left`) to cancel out
 * position bias. Nothing in the AXIS flow changes; see pairwise.config.ts.
 */

export const DIMENSIONS = ["typography", "spacing", "composition", "color", "overall", "fit-to-brief"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
type Side = "left" | "right" | "tie";

export interface Treatment {
  /** Report id, `latest`, or report directory. */
  report: string;
  agent: string;
}

/** Parse `reportRef:agentName`. The agent name may itself contain colons, so split on the first one only. */
export function parseTreatment(value: string | undefined, envName: string): Treatment {
  const i = value?.indexOf(":") ?? -1;
  if (!value || i <= 0) {
    throw new Error(`Set ${envName}=<reportId|latest>:<agentName>, e.g. ${envName}=latest:claude-code`);
  }
  return { report: value.slice(0, i), agent: value.slice(i + 1) };
}

function siteDir(reportDir: string, scenarioKey: string, agent: string): string {
  return path.join(reportDir, "scenarios", scenarioKey, agent, "artifacts", "site");
}

/** The brief without the output contract lib/compile.ts appends. */
export function briefOf(prompt: string | undefined): string {
  return (prompt ?? "").split("\n\n---\n")[0].trim();
}

export function pairwisePrompt(brief: string): string {
  const dims = DIMENSIONS.map((d) => `"${d}"`).join(", ");
  return (
    "You are judging two websites built from the same brief. They are in `left/` and `right/` " +
    "(each has an `index.html`). Do not modify them.\n\n" +
    `THE BRIEF:\n${brief}\n\n` +
    'Compare them on each dimension below and pick the better one, or "tie" only if they are genuinely equal:\n' +
    "- typography: type scale, readability, font pairing\n" +
    "- spacing: consistent rhythm, breathing room, alignment\n" +
    "- composition: visual hierarchy, layout, where the eye lands first\n" +
    "- color: cohesive palette that suits the subject, sufficient contrast\n" +
    "- overall: which site a design lead would ship\n" +
    "- fit-to-brief: which better delivers what the brief asked for\n\n" +
    "Read the HTML and CSS. If a headless browser is available, screenshot both at 1280px and 375px wide and judge the renders. " +
    "Judge the sites, not their file names or code style.\n\n" +
    `Write \`verdict.json\` in the current directory with exactly the keys ${dims}. ` +
    'Each value is an object: {"winner": "left" | "right" | "tie", "reason": "<one sentence>"}.'
  );
}

/** One scenario per brief that both treatments have a site for, each with both orderings as variants. */
export function buildPairwiseScenarios(a: Treatment, b: Treatment, root = ROOT): InlineScenario[] {
  const ra = loadReport(a.report, root);
  const rb = loadReport(b.report, root);
  const scenarios: InlineScenario[] = [];

  for (const result of ra.manifest.results) {
    if (result.agentName !== a.agent) continue;
    const key = result.scenarioKey;
    const other = rb.manifest.results.find((r) => r.scenarioKey === key && r.agentName === b.agent);
    const siteA = siteDir(ra.dir, key, a.agent);
    const siteB = other && siteDir(rb.dir, key, b.agent);
    if (!siteB || !fs.existsSync(path.join(siteA, "index.html")) || !fs.existsSync(path.join(siteB, "index.html"))) {
      continue;
    }
    const copy = (from: string, to: string) => ({
      action: "run_script" as const,
      command: `mkdir -p ${to} && cp -R ${shellQuote(from + "/.")} ${to}/`,
    });
    scenarios.push({
      key: `pairwise/${key}`,
      name: `${result.scenarioName}: A=${a.agent} (${ra.manifest.reportId}) vs B=${b.agent} (${rb.manifest.reportId})`,
      prompt: pairwisePrompt(briefOf(result.prompt)),
      // Not scored by AXIS (run with --no-score); the verdict file is the output.
      judge: "Wrote verdict.json",
      artifacts: ["verdict.json"],
      variants: [
        { name: "a-left", setup: [copy(siteA, "left"), copy(siteB, "right")] },
        { name: "b-left", setup: [copy(siteB, "left"), copy(siteA, "right")] },
      ],
    });
  }
  if (scenarios.length === 0) {
    throw new Error(
      `No scenario has a saved site for both A (${a.agent} in ${a.report}) and B (${b.agent} in ${b.report}).`,
    );
  }
  return scenarios;
}

export interface DimensionTally {
  a: number;
  b: number;
  tie: number;
  /** Briefs where both orderings named the same winner (or both tied). Low values mean position bias. */
  consistent: number;
  pairs: number;
}

export interface PairwiseSummary {
  reportId: string;
  dimensions: Record<Dimension, DimensionTally>;
  /** Runs with no readable verdict.json. */
  missing: string[];
}

/** Map each ordering's left/right verdict back to A/B, then pool across briefs. */
export function summarizePairwise(manifest: ReportManifest, reportDir: string): PairwiseSummary {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d) => [d, { a: 0, b: 0, tie: 0, consistent: 0, pairs: 0 }]),
  ) as Record<Dimension, DimensionTally>;
  const missing: string[] = [];
  const byBrief = new Map<string, Partial<Record<"a-left" | "b-left", Record<string, { winner: Side }>>>>();

  for (const result of manifest.results) {
    const [base, variant] = result.scenarioKey.split("@") as [string, "a-left" | "b-left"];
    const file = path.join(reportDir, "scenarios", result.scenarioKey, result.agentName, "artifacts", "verdict.json");
    try {
      const verdict = JSON.parse(fs.readFileSync(file, "utf-8"));
      byBrief.set(base, { ...byBrief.get(base), [variant]: verdict });
    } catch {
      missing.push(result.scenarioKey);
    }
  }

  const toAB = (winner: Side | undefined, aIsLeft: boolean): "a" | "b" | "tie" | undefined => {
    if (winner === "tie") return "tie";
    if (winner !== "left" && winner !== "right") return undefined;
    return (winner === "left") === aIsLeft ? "a" : "b";
  };

  for (const orders of byBrief.values()) {
    for (const d of DIMENSIONS) {
      const first = toAB(orders["a-left"]?.[d]?.winner, true);
      const second = toAB(orders["b-left"]?.[d]?.winner, false);
      for (const outcome of [first, second]) if (outcome) dimensions[d][outcome]++;
      if (first && second) {
        dimensions[d].pairs++;
        if (first === second) dimensions[d].consistent++;
      }
    }
  }
  return { reportId: manifest.reportId, dimensions, missing };
}

/** A's win rate with ties counted as half a win. */
export function winRate(t: DimensionTally): number | undefined {
  const n = t.a + t.b + t.tie;
  return n === 0 ? undefined : (t.a + t.tie / 2) / n;
}

export function formatPairwise(summary: PairwiseSummary, title = ""): string {
  const rows = DIMENSIONS.map((d) => {
    const t = summary.dimensions[d];
    const w = winRate(t);
    return [
      d,
      String(t.a),
      String(t.b),
      String(t.tie),
      w === undefined ? "" : w.toFixed(2),
      t.pairs === 0 ? "" : `${t.consistent}/${t.pairs}`,
    ];
  });
  return (
    (title ? `${title}\n\n` : "") +
    renderTable(["dimension", "A wins", "B wins", "ties", "A win rate", "order-consistent"], rows) +
    (summary.missing.length ? `\nMissing verdicts: ${summary.missing.join(", ")}\n` : "") +
    "\nEach brief is judged twice with sides swapped. Win rate counts ties as half.\n"
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function main(argv: string[]): void {
  const ref = argv.find((a) => !a.startsWith("--")) ?? "latest";
  const { manifest, dir } = loadReport(ref, ROOT, "pairwise");
  const summary = summarizePairwise(manifest, dir);
  const text = formatPairwise(summary, manifest.name ?? `Report ${manifest.reportId}`);
  process.stdout.write(argv.includes("--json") ? JSON.stringify(summary, null, 2) + "\n" : text);
  if (argv.includes("--write")) {
    fs.writeFileSync(path.join(dir, "pairwise.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(dir, "pairwise.md"), `# Pairwise\n\n\`\`\`\n${text}\`\`\`\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
