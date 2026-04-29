import { describe, it, expect } from "vitest";
import {
  parseDeepEvalResponse,
  parseCategoryEvalResponse,
  mergeCategoryResults,
  buildDefaultCategoryResult,
  computeHeuristicSpeed,
} from "../../../src/scoring/deep-eval.js";
import type { CategoryEvalResult, Interaction, InteractionCategory, SparseIndex } from "../../../src/types/scoring.js";

// Default audit scores from category-score.ts
const DEFAULTS = { success: 1.0, speed: 1.0, weight: 1.0, contextRelevance: 1.0 };

function makeSparseIndex(
  interactions: Array<{
    id: number;
    categories: InteractionCategory[];
    hasError?: boolean;
    contextBytes?: number;
    durationMs?: number | null;
  }>,
): SparseIndex {
  return {
    lines: interactions.map((i) => `#${i.id} [${i.categories.join(",")}] sparse line`),
    interactions: interactions.map((i) => ({
      id: i.id,
      entryIndices: [0],
      categories: i.categories,
      sparseLine: `#${i.id} [${i.categories.join(",")}] sparse line`,
      toolName: null,
      hasError: i.hasError ?? false,
      durationMs: i.durationMs ?? null,
      startMs: null,
      contextBytes: i.contextBytes ?? 100,
    })),
    stats: {
      totalInteractions: interactions.length,
      byCategory: interactions.reduce(
        (acc, i) => {
          for (const cat of i.categories) {
            acc[cat]++;
          }
          return acc;
        },
        { environment: 0, service: 0, agent: 0 } as Record<InteractionCategory, number>,
      ),
      totalErrors: interactions.filter((i) => i.hasError).length,
      totalDurationMs: 1000,
      wallClockMs: 1000,
    },
  };
}

function makeInteraction(overrides: Partial<Interaction> & { categories: InteractionCategory[] }): Interaction {
  return {
    id: 1,
    entryIndices: [0],
    sparseLine: "",
    toolName: null,
    hasError: false,
    durationMs: null,
    startMs: null,
    contextBytes: 100,
    ...overrides,
  };
}

describe("parseDeepEvalResponse", () => {
  describe("valid responses", () => {
    it("parses LLM audits for all interactions", () => {
      const sparseIndex = makeSparseIndex([
        { id: 1, categories: ["environment"] },
        { id: 2, categories: ["service"] },
        { id: 3, categories: ["agent"] },
      ]);

      const response = JSON.stringify({
        audits: [
          { id: 1, success: 0.9, weight: 0.6, contextRelevance: 0.5, rationale: "Good but slow" },
          { id: 2, success: 0.7, weight: 0.8, contextRelevance: 0.9, rationale: "Service worked" },
          { id: 3, success: 1.0, weight: 0.95, contextRelevance: 0.85, rationale: "Efficient" },
        ],
        necessity: [
          { category: "environment", score: 0.85, unnecessaryIds: [], rationale: "All needed" },
          { category: "service", score: 0.7, unnecessaryIds: [2], rationale: "One extra call" },
          { category: "agent", score: 0.95, unnecessaryIds: [], rationale: "Efficient" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // All interactions get LLM values; speed is placeholder for heuristic
      expect(result.audits[0].id).toBe(1);
      expect(result.audits[0].success).toBe(0.9);
      expect(result.audits[0].weight).toBe(0.6);
      expect(result.audits[0].contextRelevance).toBe(0.5);
      expect(result.audits[0].speed).toBe(DEFAULTS.speed); // placeholder — overridden by heuristic in runDeepEval
      expect(result.audits[0].rationale).toBe("Good but slow");

      expect(result.audits[1].id).toBe(2);
      expect(result.audits[1].success).toBe(0.7);
      expect(result.audits[1].weight).toBe(0.8);
      expect(result.audits[1].contextRelevance).toBe(0.9);
      expect(result.audits[1].rationale).toBe("Service worked");

      expect(result.audits[2].id).toBe(3);
      expect(result.audits[2].success).toBe(1.0);
      expect(result.audits[2].weight).toBe(0.95);
      expect(result.audits[2].contextRelevance).toBe(0.85);
      expect(result.audits[2].rationale).toBe("Efficient");

      expect(result.necessity).toHaveLength(3);
      expect(result.necessity[0].category).toBe("environment");
      expect(result.necessity[0].score).toBe(0.85);
      expect(result.necessity[1].category).toBe("service");
      expect(result.necessity[1].unnecessaryIds).toEqual([2]);
      expect(result.necessity[2].category).toBe("agent");
    });

    it("fills defaults for interactions the LLM missed", () => {
      const sparseIndex = makeSparseIndex([
        { id: 1, categories: ["environment"] },
        { id: 2, categories: ["service"] },
        { id: 3, categories: ["agent"] },
      ]);

      const response = JSON.stringify({
        audits: [{ id: 1, success: 0.9, weight: 0.6, contextRelevance: 0.5, rationale: "Audited" }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // #1 from LLM
      expect(result.audits[0].success).toBe(0.9);
      expect(result.audits[0].rationale).toBe("Audited");

      // #2 and #3 not in LLM response — get defaults
      expect(result.audits[1]).toEqual({
        id: 2,
        categories: ["service"],
        success: DEFAULTS.success,
        speed: DEFAULTS.speed,
        weight: DEFAULTS.weight,
        contextRelevance: DEFAULTS.contextRelevance,
        rationale: "default",
      });

      expect(result.audits[2]).toEqual({
        id: 3,
        categories: ["agent"],
        success: DEFAULTS.success,
        speed: DEFAULTS.speed,
        weight: DEFAULTS.weight,
        contextRelevance: DEFAULTS.contextRelevance,
        rationale: "default",
      });
    });
  });

  describe("invalid/empty responses", () => {
    it("returns all defaults for invalid JSON", () => {
      const sparseIndex = makeSparseIndex([
        { id: 1, categories: ["environment"] },
        { id: 2, categories: ["service"] },
      ]);

      const result = parseDeepEvalResponse("not valid json at all", sparseIndex);

      // All interactions get default audits
      expect(result.audits).toHaveLength(2);
      expect(result.audits[0]).toEqual({
        id: 1,
        categories: ["environment"],
        success: DEFAULTS.success,
        speed: DEFAULTS.speed,
        weight: DEFAULTS.weight,
        contextRelevance: DEFAULTS.contextRelevance,
        rationale: "default",
      });

      // All three categories get default necessity
      expect(result.necessity).toHaveLength(3);
      for (const n of result.necessity) {
        expect(n.score).toBe(1.0);
        expect(n.unnecessaryIds).toEqual([]);
        expect(n.rationale).toBe("default");
      }
    });

    it("returns all defaults for empty string", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"] }]);

      const result = parseDeepEvalResponse("", sparseIndex);

      expect(result.audits).toHaveLength(1);
      expect(result.audits[0].success).toBe(DEFAULTS.success);
      expect(result.necessity).toHaveLength(3);
    });
  });

  describe("audit score clamping", () => {
    it("clamps scores greater than 1 to 1", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: 5.0, weight: 999, contextRelevance: 1.01 }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(1);
      expect(result.audits[0].weight).toBe(1);
      expect(result.audits[0].contextRelevance).toBe(1);
    });

    it("clamps negative scores to 0", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["service"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: -0.5, weight: -100, contextRelevance: -0.01 }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(0);
      expect(result.audits[0].weight).toBe(0);
      expect(result.audits[0].contextRelevance).toBe(0);
    });

    it("defaults NaN scores to 0.5", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: NaN, weight: NaN, contextRelevance: NaN }],
        necessity: [],
      });

      // NaN in JSON becomes null, which is not a finite number
      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(0.5);
      expect(result.audits[0].weight).toBe(0.5);
      expect(result.audits[0].contextRelevance).toBe(0.5);
    });

    it("defaults string score values to 0.5", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: "high", weight: "good", contextRelevance: "" }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(0.5);
      expect(result.audits[0].weight).toBe(0.5);
      expect(result.audits[0].contextRelevance).toBe(0.5);
    });

    it("defaults null score values to 0.5", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: null, weight: null, contextRelevance: null }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(0.5);
      expect(result.audits[0].weight).toBe(0.5);
      expect(result.audits[0].contextRelevance).toBe(0.5);
    });
  });

  describe("audit for nonexistent interaction ID", () => {
    it("skips audits with IDs not in the sparse index", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [
          { id: 999, success: 0.9, weight: 0.7, contextRelevance: 0.6, rationale: "Nonexistent" },
          { id: 1, success: 0.5, weight: 0.5, contextRelevance: 0.5, rationale: "Valid" },
        ],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // Only interaction #1 should appear (no #999)
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0].id).toBe(1);
      expect(result.audits[0].success).toBe(0.5);
    });
  });

  describe("hasError default behavior", () => {
    it("interaction with hasError=true gets success=0.3 when LLM misses it", () => {
      const sparseIndex = makeSparseIndex([
        { id: 1, categories: ["environment"], hasError: true },
        { id: 2, categories: ["service"], hasError: false },
      ]);

      // No audits from LLM — both get defaults
      const response = JSON.stringify({ audits: [], necessity: [] });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // Error interaction: success defaults to 0.3
      expect(result.audits[0].id).toBe(1);
      expect(result.audits[0].success).toBe(0.3);
      expect(result.audits[0].speed).toBe(DEFAULTS.speed);
      expect(result.audits[0].weight).toBe(DEFAULTS.weight);
      expect(result.audits[0].contextRelevance).toBe(DEFAULTS.contextRelevance);

      // Non-error interaction: success defaults to 1.0
      expect(result.audits[1].id).toBe(2);
      expect(result.audits[1].success).toBe(DEFAULTS.success);
    });

    it("LLM audit overrides hasError default", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"], hasError: true }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: 0.7, weight: 0.6, contextRelevance: 0.5, rationale: "Error but recovered" }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // LLM value overrides the hasError default
      expect(result.audits[0].success).toBe(0.7);
      expect(result.audits[0].weight).toBe(0.6);
      expect(result.audits[0].contextRelevance).toBe(0.5);
      expect(result.audits[0].rationale).toBe("Error but recovered");
    });
  });

  describe("necessity parsing", () => {
    it("fills missing categories with default necessity", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [],
        necessity: [{ category: "environment", score: 0.9, unnecessaryIds: [], rationale: "Fine" }],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      expect(result.necessity).toHaveLength(3);
      expect(result.necessity[0]).toEqual({
        category: "environment",
        score: 0.9,
        unnecessaryIds: [],
        rationale: "Fine",
      });
      expect(result.necessity[1]).toEqual({
        category: "service",
        score: 1.0,
        unnecessaryIds: [],
        rationale: "default",
      });
      expect(result.necessity[2]).toEqual({
        category: "agent",
        score: 1.0,
        unnecessaryIds: [],
        rationale: "default",
      });
    });

    it("always returns all three categories in order", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [
          { category: "agent", score: 0.5, unnecessaryIds: [], rationale: "Agent note" },
          { category: "service", score: 0.6, unnecessaryIds: [], rationale: "Service note" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      expect(result.necessity).toHaveLength(3);
      expect(result.necessity[0].category).toBe("environment");
      expect(result.necessity[0].score).toBe(1.0); // default
      expect(result.necessity[1].category).toBe("service");
      expect(result.necessity[1].score).toBe(0.6);
      expect(result.necessity[2].category).toBe("agent");
      expect(result.necessity[2].score).toBe(0.5);
    });

    it("skips invalid category names in necessity", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [
          { category: "invalid_category", score: 0.5, unnecessaryIds: [], rationale: "Bad" },
          { category: "environment", score: 0.9, unnecessaryIds: [], rationale: "Good" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      // Only environment should be from LLM; others default
      expect(result.necessity[0].category).toBe("environment");
      expect(result.necessity[0].score).toBe(0.9);
      expect(result.necessity[1].category).toBe("service");
      expect(result.necessity[1].score).toBe(1.0); // default
    });

    it("filters non-number unnecessaryIds", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [
          { category: "environment", score: 0.7, unnecessaryIds: [1, "two", 3, null, true], rationale: "Mixed" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.necessity[0].unnecessaryIds).toEqual([1, 3]);
    });

    it("defaults unnecessaryIds to empty array when not an array", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [{ category: "service", score: 0.5, unnecessaryIds: "not-array", rationale: "Bad format" }],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.necessity[1].category).toBe("service");
      expect(result.necessity[1].unnecessaryIds).toEqual([]);
    });

    it("clamps necessity score to [0, 1]", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [
          { category: "environment", score: 2.5, unnecessaryIds: [], rationale: "Over" },
          { category: "service", score: -0.3, unnecessaryIds: [], rationale: "Under" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.necessity[0].score).toBe(1);
      expect(result.necessity[1].score).toBe(0);
    });

    it("returns default necessity for all categories when necessity is not an array", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: "not-an-array",
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.necessity).toHaveLength(3);
      for (const n of result.necessity) {
        expect(n.score).toBe(1.0);
        expect(n.rationale).toBe("default");
      }
    });
  });

  describe("audit entry validation", () => {
    it("skips audit entries missing id", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [
          { success: 0.9, weight: 0.7, contextRelevance: 0.6, rationale: "No ID" },
          { id: 1, success: 0.5, weight: 0.5, contextRelevance: 0.5, rationale: "Has ID" },
        ],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0].success).toBe(0.5);
    });

    it("skips null and primitive entries in audits array", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"] }]);
      const response = JSON.stringify({
        audits: [null, 42, "string", { id: 1, success: 0.6, weight: 0.6, contextRelevance: 0.6 }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0].id).toBe(1);
      expect(result.audits[0].success).toBe(0.6);
    });

    it("defaults rationale to empty string when not a string", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: 0.9, weight: 0.7, contextRelevance: 0.6, rationale: 42 }],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].rationale).toBe("");
    });

    it("returns empty audits array when audits is not an array", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["service"] }]);
      const response = JSON.stringify({
        audits: "not-an-array",
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      // Interaction #1 still gets default audit
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0].rationale).toBe("default");
    });

    it("uses categories from sparse index, not from LLM response", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [
          {
            id: 1,
            category: "agent", // LLM says "agent" but sparse index says "environment"
            success: 0.9,
            weight: 0.7,
            contextRelevance: 0.6,
            rationale: "Mismatched category",
          },
        ],
        necessity: [],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].categories).toEqual(["environment"]);
    });
  });

  describe("patterns parsing", () => {
    it("parses valid patterns from LLM response", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
      const response = JSON.stringify({
        audits: [{ id: 1, success: 0.9, weight: 0.7, contextRelevance: 0.6, rationale: "OK" }],
        necessity: [],
        patterns: [
          { description: "Redundant file reads", interactionIds: [1], severity: "medium" },
          { description: "Retried after failure", interactionIds: [1], severity: "high" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns).toHaveLength(2);
      expect(result.patterns[0].description).toBe("Redundant file reads");
      expect(result.patterns[0].severity).toBe("medium");
      expect(result.patterns[1].severity).toBe("high");
    });

    it("returns empty patterns when field is missing", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"] }]);
      const response = JSON.stringify({ audits: [], necessity: [] });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns).toEqual([]);
    });

    it("returns empty patterns when field is not an array", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({ audits: [], necessity: [], patterns: "not-array" });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns).toEqual([]);
    });

    it("skips pattern entries without description", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [],
        patterns: [
          { interactionIds: [1], severity: "low" },
          { description: "Valid pattern", interactionIds: [2], severity: "high" },
        ],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0].description).toBe("Valid pattern");
    });

    it("defaults severity to medium for invalid values", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [],
        patterns: [{ description: "A pattern", interactionIds: [], severity: "critical" }],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns[0].severity).toBe("medium");
    });

    it("filters non-number interactionIds in patterns", () => {
      const sparseIndex = makeSparseIndex([]);
      const response = JSON.stringify({
        audits: [],
        necessity: [],
        patterns: [{ description: "Mixed IDs", interactionIds: [1, "two", 3, null], severity: "low" }],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.patterns[0].interactionIds).toEqual([1, 3]);
    });

    it("returns empty patterns for invalid JSON", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["agent"] }]);
      const result = parseDeepEvalResponse("not valid json", sparseIndex);
      expect(result.patterns).toEqual([]);
    });
  });

  describe("JSON wrapped in markdown", () => {
    it("parses response wrapped in markdown fences", () => {
      const sparseIndex = makeSparseIndex([{ id: 1, categories: ["service"] }]);
      const response = `Here is my evaluation:
\`\`\`json
{
  "audits": [{"id": 1, "success": 0.75, "weight": 0.8, "contextRelevance": 0.9, "rationale": "OK"}],
  "necessity": [{"category": "service", "score": 0.8, "unnecessaryIds": [], "rationale": "Needed"}]
}
\`\`\``;

      const result = parseDeepEvalResponse(response, sparseIndex);
      expect(result.audits[0].success).toBe(0.75);
      expect(result.necessity.find((n) => n.category === "service")?.score).toBe(0.8);
    });
  });

  describe("multiple interactions end to end", () => {
    it("handles mix of audited and missed interactions with errors", () => {
      const sparseIndex = makeSparseIndex([
        { id: 1, categories: ["environment"], hasError: false },
        { id: 2, categories: ["environment"], hasError: true },
        { id: 3, categories: ["service"], hasError: false },
        { id: 4, categories: ["agent"], hasError: false },
        { id: 5, categories: ["agent"], hasError: true },
      ]);

      const response = JSON.stringify({
        audits: [
          { id: 1, success: 0.9, weight: 0.6, contextRelevance: 0.5, rationale: "Audited env" },
          { id: 3, success: 0.4, weight: 0.2, contextRelevance: 0.1, rationale: "Audited service" },
          { id: 5, success: 0.2, weight: 0.3, contextRelevance: 0.1, rationale: "Failed agent step" },
        ],
        necessity: [{ category: "environment", score: 0.9, unnecessaryIds: [], rationale: "Env note" }],
      });

      const result = parseDeepEvalResponse(response, sparseIndex);

      expect(result.audits).toHaveLength(5);

      // #1: LLM-audited
      expect(result.audits[0].success).toBe(0.9);
      expect(result.audits[0].weight).toBe(0.6);
      expect(result.audits[0].contextRelevance).toBe(0.5);
      expect(result.audits[0].rationale).toBe("Audited env");

      // #2: LLM missed (error interaction) — defaults
      expect(result.audits[1].success).toBe(0.3);
      expect(result.audits[1].rationale).toBe("default");

      // #3: LLM-audited
      expect(result.audits[2].success).toBe(0.4);
      expect(result.audits[2].weight).toBe(0.2);
      expect(result.audits[2].rationale).toBe("Audited service");

      // #4: LLM missed (no error) — defaults
      expect(result.audits[3].success).toBe(DEFAULTS.success);
      expect(result.audits[3].weight).toBe(DEFAULTS.weight);

      // #5: LLM-audited (error but LLM scored it)
      expect(result.audits[4].success).toBe(0.2);
      expect(result.audits[4].rationale).toBe("Failed agent step");

      // Necessity: environment from LLM, others default
      expect(result.necessity[0].score).toBe(0.9);
      expect(result.necessity[1].score).toBe(1.0); // default service
      expect(result.necessity[2].score).toBe(1.0); // default agent
    });
  });
});

describe("computeHeuristicSpeed", () => {
  describe("no timing data", () => {
    it("returns 1.0 when durationMs is null", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: null }))).toBe(1.0);
    });

    it("returns 1.0 when durationMs is 0", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 0 }))).toBe(1.0);
    });

    it("returns 1.0 when durationMs is negative", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["agent"], durationMs: -100 }))).toBe(1.0);
    });
  });

  describe("environment interactions", () => {
    it("scores 1.0 for near-instant operations (<= 500ms)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 200 }))).toBe(1.0);
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 500 }))).toBe(1.0);
    });

    it("scores 0.9 for moderate operations (500ms-2s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 1500 }))).toBe(0.9);
    });

    it("scores 0.8 for slow operations (2-5s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 3000 }))).toBe(0.8);
    });

    it("scores 0.6 for very slow operations (5-10s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 8000 }))).toBe(0.6);
    });

    it("scores 0.4 for extremely slow operations (> 10s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["environment"], durationMs: 15000 }))).toBe(0.4);
    });
  });

  describe("service interactions", () => {
    it("scores 1.0 for fast calls (<= 2s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["service"], durationMs: 1500 }))).toBe(1.0);
    });

    it("scores 0.9 for moderate calls (2-5s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["service"], durationMs: 4000 }))).toBe(0.9);
    });

    it("scores 0.8 for slow calls (5-10s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["service"], durationMs: 8000 }))).toBe(0.8);
    });

    it("scores 0.4 for extremely slow calls (> 25s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["service"], durationMs: 30000 }))).toBe(0.4);
    });
  });

  describe("agent interactions", () => {
    it("scores 1.0 for quick thinking (<= 2s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["agent"], durationMs: 1500 }))).toBe(1.0);
    });

    it("scores 0.9 for moderate thinking (2-5s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["agent"], durationMs: 4000 }))).toBe(0.9);
    });

    it("scores 0.8 for extended thinking (5-15s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["agent"], durationMs: 10000 }))).toBe(0.8);
    });

    it("scores 0.4 for very long thinking (> 30s)", () => {
      expect(computeHeuristicSpeed(makeInteraction({ categories: ["agent"], durationMs: 45000 }))).toBe(0.4);
    });
  });

  describe("multi-category interactions", () => {
    it("uses service thresholds when service is one of the categories", () => {
      // Service gets checked first and has more generous thresholds
      const interaction = makeInteraction({ categories: ["service", "environment"], durationMs: 4000 });
      expect(computeHeuristicSpeed(interaction)).toBe(0.9); // service threshold: 2-5s = 0.9
    });

    it("uses environment thresholds when environment but not service", () => {
      const interaction = makeInteraction({ categories: ["environment", "agent"], durationMs: 4000 });
      expect(computeHeuristicSpeed(interaction)).toBe(0.8); // environment threshold: 2-5s = 0.8
    });
  });
});

describe("parseCategoryEvalResponse", () => {
  it("parses a valid per-category response", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["environment"] },
      { id: 2, categories: ["environment"] },
      { id: 3, categories: ["agent"] },
    ]);

    const response = JSON.stringify({
      audits: [
        { id: 1, success: 0.9, weight: 0.8, contextRelevance: 0.7, rationale: "Good write" },
        { id: 2, success: 0.5, weight: 0.6, contextRelevance: 0.4, rationale: "Failed read" },
      ],
      necessity: { score: 0.85, unnecessaryIds: [], rationale: "All needed" },
      patterns: [{ description: "Redundant reads", interactionIds: [2], severity: "low" }],
    });

    const result = parseCategoryEvalResponse(response, "environment", sparseIndex);

    expect(result.category).toBe("environment");
    expect(result.audits).toHaveLength(2); // Only environment interactions
    expect(result.audits[0].id).toBe(1);
    expect(result.audits[0].success).toBe(0.9);
    expect(result.audits[1].id).toBe(2);
    expect(result.audits[1].success).toBe(0.5);
    expect(result.necessity.category).toBe("environment");
    expect(result.necessity.score).toBe(0.85);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].description).toBe("Redundant reads");
  });

  it("fills defaults for interactions missed by the LLM", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["service"] },
      { id: 2, categories: ["service"] },
    ]);

    const response = JSON.stringify({
      audits: [{ id: 1, success: 0.8, weight: 0.7, contextRelevance: 0.9, rationale: "OK" }],
      necessity: { score: 0.9, unnecessaryIds: [], rationale: "Fine" },
    });

    const result = parseCategoryEvalResponse(response, "service", sparseIndex);

    expect(result.audits).toHaveLength(2);
    expect(result.audits[0].id).toBe(1);
    expect(result.audits[0].success).toBe(0.8);
    // #2 missed — gets defaults
    expect(result.audits[1].id).toBe(2);
    expect(result.audits[1].success).toBe(DEFAULTS.success);
    expect(result.audits[1].rationale).toBe("default");
  });

  it("returns defaults for invalid JSON", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["agent"] },
      { id: 2, categories: ["agent"], hasError: true },
    ]);

    const result = parseCategoryEvalResponse("not json", "agent", sparseIndex);

    expect(result.category).toBe("agent");
    expect(result.audits).toHaveLength(2);
    expect(result.audits[0].success).toBe(DEFAULTS.success);
    expect(result.audits[1].success).toBe(0.3); // hasError default
    expect(result.necessity.category).toBe("agent");
    expect(result.necessity.score).toBe(0.8); // default
    expect(result.patterns).toEqual([]);
  });

  it("ignores audits for interactions not in this category", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["environment"] },
      { id: 2, categories: ["service"] },
    ]);

    const response = JSON.stringify({
      audits: [
        { id: 1, success: 0.9, weight: 0.8, contextRelevance: 0.7, rationale: "Env" },
        { id: 2, success: 0.5, weight: 0.5, contextRelevance: 0.5, rationale: "Service" },
      ],
      necessity: { score: 0.8, unnecessaryIds: [], rationale: "OK" },
    });

    // Parse as environment — should only include interaction #1
    const result = parseCategoryEvalResponse(response, "environment", sparseIndex);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].id).toBe(1);
  });

  it("handles necessity as a single object (not array)", () => {
    const sparseIndex = makeSparseIndex([{ id: 1, categories: ["environment"] }]);
    const response = JSON.stringify({
      audits: [],
      necessity: { score: 0.7, unnecessaryIds: [1], rationale: "One was unnecessary" },
    });

    const result = parseCategoryEvalResponse(response, "environment", sparseIndex);
    expect(result.necessity.score).toBe(0.7);
    expect(result.necessity.unnecessaryIds).toEqual([1]);
    expect(result.necessity.category).toBe("environment");
  });

  it("defaults necessity when it's not an object", () => {
    const sparseIndex = makeSparseIndex([{ id: 1, categories: ["service"] }]);
    const response = JSON.stringify({ audits: [], necessity: "not-an-object" });

    const result = parseCategoryEvalResponse(response, "service", sparseIndex);
    expect(result.necessity.score).toBe(1.0);
    expect(result.necessity.category).toBe("service");
    expect(result.necessity.rationale).toBe("default");
  });
});

describe("mergeCategoryResults", () => {
  it("merges audits from all categories", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["environment"] },
      { id: 2, categories: ["service"] },
      { id: 3, categories: ["agent"] },
    ]);

    const envResult: CategoryEvalResult = {
      category: "environment",
      audits: [{ id: 1, categories: ["environment"], success: 0.9, speed: 1.0, weight: 0.8, contextRelevance: 0.7, rationale: "env" }],
      necessity: { category: "environment", score: 0.85, unnecessaryIds: [], rationale: "env" },
      patterns: [],
    };

    const svcResult: CategoryEvalResult = {
      category: "service",
      audits: [{ id: 2, categories: ["service"], success: 0.7, speed: 1.0, weight: 0.6, contextRelevance: 0.5, rationale: "svc" }],
      necessity: { category: "service", score: 0.9, unnecessaryIds: [], rationale: "svc" },
      patterns: [{ description: "API pattern", interactionIds: [2], severity: "medium" }],
    };

    const agentResult: CategoryEvalResult = {
      category: "agent",
      audits: [{ id: 3, categories: ["agent"], success: 1.0, speed: 1.0, weight: 0.95, contextRelevance: 0.85, rationale: "agent" }],
      necessity: { category: "agent", score: 0.95, unnecessaryIds: [], rationale: "agent" },
      patterns: [],
    };

    const result = mergeCategoryResults([envResult, svcResult, agentResult], sparseIndex);

    expect(result.audits).toHaveLength(3);
    expect(result.audits[0].id).toBe(1);
    expect(result.audits[0].success).toBe(0.9);
    expect(result.audits[1].id).toBe(2);
    expect(result.audits[1].success).toBe(0.7);
    expect(result.audits[2].id).toBe(3);
    expect(result.audits[2].success).toBe(1.0);

    expect(result.necessity).toHaveLength(3);
    expect(result.necessity[0].category).toBe("environment");
    expect(result.necessity[1].category).toBe("service");
    expect(result.necessity[2].category).toBe("agent");

    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].description).toBe("API pattern");
  });

  it("fills defaults for interactions not covered by any category", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["environment"] },
      { id: 2, categories: ["service"] },
    ]);

    // Only environment result provided — service interaction #2 should get default
    const envResult: CategoryEvalResult = {
      category: "environment",
      audits: [{ id: 1, categories: ["environment"], success: 0.9, speed: 1.0, weight: 0.8, contextRelevance: 0.7, rationale: "env" }],
      necessity: { category: "environment", score: 0.85, unnecessaryIds: [], rationale: "env" },
      patterns: [],
    };

    const svcResult = buildDefaultCategoryResult("service");

    const result = mergeCategoryResults([envResult, svcResult], sparseIndex);

    expect(result.audits).toHaveLength(2);
    expect(result.audits[0].success).toBe(0.9); // from env
    expect(result.audits[1].success).toBe(DEFAULTS.success); // default for #2
    expect(result.audits[1].rationale).toBe("default");
  });

  it("handles multi-category interactions with first-write-wins", () => {
    const sparseIndex = makeSparseIndex([
      { id: 1, categories: ["service", "environment"] },
    ]);

    const envResult: CategoryEvalResult = {
      category: "environment",
      audits: [{ id: 1, categories: ["service", "environment"], success: 0.5, speed: 1.0, weight: 0.5, contextRelevance: 0.5, rationale: "env view" }],
      necessity: { category: "environment", score: 0.8, unnecessaryIds: [], rationale: "env" },
      patterns: [],
    };

    const svcResult: CategoryEvalResult = {
      category: "service",
      audits: [{ id: 1, categories: ["service", "environment"], success: 0.9, speed: 1.0, weight: 0.9, contextRelevance: 0.9, rationale: "svc view" }],
      necessity: { category: "service", score: 0.9, unnecessaryIds: [], rationale: "svc" },
      patterns: [],
    };

    // environment comes first in the array → first-write-wins
    const result = mergeCategoryResults([envResult, svcResult], sparseIndex);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].success).toBe(0.5); // env view wins
    expect(result.audits[0].rationale).toBe("env view");
  });
});

describe("buildDefaultCategoryResult", () => {
  it("returns defaults for a category with no interactions", () => {
    const result = buildDefaultCategoryResult("environment");

    expect(result.category).toBe("environment");
    expect(result.audits).toHaveLength(0);
    expect(result.necessity.category).toBe("environment");
    expect(result.necessity.score).toBe(0.8);
    expect(result.patterns).toEqual([]);
  });

  it("returns defaults for a category with interactions", () => {
    const interactions = [
      makeInteraction({ id: 1, categories: ["agent"], hasError: false }),
      makeInteraction({ id: 2, categories: ["agent"], hasError: true }),
    ];

    const result = buildDefaultCategoryResult("agent", interactions);

    expect(result.audits).toHaveLength(2);
    expect(result.audits[0].success).toBe(DEFAULTS.success);
    expect(result.audits[1].success).toBe(0.3); // hasError
  });
});
