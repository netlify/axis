import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setBaseline,
  readBaseline,
  listBaselines,
  deleteBaseline,
  validateBaselineName,
} from "../../../src/baselines/store.js";
import type { ReportManifest } from "../../../src/types/report.js";
import type { CategoryScore } from "../../../src/types/scoring.js";

function mockCategoryScore(score: number): CategoryScore {
  return {
    score,
    interactionCount: 5,
    auditedCount: 2,
    dimensions: { success: score, speed: score, weight: score, relevance: score, necessity: score },
    audits: [],
    necessity: { category: "environment", score: score / 100, unnecessaryIds: [], rationale: "test" },
  };
}

function makeReport(overrides: Partial<ReportManifest> = {}): ReportManifest {
  return {
    version: "1",
    reportId: "2026-04-15-200000",
    timestamp: "2026-04-15T20:00:00.000Z",
    durationMs: 5000,
    summary: { total: 1, completed: 1, failed: 0, averageAxisScore: 85 },
    results: [
      {
        scenarioKey: "hello-world",
        scenarioName: "Hello World",
        agentName: "claude-code",
        durationMs: 5000,
        exitCode: 0,
        tokenUsage: { input: 1000, output: 500, cacheCreationInput: 0, cacheReadInput: 200 },
        score: {
          axisScore: 85,
          goalAchievement: { score: 80, criteria: [] },
          environment: mockCategoryScore(90),
          service: mockCategoryScore(95),
          agent: mockCategoryScore(100),
          weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
        },
        file: "scenarios/hello-world/claude-code.json",
      },
    ],
    ...overrides,
  };
}

describe("baselines/store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axis-baseline-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("validateBaselineName", () => {
    it("accepts valid names", () => {
      expect(() => validateBaselineName("main")).not.toThrow();
      expect(() => validateBaselineName("my-baseline")).not.toThrow();
      expect(() => validateBaselineName("test_v2")).not.toThrow();
      expect(() => validateBaselineName("A123")).not.toThrow();
    });

    it("rejects empty names", () => {
      expect(() => validateBaselineName("")).toThrow(/Invalid baseline name/);
    });

    it("rejects names with spaces", () => {
      expect(() => validateBaselineName("my baseline")).toThrow(/Invalid baseline name/);
    });

    it("rejects names with slashes", () => {
      expect(() => validateBaselineName("foo/bar")).toThrow(/Invalid baseline name/);
    });

    it("rejects names that are too long", () => {
      expect(() => validateBaselineName("a".repeat(65))).toThrow(/Invalid baseline name/);
    });

    it("accepts names at max length", () => {
      expect(() => validateBaselineName("a".repeat(64))).not.toThrow();
    });
  });

  describe("setBaseline", () => {
    it("creates a new baseline from a scored report", () => {
      const report = makeReport();
      const baseline = setBaseline(tmpDir, report, "main");

      expect(baseline.name).toBe("main");
      expect(baseline.results["hello-world"]["claude-code"]).toMatchObject({
        axisScore: 85,
        goalAchievement: 80,
        environment: 90,
        service: 95,
        agent: 100,
        durationMs: 5000,
        tokens: 1700,
        fromReportId: "2026-04-15-200000",
      });
    });

    it("persists baseline to disk", () => {
      setBaseline(tmpDir, makeReport(), "main");
      const filePath = path.join(tmpDir, ".axis", "baselines", "main.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data.name).toBe("main");
    });

    it("merges new scenarios into existing baseline", () => {
      setBaseline(tmpDir, makeReport(), "main");

      const report2 = makeReport({
        reportId: "2026-04-15-210000",
        results: [
          {
            scenarioKey: "cms/create-post",
            scenarioName: "Create Post",
            agentName: "claude-code",
            durationMs: 8000,
            exitCode: 0,
            score: {
              axisScore: 70,
              goalAchievement: { score: 60, criteria: [] },
              environment: mockCategoryScore(80),
              service: mockCategoryScore(75),
              agent: mockCategoryScore(90),
              weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
            },
            file: "scenarios/cms/create-post/claude-code.json",
          },
        ],
      });

      const baseline = setBaseline(tmpDir, report2, "main");

      // Original scenario preserved
      expect(baseline.results["hello-world"]["claude-code"].axisScore).toBe(85);
      // New scenario added
      expect(baseline.results["cms/create-post"]["claude-code"].axisScore).toBe(70);
    });

    it("updates existing scenario entries on re-run", () => {
      setBaseline(tmpDir, makeReport(), "main");

      const report2 = makeReport({
        reportId: "2026-04-15-210000",
        results: [
          {
            scenarioKey: "hello-world",
            scenarioName: "Hello World",
            agentName: "claude-code",
            durationMs: 3000,
            exitCode: 0,
            score: {
              axisScore: 92,
              goalAchievement: { score: 90, criteria: [] },
              environment: mockCategoryScore(95),
              service: mockCategoryScore(98),
              agent: mockCategoryScore(100),
              weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
            },
            file: "scenarios/hello-world/claude-code.json",
          },
        ],
      });

      const baseline = setBaseline(tmpDir, report2, "main");
      expect(baseline.results["hello-world"]["claude-code"].axisScore).toBe(92);
      expect(baseline.results["hello-world"]["claude-code"].fromReportId).toBe("2026-04-15-210000");
    });

    it("skips unscored results", () => {
      const report = makeReport({
        results: [
          {
            scenarioKey: "hello-world",
            scenarioName: "Hello World",
            agentName: "claude-code",
            durationMs: 5000,
            exitCode: 0,
            // No score field
            file: "scenarios/hello-world/claude-code.json",
          },
        ],
      });

      const baseline = setBaseline(tmpDir, report, "main");
      expect(Object.keys(baseline.results)).toHaveLength(0);
    });

    it("skips failed results", () => {
      const report = makeReport({
        results: [
          {
            scenarioKey: "hello-world",
            scenarioName: "Hello World",
            agentName: "claude-code",
            durationMs: 5000,
            exitCode: 1,
            error: "Agent timed out",
            score: {
              axisScore: 0,
              goalAchievement: { score: 0, criteria: [] },
              environment: mockCategoryScore(0),
              service: mockCategoryScore(0),
              agent: mockCategoryScore(0),
              weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
            },
            file: "scenarios/hello-world/claude-code.json",
          },
        ],
      });

      const baseline = setBaseline(tmpDir, report, "main");
      expect(Object.keys(baseline.results)).toHaveLength(0);
    });

    it("includes cache read tokens in total", () => {
      const report = makeReport({
        results: [
          {
            scenarioKey: "hello-world",
            scenarioName: "Hello World",
            agentName: "claude-code",
            durationMs: 5000,
            exitCode: 0,
            tokenUsage: { input: 1000, output: 500, cacheCreationInput: 0, cacheReadInput: 300 },
            score: {
              axisScore: 85,
              goalAchievement: { score: 80, criteria: [] },
              environment: mockCategoryScore(90),
              service: mockCategoryScore(95),
              agent: mockCategoryScore(100),
              weights: { goal_achievement: 0.4, environment: 0.2, service: 0.2, agent: 0.2 },
            },
            file: "scenarios/hello-world/claude-code.json",
          },
        ],
      });

      const baseline = setBaseline(tmpDir, report, "main");
      expect(baseline.results["hello-world"]["claude-code"].tokens).toBe(1800); // 1000 + 500 + 300
    });
  });

  describe("readBaseline", () => {
    it("returns null for non-existent baseline", () => {
      expect(readBaseline(tmpDir, "nonexistent")).toBeNull();
    });

    it("reads an existing baseline", () => {
      setBaseline(tmpDir, makeReport(), "main");
      const baseline = readBaseline(tmpDir, "main");

      expect(baseline).not.toBeNull();
      expect(baseline!.name).toBe("main");
      expect(baseline!.results["hello-world"]["claude-code"].axisScore).toBe(85);
    });
  });

  describe("listBaselines", () => {
    it("returns empty array when no baselines exist", () => {
      expect(listBaselines(tmpDir)).toEqual([]);
    });

    it("returns baselines sorted by updatedAt descending", async () => {
      setBaseline(tmpDir, makeReport(), "alpha");

      // Ensure different updatedAt timestamps
      await new Promise((r) => setTimeout(r, 10));
      setBaseline(tmpDir, makeReport(), "beta");

      const baselines = listBaselines(tmpDir);
      expect(baselines).toHaveLength(2);
      expect(baselines[0].name).toBe("beta");
      expect(baselines[1].name).toBe("alpha");
    });
  });

  describe("deleteBaseline", () => {
    it("returns false for non-existent baseline", () => {
      expect(deleteBaseline(tmpDir, "nonexistent")).toBe(false);
    });

    it("deletes an existing baseline and returns true", () => {
      setBaseline(tmpDir, makeReport(), "main");
      expect(deleteBaseline(tmpDir, "main")).toBe(true);
      expect(readBaseline(tmpDir, "main")).toBeNull();
    });
  });

  describe("default baseline name", () => {
    it("setBaseline uses 'default' when name is omitted", () => {
      const baseline = setBaseline(tmpDir, makeReport());
      expect(baseline.name).toBe("default");
      const filePath = path.join(tmpDir, ".axis", "baselines", "default.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("readBaseline defaults to 'default' when name is omitted", () => {
      setBaseline(tmpDir, makeReport());
      const baseline = readBaseline(tmpDir);
      expect(baseline).not.toBeNull();
      expect(baseline!.name).toBe("default");
    });

    it("deleteBaseline defaults to 'default' when name is omitted", () => {
      setBaseline(tmpDir, makeReport());
      expect(deleteBaseline(tmpDir)).toBe(true);
      expect(readBaseline(tmpDir)).toBeNull();
    });
  });
});
