import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ReportManifest } from "../../../src/types/index.js";
import { compareSummaries, loadReport, summarize, type Summary } from "../lib/metrics.js";
import { buildPairwiseScenarios, parseTreatment, summarizePairwise, winRate } from "../lib/pairwise.js";
import { agreement, buildTemplate, scoreGolden, type GoldenFile } from "../lib/calibrate.js";

const CHECKS = path.resolve(import.meta.dirname, "../lib/checks.mjs");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "site-gen-evals-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A report dir with one result per [scenarioKey, agent, criteria] and a site artifact for each. */
function makeReport(id: string, results: [string, string, { check: string; score: number; rationale?: string }[]][]) {
  const dir = path.join(root, ".axis", "reports", id);
  const manifest = {
    reportId: id,
    results: results.map(([scenarioKey, agentName, criteria]) => ({
      scenarioKey,
      scenarioName: scenarioKey,
      agentName,
      prompt: `Brief for ${scenarioKey}\n\n---\nBuild the site in ./site/`,
      score: { goalAchievement: { score: 0, criteria: criteria.map((c) => ({ weight: 1, rationale: "", ...c })) } },
    })),
  };
  write(path.join(dir, "report.json"), JSON.stringify(manifest));
  for (const [key, agent] of results) {
    write(path.join(dir, "scenarios", key, agent, "artifacts", "site", "index.html"), `<h1>${agent}</h1>`);
  }
  return dir;
}

describe("checks.mjs", () => {
  it("counts broken refs, unparseable scripts, missing alt, and failing declared contrast", () => {
    const site = path.join(root, "site");
    write(
      path.join(site, "index.html"),
      `<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
       <style>.btn{color:#999;background:#fff} body{color:#111;background:#fff}</style></head>
       <body><header></header><nav><a href="#ok">a</a><a href="#nope">b</a></nav><main><h1 id="ok">x</h1>
       <img src="a.svg" alt="A"><img src="missing.png"></main><footer></footer>
       <script src="app.js"></script></body></html>`,
    );
    write(path.join(site, "a.svg"), "<svg/>");
    write(path.join(site, "app.js"), "function (");
    const out = path.join(root, "site-checks.json");
    execFileSync("node", [CHECKS, site, out]);

    const byId = Object.fromEntries(
      (JSON.parse(fs.readFileSync(out, "utf-8")).checks as { id: string; hits: number; total: number }[]).map((c) => [
        c.id,
        `${c.hits}/${c.total}`,
      ]),
    );
    expect(byId).toMatchObject({
      "index-exists": "1/1",
      "local-refs-resolve": "3/5",
      "scripts-parse": "0/1",
      "viewport-meta": "1/1",
      "html-lang": "1/1",
      "single-h1": "1/1",
      "has-landmarks": "1/1",
      "img-alt": "1/2",
      "declared-contrast-aa": "1/2",
    });
  });
});

describe("metrics add-ons", () => {
  it("pools script checks from site-checks.json artifacts as the `check` metric", () => {
    const dir = makeReport("r1", [["s", "a", [{ check: "[mobile:pass] x", score: 10 }]]]);
    write(
      path.join(dir, "scenarios", "s", "a", "artifacts", "site-checks.json"),
      JSON.stringify({ checks: [{ vertical: "mobile", id: "viewport-meta", hits: 1, total: 2 }] }),
    );
    const { manifest } = loadReport("r1", root);
    expect(summarize(manifest, "agent", dir).groups.a.mobile).toEqual({
      pass: { hits: 1, total: 1, estimated: 0 },
      check: { hits: 1, total: 2, estimated: 0 },
    });
  });

  it("flags per-vertical drops beyond the threshold against a baseline", () => {
    const tally = (hits: number, total: number) => ({ hits, total, estimated: 0 });
    const baseline: Summary = {
      reportId: "b",
      by: "agent",
      unscored: {},
      groups: { a: { content: { recall: tally(9, 10) } } },
    };
    const current: Summary = { ...baseline, reportId: "c", groups: { a: { content: { recall: tally(7, 10) } } } };
    const { regressions } = compareSummaries(current, baseline, 0.05);
    expect(regressions).toEqual([{ group: "a", vertical: "content", kind: "recall", baseline: 0.9, current: 0.7 }]);
    expect(compareSummaries(current, baseline, 0.25).regressions).toEqual([]);
  });

  it("`latest` skips pairwise reports when loading eval reports, and vice versa", () => {
    makeReport("2026-01-01", [["s", "a", []]]);
    makeReport("2026-01-02", [["pairwise/s@a-left", "judge", []]]);
    expect(loadReport("latest", root).manifest.reportId).toBe("2026-01-01");
    expect(loadReport("latest", root, "pairwise").manifest.reportId).toBe("2026-01-02");
  });
});

describe("pairwise", () => {
  it("parses treatments, splitting on the first colon only", () => {
    expect(parseTreatment("latest:claude-code|opus:x", "A")).toEqual({ report: "latest", agent: "claude-code|opus:x" });
    expect(() => parseTreatment(undefined, "PAIRWISE_A")).toThrow(/PAIRWISE_A=/);
  });

  it("builds one scenario per shared brief, with both orderings as variants", () => {
    makeReport("r1", [
      ["table-stakes/bakery", "claude-code", []],
      ["table-stakes/bakery", "codex", []],
      ["hard-input/vague", "claude-code", []],
    ]);
    const scenarios = buildPairwiseScenarios(
      { report: "r1", agent: "claude-code" },
      { report: "r1", agent: "codex" },
      root,
    );
    expect(scenarios.map((s) => s.key)).toEqual(["pairwise/table-stakes/bakery"]);
    expect(scenarios[0].variants?.map((v) => v.name)).toEqual(["a-left", "b-left"]);
    expect(scenarios[0].prompt).toContain("Brief for table-stakes/bakery");
    expect(scenarios[0].prompt).not.toContain("./site/");
  });

  it("maps left/right verdicts back to A/B and tracks order consistency", () => {
    const dir = path.join(root, "pw");
    const verdict = (key: string, winners: Record<string, string>) =>
      write(
        path.join(dir, "scenarios", key, "judge", "artifacts", "verdict.json"),
        JSON.stringify(Object.fromEntries(Object.entries(winners).map(([d, w]) => [d, { winner: w, reason: "" }]))),
      );
    // A on the left wins typography; with sides swapped, A (now right) wins again → consistent.
    // Spacing: left wins both times → position bias, one win each, inconsistent.
    verdict("pairwise/s@a-left", { typography: "left", spacing: "left", color: "tie" });
    verdict("pairwise/s@b-left", { typography: "right", spacing: "left", color: "tie" });
    const manifest = {
      reportId: "pw",
      results: ["pairwise/s@a-left", "pairwise/s@b-left", "pairwise/t@a-left"].map((scenarioKey) => ({
        scenarioKey,
        agentName: "judge",
      })),
    } as unknown as ReportManifest;

    const summary = summarizePairwise(manifest, dir);
    expect(summary.dimensions.typography).toEqual({ a: 2, b: 0, tie: 0, consistent: 1, pairs: 1 });
    expect(summary.dimensions.spacing).toEqual({ a: 1, b: 1, tie: 0, consistent: 0, pairs: 1 });
    expect(winRate(summary.dimensions.color)).toBe(0.5);
    expect(summary.missing).toEqual(["pairwise/t@a-left"]);
  });
});

describe("calibration", () => {
  it("computes accuracy, precision, recall, and kappa for judge vs human", () => {
    const a = agreement([
      { judge: true, human: true },
      { judge: true, human: false },
      { judge: false, human: false },
      { judge: false, human: false },
    ]);
    expect(a).toMatchObject({ n: 4, accuracy: 0.75, precision: 0.5, recall: 1 });
    expect(a.kappa).toBeCloseTo(0.5);
  });

  it("round-trips a template: copies sites, hides judge verdicts, scores filled labels", () => {
    makeReport("r1", [
      [
        "s",
        "a",
        [
          { check: "[content:recall] PRESENT: name", score: 10 },
          { check: "[content:precision] AUDIT facts", score: 5, rationale: "supported=1 placeholder=0 unsupported=1" },
        ],
      ],
    ]);
    fs.mkdirSync(path.join(root, "golden"));
    const golden: GoldenFile = buildTemplate("r1", undefined, root);
    expect(golden.labels).toHaveLength(2);
    expect(JSON.stringify(golden)).not.toContain('"score"');
    expect(fs.existsSync(path.join(root, "golden", golden.labels[0].site, "index.html"))).toBe(true);

    golden.labels[0].human = false;
    golden.labels[1].human = { supported: 3, unsupported: 1 };
    const c = scoreGolden(golden, root);
    expect(c.binary.content).toMatchObject({ n: 1, accuracy: 0 });
    expect(c.audits.content.mae).toBeCloseTo(0.25);
  });
});
