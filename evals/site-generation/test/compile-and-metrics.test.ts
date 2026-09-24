import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { loadConfig, discoverScenarios } from "../../../src/config/loader.js";
import type { ReportManifest } from "../../../src/types/index.js";
import { TAG_RE, compileSpec, loadLibrary, type Spec } from "../lib/compile.js";
import { f1, rate, summarize, tallyCriterion } from "../lib/metrics.js";

const CONFIG_PATH = path.resolve(import.meta.dirname, "../axis.config.ts");

describe("site-generation specs", () => {
  it("compile into valid AXIS scenarios with tagged, unweighted checks", async () => {
    const { config, configDir } = await loadConfig(CONFIG_PATH);
    const scenarios = await discoverScenarios(configDir, config.scenarios);

    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      const judge = scenario.judge as { check: string; weight: number }[];
      expect(judge.every((c) => TAG_RE.test(c.check))).toBe(true);
      // Equal weights: every item counts once.
      expect(new Set(judge.map((c) => c.weight)).size).toBe(1);
    }
  });

  it("rejects unknown fields, site types, audits, and verticals", () => {
    const lib = loadLibrary();
    const base: Spec = { name: "x", prompt: "p", rubric: {} };
    expect(() => compileSpec({ ...base, weight: 1 } as unknown as Spec, "k", lib)).toThrow(/unknown field "weight"/);
    expect(() => compileSpec({ ...base, site_type: "castle" }, "k", lib)).toThrow(/unknown site_type/);
    expect(() => compileSpec({ ...base, rubric: { precision: ["nope"] } }, "k", lib)).toThrow(
      /unknown precision audit/,
    );
    expect(() => compileSpec({ ...base, rubric: { pass: { vibes: ["ok"] } } } as unknown as Spec, "k", lib)).toThrow(
      /unknown vertical "vibes"/,
    );
  });

  it("appends picker selections and the output contract to the prompt", () => {
    const scenario = compileSpec(
      { name: "x", prompt: ["one.", "two."], picker: [{ question: "Style", answer: "Bold" }], rubric: {} },
      "k",
      loadLibrary(),
    );
    expect(scenario.prompt).toMatch(/^one\. two\.\n\nOptions selected:\n- Style: Bold\n/);
    expect(scenario.prompt).toContain("`./site/`");
  });
});

describe("site-generation metrics", () => {
  const grade = (check: string, score: number, rationale = "") => ({ check, weight: 1, score, rationale });

  it("counts recall and pass checks as met at score ≥ 5", () => {
    expect(tallyCriterion(grade("[content:recall] x", 7))?.tally).toEqual({ hits: 1, total: 1, estimated: 0 });
    expect(tallyCriterion(grade("[mobile:pass] x", 4))?.tally).toEqual({ hits: 0, total: 1, estimated: 0 });
    expect(tallyCriterion(grade("untagged check", 10))).toBeNull();
  });

  it("reads precision counts from the rationale, excluding placeholders", () => {
    const parsed = tallyCriterion(
      grade("[content:precision] AUDIT", 8, "supported=6 placeholder=3 unsupported=2. Invented: phone, reviews"),
    );
    expect(parsed).toEqual({ vertical: "content", metric: "precision", tally: { hits: 6, total: 8, estimated: 0 } });
  });

  it("falls back to score/10 when an audit has no counts, and flags it", () => {
    expect(tallyCriterion(grade("[content:precision] AUDIT", 7, "Mostly fine"))?.tally).toEqual({
      hits: 0.7,
      total: 1,
      estimated: 1,
    });
  });

  it("pools counts per agent and vertical, and computes F1", () => {
    const run = (agentName: string, criteria: ReturnType<typeof grade>[]) => ({
      scenarioKey: "s",
      scenarioName: "s",
      agentName,
      durationMs: 0,
      exitCode: 0,
      file: "",
      score: { goalAchievement: { score: 0, criteria } },
    });
    const manifest = {
      reportId: "r",
      results: [
        run("a", [
          grade("[content:recall] x", 10),
          grade("[content:recall] y", 0),
          grade("[content:precision] AUDIT", 5, "supported=3 placeholder=0 unsupported=1"),
        ]),
        run("a", [grade("[content:recall] z", 10)]),
        { ...run("b", []), score: undefined },
      ],
    } as unknown as ReportManifest;

    const summary = summarize(manifest, "agent");
    const content = summary.groups.a.content;
    expect(content.recall).toEqual({ hits: 2, total: 3, estimated: 0 });
    expect(rate(content.precision)).toBe(0.75);
    expect(f1(content)).toBeCloseTo((2 * 0.75 * (2 / 3)) / (0.75 + 2 / 3));
    expect(summary.unscored).toEqual({ b: 1 });
  });

  it("treats an audit with nothing to label as precision 1", () => {
    expect(rate({ hits: 0, total: 0, estimated: 0 })).toBe(1);
  });
});
